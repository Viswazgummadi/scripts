// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal ninja build watcher (no wrapper around your commands).
//
//  - spots running `ninja` processes in /proc and reads their -C dir;
//  - total: a read-only dry run `ninja -C dir -n <targets>` when the build is first seen;
//  - done: lines ninja appends to <dir>/.ninja_log (one per finished step, written live);
//  - result: when the process is gone, dry-run again: "no work to do" = success.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decoder = new TextDecoder();
const OPTS_WITH_VALUE = new Set(['-C', '-f', '-j', '-k', '-l', '-d', '-w']);

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

// -> {dir, targets}, or null for tools (-t) / dry runs (-n).
export function parseCmdline(argv, cwd) {
    let dir = '.';
    const targets = [];
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-n' || a.startsWith('-t'))
            return null;
        if (OPTS_WITH_VALUE.has(a)) {
            if (a === '-C')
                dir = argv[i + 1] ?? '.';
            i++;
        } else if (a.startsWith('-C')) {
            dir = a.slice(2);
        } else if (!a.startsWith('-')) {
            targets.push(a);
        }
    }
    const abs = GLib.path_is_absolute(dir) ? dir : GLib.build_filenamev([cwd, dir]);
    return {dir: GLib.canonicalize_filename(abs, null), targets};
}

function findNinjas() {
    const found = [];
    let d;
    try {
        d = GLib.Dir.open('/proc', 0);
    } catch {
        return found;
    }
    for (let e = d.read_name(); e !== null; e = d.read_name()) {
        if (!/^\d+$/.test(e) || readText(`/proc/${e}/comm`)?.trim() !== 'ninja')
            continue;
        const raw = readText(`/proc/${e}/cmdline`);
        let cwd = null;
        try {
            cwd = GLib.file_read_link(`/proc/${e}/cwd`);
        } catch {}
        // The dry runs below must use this very binary: ninja is often installed per user
        // (~/.local/bin), which is not on the shell's own PATH.
        let exe = 'ninja';
        try {
            exe = GLib.file_read_link(`/proc/${e}/exe`);
        } catch {}
        const parsed = raw && cwd ? parseCmdline(raw.split('\0').filter(Boolean), cwd) : null;
        if (parsed)
            found.push({pid: Number(e), exe, ...parsed});
    }
    d.close();
    return found;
}

function logLines(dir) {
    const t = readText(GLib.build_filenamev([dir, '.ninja_log']));
    return t ? t.split('\n').filter(l => l && !l.startsWith('#')).length : 0;
}

// Resolves to the number of steps left (0 = up to date), or null on error.
function stepsLeft(exe, dir, targets, cancellable) {
    return new Promise(resolve => {
        let proc;
        try {
            const l = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            });
            l.setenv('NINJA_STATUS', '[%f/%t] ', true);
            proc = l.spawnv([exe, '-C', dir, '-n', ...targets]);
        } catch {
            resolve(null);
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) {
                    resolve(null);
                    return;
                }
                let total = 0;
                for (const m of out.matchAll(/^\[\d+\/(\d+)\]/gm))
                    total = Math.max(total, Number(m[1]));
                resolve(total);
            } catch {
                resolve(null);
            }
        });
    });
}

// onChange(builds) after every scan; onFinish(build, ok, seconds) when a build ends.
export class NinjaWatcher {
    constructor({onChange, onFinish, intervalSec = 2}) {
        this._onChange = onChange;
        this._onFinish = onFinish;
        this.builds = new Map(); // pid -> {name, exe, dir, targets, base, done, total, started}
        this._cancel = new Gio.Cancellable();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, intervalSec, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scan() {
        const procs = findNinjas();
        const alive = new Set(procs.map(p => p.pid));
        for (const p of procs) {
            if (this.builds.has(p.pid) || [...this.builds.values()].some(b => b.dir === p.dir))
                continue;
            const b = {
                ...p, name: GLib.path_get_basename(p.dir),
                base: logLines(p.dir), done: 0, total: null, started: Date.now(),
            };
            this.builds.set(p.pid, b);
            stepsLeft(b.exe, b.dir, b.targets, this._cancel).then(n => {
                if (n !== null)
                    b.total = n + b.done;
            });
        }
        for (const [pid, b] of this.builds) {
            b.done = Math.max(0, logLines(b.dir) - b.base);
            if (alive.has(pid))
                continue;
            this.builds.delete(pid);
            const seconds = (Date.now() - b.started) / 1000;
            stepsLeft(b.exe, b.dir, b.targets, this._cancel).then(n => {
                if (!this._cancel.is_cancelled())
                    this._onFinish?.(b, n === 0, seconds);
            });
        }
        this._onChange?.([...this.builds.values()]);
    }

    destroy() {
        this._cancel.cancel();
        GLib.source_remove(this._timer);
        this.builds.clear();
        this._onChange = this._onFinish = null;
    }
}

export function percent(b) {
    return b.total ? Math.min(99, Math.floor(100 * b.done / b.total)) : null;
}

export function fmtDuration(sec) {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${s}s` : `${s}s`;
}
