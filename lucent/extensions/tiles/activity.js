// SPDX-License-Identifier: GPL-3.0-or-later
// "What am I doing right now": gathers live activities from a few cheap sources.
// Each activity is {id, kind, priority, icon, text}; the block shows the most important one.
//
//   build     ninja builds (ninja.js): "llvm 42%", then "llvm done" / "llvm failed" for a moment
//   download  browser downloads (Zen/Firefox ".part", Chrome ".crdownload") growing in ~/Downloads
//   tool      long-running commands: cmake configure, dnf, flatpak, scp/rsync, git clone/pull, lit, tar/unzip
//   media     the current player (MPRIS), playing or paused, lowest priority
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MprisWatcher} from './mpris.js';
import {NinjaWatcher, percent, fmtDuration} from './ninja.js';

const decoder = new TextDecoder();
const FLASH_MS = 5000;   // how long "done" / "failed" / "downloaded" stays
const TOOL_MIN_AGE = 3;  // seconds a command must run before it counts (no flicker)
const PART_SUFFIXES = ['.part', '.crdownload', '.download'];

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

function shorten(s, max = 30) {
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function fmtBytes(n) {
    if (n < 1e6)
        return `${Math.max(0, Math.round(n / 1e3))} KB`;
    if (n < 1e9)
        return `${Math.round(n / 1e6)} MB`;
    return `${(n / 1e9).toFixed(1)} GB`;
}

// ---- downloads ---------------------------------------------------------------------------
class Downloads {
    constructor(dir = null) {
        this._dir = dir ?? GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        this._seen = new Map(); // part name -> {final, size, prevSize, prevAt, lastGrow}
        this.flashes = [];
    }

    scan(now) {
        const parts = new Map();
        let d;
        try {
            d = GLib.Dir.open(this._dir, 0);
        } catch {
            return [];
        }
        for (let e = d.read_name(); e !== null; e = d.read_name()) {
            const suffix = PART_SUFFIXES.find(s => e.endsWith(s));
            if (suffix)
                parts.set(e, e.slice(0, -suffix.length));
        }
        d.close();

        const out = [];
        for (const [part, final] of parts) {
            const size = fileSize(GLib.build_filenamev([this._dir, part]));
            if (size === null)
                continue;
            let s = this._seen.get(part);
            if (!s) {
                s = {final, size, prevSize: size, prevAt: now, lastGrow: now, rate: 0};
                this._seen.set(part, s);
            }
            const dt = (now - s.prevAt) / 1000;
            if (dt >= 1.5) {
                const rate = Math.max(0, (size - s.prevSize) / dt);
                s.rate = s.rate ? 0.6 * s.rate + 0.4 * rate : rate;
                if (size > s.prevSize)
                    s.lastGrow = now;
                s.prevSize = size;
                s.prevAt = now;
            }
            s.size = size;
            if (now - s.lastGrow > 15000)
                continue; // stalled / paused: don't claim we're downloading
            out.push({
                id: `dl:${part}`, kind: 'download', priority: 80, icon: 'folder-download-symbolic',
                text: `${shorten(final, 26)} · ${fmtBytes(size)}${s.rate > 0 ? ` · ${fmtBytes(s.rate)}/s` : ''}`,
            });
        }
        // finished (or cancelled) downloads
        for (const [part, s] of this._seen) {
            if (parts.has(part))
                continue;
            this._seen.delete(part);
            const finalSize = fileSize(GLib.build_filenamev([this._dir, s.final]));
            if (finalSize)
                this.flashes.push({until: now + FLASH_MS, item: {
                    id: `dl-done:${part}`, kind: 'download', priority: 85, icon: 'folder-download-symbolic',
                    text: `${shorten(s.final, 30)} downloaded`,
                }});
        }
        return out;
    }
}

function fileSize(path) {
    try {
        return Gio.File.new_for_path(path).query_info('standard::size', 0, null).get_size();
    } catch {
        return null;
    }
}

// ---- long-running tools ------------------------------------------------------------------
function hostArg(argv) {
    const a = argv.slice(1).find(x => /^[^-/][^/]*:/.test(x) && !x.startsWith('-'));
    return a ? a.split(':')[0].split('@').pop() : null;
}

const TOOLS = [
    {comm: ['cmake'], label: (argv, cwd) => (argv.includes('--build') || argv.includes('-E') ? null
        : `cmake configure · ${GLib.path_get_basename(argvValue(argv, '-B') ?? cwd)}`), icon: 'system-run-symbolic', priority: 70},
    {comm: ['dnf', 'dnf5'], label: argv => `dnf ${argv[1] ?? ''}`.trim(), icon: 'software-update-available-symbolic', priority: 65},
    {comm: ['flatpak'], label: argv => (['install', 'update', 'upgrade', 'uninstall'].includes(argv[1]) ? `flatpak ${argv[1]}` : null),
        icon: 'software-update-available-symbolic', priority: 65},
    {comm: ['scp', 'rsync', 'sftp'], label: argv => `${GLib.path_get_basename(argv[0])} → ${hostArg(argv) ?? 'remote'}`,
        icon: 'network-transmit-symbolic', priority: 75},
    {comm: ['git'], label: argv => (['clone', 'fetch', 'pull', 'push'].includes(argv[1]) ? `git ${argv[1]}` : null),
        icon: 'network-transmit-receive-symbolic', priority: 60},
    {comm: ['lit', 'llvm-lit', 'python3', 'python'], label: argv => (argv.slice(0, 2).some(a => /(^|\/)(llvm-)?lit(\.py)?$/.test(a))
        ? 'lit tests' : null), icon: 'system-run-symbolic', priority: 72},
    {comm: ['tar', 'unzip', '7z', '7za', 'unrar'], label: argv => `${GLib.path_get_basename(argv[0])} ${shorten(
        GLib.path_get_basename(argv.slice(1).filter(a => !a.startsWith('-')).pop() ?? ''), 24)}`.trim(),
    icon: 'package-x-generic-symbolic', priority: 55},
];

function argvValue(argv, flag) {
    const i = argv.indexOf(flag);
    if (i >= 0)
        return argv[i + 1] ?? null;
    const joined = argv.find(a => a.startsWith(flag) && a.length > flag.length);
    return joined ? joined.slice(flag.length) : null;
}

function scanTools() {
    const byComm = new Map();
    for (const t of TOOLS) {
        for (const c of t.comm)
            byComm.set(c, t);
    }
    const uptime = parseFloat(readText('/proc/uptime') ?? '0');
    const out = [];
    const seenLabels = new Set();
    let d;
    try {
        d = GLib.Dir.open('/proc', 0);
    } catch {
        return out;
    }
    for (let e = d.read_name(); e !== null; e = d.read_name()) {
        if (!/^\d+$/.test(e))
            continue;
        const tool = byComm.get(readText(`/proc/${e}/comm`)?.trim());
        if (!tool)
            continue;
        const stat = readText(`/proc/${e}/stat`) ?? '';
        const age = uptime - Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) / 100;
        if (!(age >= TOOL_MIN_AGE))
            continue;
        const argv = (readText(`/proc/${e}/cmdline`) ?? '').split('\0').filter(Boolean);
        let cwd = '.';
        try {
            cwd = GLib.file_read_link(`/proc/${e}/cwd`);
        } catch {}
        const label = argv.length ? tool.label(argv, cwd) : null;
        if (!label || seenLabels.has(label))
            continue;
        seenLabels.add(label);
        out.push({id: `tool:${label}`, kind: 'tool', priority: tool.priority, icon: tool.icon, text: label});
    }
    d.close();
    return out;
}

