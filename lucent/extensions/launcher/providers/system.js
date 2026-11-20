// SPDX-License-Identifier: GPL-3.0-or-later
// Actions: GNOME's own system actions (lock, suspend, restart, power off, log out, screenshot),
// quick toggles (dark mode, night light, do not disturb, Wi-Fi, Bluetooth, airplane mode, mute),
// "volume 40", empty trash, and timers ("timer 5m tea", "remind me in 10 min to stretch", "pomodoro").
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {best, prepare} from '../core/fuzzy.js';
import {capture, spawn} from '../core/util.js';

const RFKILL = ['org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill', 'org.gnome.SettingsDaemon.Rfkill'];

function rfkillGet(prop) {
    return new Promise(resolve => {
        Gio.DBus.session.call(RFKILL[0], RFKILL[1], 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [RFKILL[2], prop]), null, Gio.DBusCallFlags.NONE, 1500, null, (c, res) => {
                try {
                    resolve(c.call_finish(res).deepUnpack()[0].deepUnpack());
                } catch {
                    resolve(null);
                }
            });
    });
}

function rfkillSet(prop, value) {
    Gio.DBus.session.call(RFKILL[0], RFKILL[1], 'org.freedesktop.DBus.Properties', 'Set',
        new GLib.Variant('(ssv)', [RFKILL[2], prop, new GLib.Variant('b', value)]), null, Gio.DBusCallFlags.NONE, 3000, null, (c, res) => {
            try {
                c.call_finish(res);
            } catch (e) {
                Main.notifyError('Lucent Launcher', e.message);
            }
        });
}

// one timer list for the whole session (survives closing the panel)
const timers = new Map();
let timerSeq = 0;

function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (h)
        return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${m}:${String(r).padStart(2, '0')}`;
}

function startTimer(seconds, label) {
    const id = ++timerSeq;
    const ends = Date.now() + seconds * 1000;
    const src = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(seconds)), () => {
        timers.delete(id);
        Main.notify(label ? `⏰ ${label}` : '⏰ Timer done', `${fmtDur(seconds)} timer finished`);
        try {
            global.display.get_sound_player().play_from_theme('complete', 'Timer finished', null);
        } catch {
            // no sound theme
        }
        return GLib.SOURCE_REMOVE;
    });
    timers.set(id, {id, ends, seconds, label, src});
}

export function clearTimers() {
    for (const t of timers.values())
        GLib.source_remove(t.src);
    timers.clear();
}

function parseTimer(s) {
    s = s.trim().toLowerCase();
    if (/^pomodoro$/.test(s))
        return {seconds: 25 * 60, label: 'Pomodoro'};
    const unit = '(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?';
    const m = new RegExp(`^(?:timer|countdown|remind me in|alarm in|in)\\s+(\\d+(?:\\.\\d+)?)\\s*${unit}\\s*(?:to\\s+|for\\s+)?(.*)$`).exec(s) ??
        new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${unit}\\s+(?:timer|countdown)\\s*(?:for\\s+|to\\s+)?(.*)$`).exec(s);
    if (!m)
        return null;
    const n = Number(m[1]);
    const u = m[2] ?? 'm';
    const mult = u.startsWith('h') ? 3600 : (u === 's' || u.startsWith('sec')) ? 1 : 60;
    const seconds = n * mult;
    if (!(seconds > 0) || seconds > 7 * 86400)
        return null;
    return {seconds, label: m[3]?.trim() || null};
}

