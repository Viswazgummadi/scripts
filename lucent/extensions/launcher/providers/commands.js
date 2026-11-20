// SPDX-License-Identifier: GPL-3.0-or-later
// Commands: "> anything" runs it (↩ in a terminal, ⌃↩ silently with a notification when done),
// remembered commands, ssh hosts from ~/.ssh/config ("bhakti" → SSH to bhakti), Makefile targets
// of the configured projects ("make build" / "vishwa selftest"), and Quick Keys from the config.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {best, prepare} from '../core/fuzzy.js';
import {expandHome} from '../core/config.js';
import {openFile, openUri, runInBackground, runInTerminal, tildify} from '../core/util.js';

const HIST = GLib.build_filenamev([GLib.get_user_state_dir(), 'lucent-launcher', 'commands.json']);

function mtime(path) {
    try {
        return Gio.File.new_for_path(path).query_info('time::modified', 0, null).get_modification_date_time().to_unix();
    } catch {
        return -1;
    }
}

function readFile(path) {
    try {
        return new TextDecoder().decode(Gio.File.new_for_path(path).load_contents(null)[1]);
    } catch {
        return '';
    }
}

export class CommandsProvider {
    constructor(ctx) {
        this.id = 'commands';
        this.sync = true;
        this.modes = ['actions'];
        this._ctx = ctx;
        this._ssh = {at: -2, hosts: []};
        this._make = new Map();
        try {
            this._hist = JSON.parse(readFile(HIST) || '[]');
        } catch {
            this._hist = [];
        }
    }

    _remember(cmd) {
        this._hist = [cmd, ...this._hist.filter(c => c !== cmd)].slice(0, 40);
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(HIST), 0o700);
            Gio.File.new_for_path(HIST).replace_contents(new TextEncoder().encode(JSON.stringify(this._hist)), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch {
            // not fatal
        }
    }

    _term() {
        return this._ctx.config.v.terminal ?? null;
    }

    _cmdResult(cmd, {cwd = null, score = 900, title = null, subtitle = null, id = null, icon = 'utilities-terminal'} = {}) {
        return {
            id: id ?? `cmd:${cmd}`,
            section: 'commands',
            title: title ?? cmd,
            subtitle: subtitle ?? `Run in terminal${cwd ? ` · ${tildify(cwd)}` : ''}`,
            kind: 'Command',
            icon: {name: icon, fallback: 'utilities-terminal-symbolic'},
            score,
            activate: () => {
                this._remember(cmd);
                runInTerminal(cmd, {cwd, terminal: this._term()});
            },
            secondary: () => {
                this._remember(cmd);
                runInBackground(cmd, {cwd});
            },
            copy: () => ({text: cmd}),
            preview: {type: 'command', cmd, cwd: cwd ? tildify(cwd) : '~'},
            hints: [['↩', 'Run in Terminal'], ['⌃↩', 'Run in Background']],
        };
    }

    _sshHosts() {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.ssh', 'config']);
        const t = mtime(path);
        if (t !== this._ssh.at) {
            const hosts = [];
            let cur = null;
            for (const line of readFile(path).split('\n')) {
                const m = /^\s*(\w+)\s+(.+?)\s*$/.exec(line);
                if (!m)
                    continue;
                const k = m[1].toLowerCase();
                if (k === 'host') {
                    cur = null;
                    for (const h of m[2].split(/\s+/)) {
                        if (!/[*?!]/.test(h)) {
                            cur = {alias: h, hostname: '', user: ''};
                            hosts.push(cur);
                        }
                    }
                } else if (cur && k === 'hostname') {
                    cur.hostname = m[2];
                } else if (cur && k === 'user') {
                    cur.user = m[2];
                }
            }
            this._ssh = {at: t, hosts: hosts.filter(h => h.alias !== 'github.com')};
        }
        return this._ssh.hosts;
    }

