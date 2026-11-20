// SPDX-License-Identifier: GPL-3.0-or-later
// Applications + their desktop actions ("New Private Window") + open windows.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {best, completion, prepare} from '../core/fuzzy.js';
import {launchContext} from '../core/util.js';

const HINTS_APP = [['↩', 'Open'], ['⌃↩', 'New Window']];

export class AppsProvider {
    constructor(ctx) {
        this.id = 'apps';
        this.sync = true;
        this.modes = ['apps'];
        this._ctx = ctx;
        this._sys = Shell.AppSystem.get_default();
        this._usage = Shell.AppUsage.get_default();
        this._index = null;
        this._rank = null;
        this._sys.connectObject('installed-changed', () => {
            this._index = null;
        }, this);
    }

    open() {
        this._rank = null; // usage ranks refresh once per open
    }

    _build() {
        const index = [];
        for (const info of this._sys.get_installed()) {
            try {
                if (!info.should_show())
                    continue;
                const id = info.get_id();
                const app = this._sys.lookup_app(id);
                if (!app)
                    continue;
                const exec = info.get_executable?.() ?? '';
                const rec = {
                    id, app, info,
                    name: prepare(app.get_name()),
                    generic: info.get_generic_name?.() ? prepare(info.get_generic_name()) : null,
                    keywords: (info.get_keywords?.() ?? []).length ? prepare(info.get_keywords().join(' ')) : null,
                    exec: exec ? prepare(GLib.path_get_basename(exec)) : null,
                    idp: prepare(id.replace(/\.desktop$/, '').split('.').pop()),
                    actions: (info.list_actions?.() ?? []).map(a => ({a, name: info.get_action_name(a), p: prepare(info.get_action_name(a))})),
                };
                index.push(rec);
            } catch (e) {
                console.warn(`[lucent-launcher] app index: ${e.message}`);
            }
        }
        return index;
    }

    _ranks() {
        if (!this._rank) {
            this._rank = new Map();
            this._usage.get_most_used().forEach((app, i) => this._rank.set(app.get_id(), i));
        }
        return this._rank;
    }

    _result(rec, score) {
        const {app, id} = rec;
        const running = app.get_state() === Shell.AppState.RUNNING;
        const n = running ? app.get_n_windows() : 0;
        return {
            id: `app:${id}`,
            section: 'apps',
            title: app.get_name(),
            subtitle: running ? (n > 1 ? `Running · ${n} windows` : 'Running') : '',
            kind: 'Application',
            icon: {gicon: app.get_icon()},
            score,
            completion: app.get_name(),
            activate: () => app.activate(),
            secondary: () => app.open_new_window(-1),
            copy: () => ({text: app.get_name()}),
            preview: {type: 'app', app, info: rec.info},
            hints: HINTS_APP,
        };
    }

    search(q, _c, mode) {
        this._index ??= this._build();
        const out = [];
        if (!q.folded) {
            if (mode !== 'apps')
                return out;
            // browsing ⌃1: most used first, then A–Z
            const ranks = this._ranks();
            const list = [...this._index].sort((a, b) =>
                (ranks.get(a.id) ?? 1e6) - (ranks.get(b.id) ?? 1e6) || a.app.get_name().localeCompare(b.app.get_name()));
            for (const rec of list)
                out.push(this._result(rec, 500));
            return out;
        }
        if (q.kind || q.prefix)
            return out;
        const ranks = this._ranks();
        const f = q.folded;
        for (const rec of this._index) {
            let s = best(f, [[rec.name, 1], [rec.generic, 0.78], [rec.keywords, 0.72], [rec.exec, 0.8], [rec.idp, 0.75]]);
            if (s >= 380) {
                const r = ranks.get(rec.id);
                if (r !== undefined)
                    s += Math.max(0, 50 - r * 2);
                out.push(this._result(rec, s));
            }
            // desktop actions: "private" → Zen: New Private Window; "zen new" too
            if (f.length >= 3 && rec.actions.length) {
                for (const act of rec.actions) {
                    const as = Math.max(best(f, [[act.p, 0.85]]), best(f, [[prepare(`${rec.app.get_name()} ${act.name}`), 0.9]]));
                    if (as >= 600) {
                        out.push({
                            id: `appaction:${rec.id}:${act.a}`,
                            section: 'actions',
                            title: act.name,
                            subtitle: rec.app.get_name(),
                            kind: 'App Action',
                            icon: {gicon: rec.app.get_icon()},
                            score: as - 80,
                            activate: () => rec.info.launch_action(act.a, launchContext()),
                            preview: {type: 'generic', gicon: rec.app.get_icon(), title: act.name, lines: [[`${rec.app.get_name()} action`, '']]},
                        });
                    }
                }
            }
        }
        return out;
    }

    destroy() {
        this._sys.disconnectObject(this);
        this._index = null;
    }
}

export class WindowsProvider {
    constructor() {
        this.id = 'windows';
        this.sync = true;
        this.modes = ['apps'];
    }

    search(q, _c, mode) {
        const out = [];
        if (q.kind || q.prefix || (!q.folded && mode !== 'apps'))
            return out;
        if (!q.folded && mode === 'apps')
            return out; // browsing apps lists apps only
        const tracker = Shell.WindowTracker.get_default();
        const wins = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
        const f = q.folded;
        wins.forEach((w, i) => {
            if (w.is_skip_taskbar())
                return;
            const app = tracker.get_window_app(w);
            const title = w.get_title() ?? '';
            const appName = app?.get_name() ?? '';
            const s = best(f, [[prepare(title), 0.92], [prepare(appName), 0.7]]);
            if (s < 400)
                return;
            out.push({
                id: `win:${w.get_stable_sequence()}`,
                section: 'windows',
                title,
                subtitle: appName + (w.minimized ? ' · minimized' : ''),
                kind: 'Window',
                icon: {gicon: app?.get_icon() ?? null, name: 'focus-windows-symbolic'},
                score: s - i * 3 - 60,
                noLearn: true,
                activate: () => Main.activateWindow(w),
                secondary: () => w.delete(global.get_current_time()),
                preview: {type: 'window', win: w, app},
                hints: [['↩', 'Switch To'], ['⌃↩', 'Close Window']],
            });
        });
        return out;
    }

    destroy() {}
}

// Exposed for the ghost completion and quick keys
export function appById(id) {
    return Shell.AppSystem.get_default().lookup_app(id);
}

export {completion};