export class SystemProvider {
    constructor(ctx) {
        this.id = 'system';
        this.sync = true;
        this.modes = ['actions'];
        this._ctx = ctx;
        this._sys = SystemActions.getDefault();
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        try {
            this._color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        } catch {
            this._color = null;
        }
        this._state = {wifi: null, bt: null, airplane: null, muted: null, volume: null};

        const T = (key, name, keywords, icon, get, set) => ({key, name, kw: prepare(`${name} ${keywords}`), nameP: prepare(name), icon, get, set});
        this._toggles = [
            T('dark', 'Dark Mode', 'dark style theme night appearance light mode', 'weather-clear-night-symbolic',
                () => this._iface.get_string('color-scheme') === 'prefer-dark',
                on => this._iface.set_string('color-scheme', on ? 'prefer-dark' : 'default')),
            T('nightlight', 'Night Light', 'blue light warm screen colour color temperature', 'night-light-symbolic',
                () => this._color?.get_boolean('night-light-enabled') ?? null,
                on => this._color?.set_boolean('night-light-enabled', on)),
            T('dnd', 'Do Not Disturb', 'dnd focus notifications silence banners', 'notifications-disabled-symbolic',
                () => !this._notif.get_boolean('show-banners'),
                on => this._notif.set_boolean('show-banners', !on)),
            T('wifi', 'Wi-Fi', 'wifi wireless network internet wlan', 'network-wireless-symbolic',
                () => this._state.wifi,
                on => spawn(['nmcli', 'radio', 'wifi', on ? 'on' : 'off'])),
            T('bt', 'Bluetooth', 'bluetooth bt headphones', 'bluetooth-active-symbolic',
                () => (this._state.bt === null ? null : !this._state.bt),
                on => rfkillSet('BluetoothAirplaneMode', !on)),
            T('airplane', 'Airplane Mode', 'airplane flight mode radios offline', 'airplane-mode-symbolic',
                () => this._state.airplane,
                on => rfkillSet('AirplaneMode', on)),
            T('mute', 'Mute', 'mute sound audio speaker silence volume', 'audio-volume-muted-symbolic',
                () => this._state.muted,
                on => spawn(['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', on ? '1' : '0'])),
        ];
        this._extras = [
            {key: 'trash', name: 'Empty Trash', kw: prepare('empty trash bin delete clean'), icon: 'user-trash-full-symbolic',
                sub: 'Permanently delete everything in the Trash', run: () => spawn(['gio', 'trash', '--empty'])},
            {key: 'settings', name: 'Settings', kw: prepare('settings preferences control center system'), icon: 'org.gnome.Settings',
                sub: 'Open GNOME Settings', run: () => spawn(['gnome-control-center'])},
            {key: 'extensions', name: 'Extensions', kw: prepare('extensions gnome shell manage'), icon: 'org.gnome.Extensions',
                sub: 'Manage GNOME extensions', run: () => spawn(['gnome-extensions-app'])},
            {key: 'launchercfg', name: 'Launcher Settings', kw: prepare('launcher settings config preferences lucent'), icon: 'preferences-system-search-symbolic',
                sub: 'Shortcut, look, privacy and providers', run: () => this._ctx.openPreferences()},
        ];
    }