// ---- everything together -----------------------------------------------------------------
export class ActivityWatcher {
    // onChange(list sorted by priority), onBuildFinished(build, ok, seconds)
    constructor({onChange, onBuildFinished, intervalSec = 2, downloadDir = null}) {
        this._onChange = onChange;
        this._onBuildFinished = onBuildFinished;
        this._flashes = [];
        this._builds = [];
        this._downloads = new Downloads(downloadDir);
        this._ninja = new NinjaWatcher({
            intervalSec,
            onChange: builds => (this._builds = builds),
            onFinish: (b, ok, sec) => {
                this._flashes.push({until: Date.now() + FLASH_MS, item: {
                    id: `build-done:${b.dir}`, kind: 'build', priority: 100, icon: ok ? 'system-run-symbolic' : 'dialog-error-symbolic',
                    text: `${b.name} ${ok ? 'done' : 'failed'} · ${fmtDuration(sec)}`, failed: !ok,
                }});
                this._onBuildFinished?.(b, ok, sec);
                this._emit();
            },
        });
        this._scanned = [];
        // player changes show up at once (no waiting for the next scan)
        this.mpris = new MprisWatcher(() => this._emit(false));
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, intervalSec, () => {
            // most players never announce their position: re-read it, so the player is always
            // in sync (one tiny D-Bus call every 2 s, only while something plays)
            const cur = this.mpris?.current;
            if (cur?.status === 'Playing')
                this.mpris.syncPosition(cur);
            this._emit(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Everything except media (for the popover's Activity section).
    get others() {
        return this._last?.filter(a => a.kind !== 'media') ?? [];
    }

    _emit(scan = true) {
        const now = Date.now();
        if (scan) {
            const found = [];
            for (const b of this._builds) {
                const p = percent(b);
                found.push({id: `build:${b.dir}`, kind: 'build', priority: 100, icon: 'system-run-symbolic',
                    text: `${b.name} ${p === null ? '…' : `${p}%`}`});
            }
            found.push(...this._downloads.scan(now));
            this._flashes.push(...this._downloads.flashes.splice(0));
            found.push(...scanTools());
            this._scanned = found;
        }
        const list = [...this._scanned];
        const m = this.mpris?.current;
        if (m) {
            const paused = m.status !== 'Playing';
            list.push({id: `media:${m.name}`, kind: 'media', priority: 10, paused,
                icon: paused ? 'media-playback-pause-symbolic' : 'audio-x-generic-symbolic',
                // same text playing or paused; the icon and dimming tell the state
                text: shorten([m.title, m.artists.join(', ')].filter(Boolean).join(' · '), 140)});
        }
        this._flashes = this._flashes.filter(f => f.until > now);
        list.push(...this._flashes.map(f => f.item));
        list.sort((a, b) => b.priority - a.priority);
        this._last = list;
        this._onChange?.(list);
    }

    destroy() {
        GLib.source_remove(this._timer);
        this._ninja.destroy();
        this.mpris.destroy();
        this.mpris = null;
        this._onChange = this._onBuildFinished = null;
    }
}