    _targets(dir) {
        const mk = GLib.build_filenamev([dir, 'Makefile']);
        const t = mtime(mk);
        const c = this._make.get(dir);
        if (c && c.at === t)
            return c.targets;
        const targets = [];
        for (const m of readFile(mk).matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)/gm)) {
            if (!targets.includes(m[1]) && !m[1].startsWith('.'))
                targets.push(m[1]);
        }
        this._make.set(dir, {at: t, targets});
        return targets;
    }

    _quick(key, target) {
        const t = String(target);
        const base = {id: `quick:${key}`, section: 'quick', kind: 'Quick Key', score: 5000, subtitle: `Quick Key “${key}”`};
        if (t.startsWith('>'))
            return {...this._cmdResult(t.slice(1).trim()), ...base, title: t.slice(1).trim()};
        if (t.endsWith('.desktop')) {
            const app = Shell.AppSystem.get_default().lookup_app(t);
            if (app)
                return {...base, title: app.get_name(), icon: {gicon: app.get_icon()}, activate: () => app.activate(), preview: {type: 'app', app, info: app.get_app_info()}};
        }
        if (/^[a-z]+:\/\//i.test(t))
            return {...base, title: t, icon: {name: 'web-browser'}, activate: () => openUri(t), preview: {type: 'web', url: t, title: key}};
        const path = expandHome(t);
        return {...base, title: GLib.path_get_basename(path), subtitle: `${tildify(path)} · Quick Key “${key}”`,
            icon: {file: path}, activate: () => openFile(path), preview: {type: 'file', path, uri: Gio.File.new_for_path(path).get_uri(), name: GLib.path_get_basename(path)}};
    }

    search(q, _c, mode) {
        const out = [];
        const cfg = this._ctx.config.v;
        const raw = q.raw.trim();

        const qk = cfg.quickKeys ?? {};
        if (!q.prefix && Object.hasOwn(qk, raw))
            out.push(this._quick(raw, qk[raw]));

        if (q.prefix === '>') {
            const cmd = q.text;
            if (cmd)
                out.push(this._cmdResult(cmd, {score: 3000, id: 'cmd:typed'}));
            this._hist.filter(c => c !== cmd && (!cmd || c.includes(cmd))).slice(0, 6)
                .forEach((c, i) => out.push(this._cmdResult(c, {score: 800 - i, subtitle: 'Recent command'})));
            return out;
        }
        if (q.prefix || q.kind)
            return out;
        const f = q.folded;
        const browse = !f && mode === 'actions';
        if (!f && !browse)
            return out;

        for (const h of this._sshHosts()) {
            const s = browse ? 450 : best(f, [[prepare(h.alias), 1], [prepare(`ssh ${h.alias}`), 1]]);
            if (browse || (s >= 700 && f.length >= 3))
                out.push(this._cmdResult(`ssh ${h.alias}`, {score: s - 40, title: `SSH to ${h.alias}`, subtitle: [h.user, h.hostname].filter(Boolean).join('@') || 'Open a terminal on this machine', icon: 'network-server'}));
        }

        if (f.length >= 3 || browse) {
            for (const p of cfg.projects ?? []) {
                const dir = expandHome(p.dir);
                const targets = this._targets(dir);
                const pname = prepare(p.name);
                for (const tg of targets) {
                    const s = browse ? 400 : Math.max(best(f, [[prepare(`make ${tg}`), 1]]), best(f, [[prepare(`${p.name} ${tg}`), 0.95]]),
                        f.startsWith('make') ? 0 : best(f, [[prepare(tg), 0.7]]) * (best(f, [[pname, 1]]) ? 1 : 0.85));
                    if (browse || s >= 700)
                        out.push(this._cmdResult(`make ${tg}`, {cwd: dir, score: s - 60, subtitle: `${p.name} · run in terminal`, id: `make:${dir}:${tg}`}));
                }
            }
        }
        return out;
    }

    destroy() {
        this._make.clear();
    }
}