    // refresh slow-to-read states once per open, so results never wait on them
    open() {
        capture(['nmcli', '-t', 'radio', 'wifi']).then(o => {
            this._state.wifi = o.trim() === '' ? null : o.trim() === 'enabled';
        });
        rfkillGet('BluetoothAirplaneMode').then(v => {
            this._state.bt = v;
        });
        rfkillGet('AirplaneMode').then(v => {
            this._state.airplane = v;
        });
        capture(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@']).then(o => {
            const m = /Volume:\s*([\d.]+)/.exec(o);
            this._state.volume = m ? Math.round(Number(m[1]) * 100) : null;
            this._state.muted = m ? /MUTED/.test(o) : null;
        });
    }

    _toggleResult(t, s) {
        const on = t.get();
        const verb = on === null ? 'Toggle' : on ? 'Turn Off' : 'Turn On';
        return {
            id: `toggle:${t.key}`,
            section: 'actions',
            title: t.key === 'mute' ? (on ? 'Unmute' : 'Mute') : `${verb} ${t.name}`,
            subtitle: on === null ? t.name : `${t.name} is ${on ? 'on' : 'off'}`,
            kind: 'Action',
            icon: {name: t.icon},
            score: s,
            activate: () => {
                const now = t.get();
                t.set(now === null ? true : !now);
            },
            preview: {type: 'generic', iconName: t.icon, title: t.name, lines: [['Status', on === null ? 'Unknown' : on ? 'On' : 'Off']]},
            hints: [['↩', verb]],
        };
    }

    search(q, _c, mode) {
        const out = [];
        if (q.kind || (q.prefix && q.prefix !== '>'))
            return out;
        if (q.prefix === '>')
            return out;
        const f = q.folded;
        const browse = !f && mode === 'actions';

        // timers first: they are typed deliberately
        const tm = f ? parseTimer(q.raw) : null;
        if (tm) {
            out.push({
                id: 'timer:new', section: 'actions', noLearn: true,
                title: `Start ${fmtDur(tm.seconds)} Timer`, subtitle: tm.label ?? 'Notifies you when it ends',
                kind: 'Timer', icon: {name: 'alarm-symbolic'}, score: 2900,
                activate: () => startTimer(tm.seconds, tm.label),
                preview: {type: 'generic', iconName: 'org.gnome.clocks', title: `${fmtDur(tm.seconds)} timer`, lines: [['Label', tm.label ?? '—'], ['Ends at', new Date(Date.now() + tm.seconds * 1000).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})]]},
                hints: [['↩', 'Start']],
            });
        }
        if (browse || /^(timers?|countdown|alarm)/.test(f)) {
            for (const t of timers.values()) {
                const left = (t.ends - Date.now()) / 1000;
                out.push({
                    id: `timer:${t.id}`, section: 'actions', noLearn: true,
                    title: `${fmtDur(left)} left${t.label ? ` · ${t.label}` : ''}`, subtitle: `${fmtDur(t.seconds)} timer · ↩ cancels it`,
                    kind: 'Timer', icon: {name: 'alarm-symbolic'}, score: 2000,
                    activate: () => {
                        GLib.source_remove(t.src);
                        timers.delete(t.id);
                    },
                    hints: [['↩', 'Cancel Timer']],
                });
            }
        }

        // volume N
        const vm = /^(?:vol|volume|sound)\s+(\d{1,3})%?$/.exec(f);
        if (vm) {
            const v = Math.min(150, Number(vm[1]));
            out.push({
                id: 'volume:set', section: 'actions', noLearn: true,
                title: `Set Volume to ${v}%`, subtitle: this._state.volume !== null ? `Now ${this._state.volume}%` : 'Output volume',
                kind: 'Action', icon: {name: 'audio-volume-high-symbolic'}, score: 2900,
                activate: () => spawn(['wpctl', 'set-volume', '-l', '1.5', '@DEFAULT_AUDIO_SINK@', `${v}%`]),
                hints: [['↩', 'Set']],
            });
        }

        if (!f && !browse)
            return out;

        for (const t of this._toggles) {
            const s = browse ? 500 : best(f, [[t.nameP, 1], [t.kw, 0.85]]);
            if (s >= 560 || browse)
                out.push(this._toggleResult(t, s));
        }
        for (const x of this._extras) {
            const s = browse ? 480 : best(f, [[prepare(x.name), 1], [x.kw, 0.85]]);
            if (s >= 600 || browse) {
                out.push({
                    id: `sys:${x.key}`, section: 'actions', title: x.name, subtitle: x.sub, kind: 'Action',
                    icon: {name: x.icon}, score: s, activate: x.run, hints: [['↩', 'Run']],
                });
            }
        }
        const ids = browse ? [...this._sys._actions.keys()].filter(k => this._sys._actions.get(k).available) : this._sys.getMatchingActions(q.terms);
        for (const id of ids) {
            const name = this._sys.getName(id);
            const s = browse ? 470 : Math.max(700, best(f, [[prepare(name), 1]]));
            out.push({
                id: `sysaction:${id}`, section: 'actions', title: name, subtitle: 'System', kind: 'Action',
                icon: {name: this._sys.getIconName(id)}, score: s,
                activate: () => this._sys.activateAction(id),
                hints: [['↩', name]],
            });
        }
        return out;
    }

    destroy() {
        this._iface = this._notif = this._color = null;
    }
}
