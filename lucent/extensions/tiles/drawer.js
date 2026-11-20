// SPDX-License-Identifier: GPL-3.0-or-later
// Tray drawer: one "‹" tile; the tray icons (app indicators like Spotify) and the clipboard live
// behind it and slide out in the bar itself when you click it.
//
// Why in the bar and not a dropdown: every tray icon opens its own menu, and GNOME allows one
// menu at a time, so icons inside a dropdown would lose their anchor the moment you click one.
// Here the real icons are moved into a strip next to the arrow, so their menus work as before.
//
//   closed:  … [‹] [quick settings]
//   open:    … [ 🎵 📋 ⋯ ][›] [quick settings]   strip grows leftwards, icons mist in one by one
//
// Closes on a second click, or after `autoCloseSec` without the pointer on it and with no icon
// menu open. An icon asking for attention (SNI "NeedsAttention") puts a dot on the arrow and
// opens the drawer for a moment. Icons that appear later (an app started after login) are taken
// in automatically, and the drawer opens briefly so you see where they went. Disabling puts every
// icon back exactly where it was. State for debugging: ~/.cache/lucent-tiles/drawer.json
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {mist} from './dissolve.js';
import {Tile, timing} from './tile.js';

const POLL_MS = 1000;
const SETTLE_MS = 5000; // icons that exist when we start are not "new"
const STATE_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-tiles', 'drawer.json']);
const encoder = new TextEncoder();
const STAGGER_MS = 40;

function scaled(ms) {
    const s = St.Settings.get();
    if (s.reducedMotion === St.ReducedMotion.REDUCE)
        return 0;
    return s.slow_down_factor >= 0.5 ? Math.round(ms / s.slow_down_factor) : 0;
}

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

function globToRegex(g) {
    return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

// The strip that holds the icons: reports (natural width × reveal) and keeps the icon row at
// full size, right-aligned and clipped, so icons slide out from the arrow instead of squashing.
const Strip = GObject.registerClass(
class Strip extends St.Widget {
    _init() {
        super._init({style_class: 'lt-drawer-strip', clip_to_allocation: true, reactive: true, track_hover: true, visible: false});
        this.row = new St.BoxLayout({style_class: 'lt-drawer-row', y_expand: true});
        this.add_child(this.row);
        this.reveal = 0;
    }

    vfunc_get_preferred_width(forHeight) {
        const [, nat] = this.row.get_preferred_width(forHeight);
        const tn = this.get_theme_node();
        const w = tn.adjust_preferred_width(0, nat)[1] * this.reveal;
        return [0, w];
    }

    vfunc_get_preferred_height(forWidth) {
        const tn = this.get_theme_node();
        const [min, nat] = this.row.get_preferred_height(-1);
        return tn.adjust_preferred_height(min, nat);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const [, natW] = this.row.get_preferred_width(-1);
        const cb = new Clutter.ActorBox();
        cb.x2 = content.x2;
        cb.x1 = content.x2 - natW;
        cb.y1 = content.y1;
        cb.y2 = content.y2;
        this.row.allocate(cb);
    }
});

export const DrawerTile = GObject.registerClass(
class DrawerTile extends Tile {
    _init(getConfig) {
        super._init('Tray');
        this._getConfig = getConfig;
        this._box = new St.Widget({style_class: 'lt-block', layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._arrow = new St.Icon({icon_name: 'pan-start-symbolic', style_class: 'lt-drawer-icon'});
        this._arrow.set_pivot_point(0.5, 0.5);
        this._dot = new St.Widget({style_class: 'lt-dot', visible: false, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START});
        this._box.add_child(this._arrow);
        this._box.add_child(this._dot);
        this.add_child(this._box);

        this.strip = new Strip();
        // the strip lives in a panel box, which can go first when the shell tears the panel down
        this.strip.connect('destroy', () => (this._stripGone = true));
        this._items = new Map(); // container -> {role, indicator, parent, index, destroyId}
        this._open = false;
        this._busy = false;
        this._idleMs = 0;
        this._attention = new Set();
        this._startedAt = GLib.get_monotonic_time();
        this._stateKey = '';

        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => this.toggle());
        this.add_action(click);

        this._poll = GLib.timeout_add(GLib.PRIORITY_LOW, POLL_MS, () => {
            this._capture();
            this._watch();
            return GLib.SOURCE_CONTINUE;
        });
        // not named _onDestroy: that would replace PanelMenu.Button's, which destroys our container
        this.connect('destroy', () => this._teardown());
    }

    // Layout put the arrow somewhere: keep the strip right next to it (on its left).
    afterPlace() {
        const parent = this.container.get_parent();
        if (!parent)
            return;
        this.strip.get_parent()?.remove_child(this.strip);
        parent.insert_child_below(this.strip, this.container);
        this._capture();
    }

    _cfg() {
        const d = this._getConfig() ?? {};
        return {
            include: (d.include ?? ['appindicator-*', 'clipboardIndicator']).map(globToRegex),
            pinned: (d.pinned ?? []).map(globToRegex),
            autoCloseSec: Number(d.autoCloseSec ?? 6),
        };
    }

    // Move matching panel items into the strip.
    _capture() {
        if (!this.strip.get_parent())
            return;
        const cfg = this._cfg();
        for (const [role, ind] of Object.entries(Main.panel.statusArea)) {
            if (!ind?.container || role.startsWith('lucent-tiles-'))
                continue;
            const c = ind.container;
            const wanted = cfg.include.some(r => r.test(role)) && !cfg.pinned.some(r => r.test(role));
            const mine = this._items.has(c);
            if (wanted && c.get_parent() !== this.strip.row) {
                const parent = c.get_parent();
                const index = parent ? parent.get_children().indexOf(c) : -1;
                if (mine)
                    this._forget(c);
                parent?.remove_child(c);
                if (!this._open)
                    c.opacity = 255;
                this.strip.row.add_child(c);
                const destroyId = c.connect('destroy', () => this._items.delete(c));
                this._items.set(c, {role, indicator: ind, parent, index, destroyId});
                // an app started after us: show where its icon went
                const settled = GLib.get_monotonic_time() - this._startedAt > SETTLE_MS * 1000;
                if (settled && !mine && !this._open)
                    this._newcomer = true;
            } else if (!wanted && mine) {
                this._release(c);
            }
        }
        this._updateEmpty();
        if (this._newcomer) {
            this._newcomer = false;
            if (this._openIdleId)
                GLib.source_remove(this._openIdleId);
            this._openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._openIdleId = 0;
                if (this.alive && this.container.visible)
                    this.setOpen(true); // closes itself after autoCloseSec idle
                return GLib.SOURCE_REMOVE;
            });
        }
        this._writeState();
    }

    // What the drawer holds, for debugging (only written when something changed).
    _writeState() {
        const items = [...this._items.values()].map(it => ({
            role: it.role,
            container: it.indicator.container.visible,
            icon: it.indicator.visible,
            status: it.indicator._indicator?.status ?? null,
            opacity: it.indicator.container.opacity,
        }));
        const state = {
            open: this._open, arrow: this.container.visible,
            arrowParent: this.container.get_parent()?.name ?? this.container.get_parent()?.constructor?.name ?? null,
            stripParent: Boolean(this.strip.get_parent()), items,
        };
        const key = JSON.stringify(state);
        if (key === this._stateKey)
            return;
        this._stateKey = key;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o755);
            GLib.file_set_contents(STATE_FILE, encoder.encode(JSON.stringify({...state, at: new Date().toISOString()}, null, 2)));
        } catch {}
    }

    _forget(c) {
        const it = this._items.get(c);
        if (it)
            c.disconnect(it.destroyId);
        this._items.delete(c);
    }

    _release(c) {
        const it = this._items.get(c);
        this._forget(c);
        if (!it)
            return;
        c.get_parent()?.remove_child(c);
        c.opacity = 255;
        const parent = it.parent ?? Main.panel._rightBox;
        parent.insert_child_at_index(c, Math.max(0, Math.min(parent.get_n_children(), it.index)));
    }

    _updateEmpty() {
        // nothing to hide: no arrow either (hide the container, so no gap is left behind)
        const any = this._items.size > 0;
        if (this.container.visible !== any)
            this.container.visible = any;
        if (!any && this._open)
            this.setOpen(false);
    }

    // Auto-close + attention, once a second.
    _watch() {
        const cfg = this._cfg();
        let busy = this.hover || this.strip.hover;
        const attention = new Set();
        for (const [c, it] of this._items) {
            const ind = it.indicator;
            if (ind.hover || ind.menu?.isOpen)
                busy = true;
            if (ind._indicator?.status === 'NeedsAttention' && c.visible && ind.visible)
                attention.add(c);
        }
        const fresh = [...attention].some(c => !this._attention.has(c));
        this._attention = attention;
        this._dot.visible = attention.size > 0 && !this._open;
        if (fresh && !this._open)
            this.setOpen(true);

        if (!this._open || busy) {
            this._idleMs = 0;
            return;
        }
        this._idleMs += POLL_MS;
        if (cfg.autoCloseSec > 0 && this._idleMs >= cfg.autoCloseSec * 1000)
            this.setOpen(false);
    }

    toggle() {
        this.setOpen(!this._open);
    }

    async setOpen(open) {
        this._wantOpen = open;
        if (this._busy)
            return;
        this._busy = true;
        try {
            while (this.alive && this._open !== this._wantOpen) {
                if (this._wantOpen)
                    await this._doOpen();
                else
                    await this._doClose();
            }
        } finally {
            this._busy = false;
        }
    }

    _ease(from, to, ms) {
        return this._tween('strip', from, to, ms, v => {
            this.strip.reveal = v;
            this.strip.queue_relayout();
        });
    }

    async _doOpen() {
        this._open = true;
        this._idleMs = 0;
        this._dot.visible = false;
        this.add_style_pseudo_class('checked');
        const ms = scaled(timing.revealMs);
        this._arrow.ease({rotation_angle_z: 180, duration: scaled(220), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        const icons = this.strip.row.get_children().filter(c => c.visible);
        for (const c of icons)
            c.opacity = 0;
        this.strip.reveal = 0;
        this.strip.show();
        const grow = this._ease(0, 1, ms);
        await wait(ms * 0.25);
        // icons nearest the arrow first
        const ins = icons.reverse().map((c, i) => wait(i * scaled(STAGGER_MS)).then(() => (this.alive ? mist(c, 'in', {duration: 340}) : null)));
        await Promise.all([grow, ...ins]);
        for (const c of icons)
            c.opacity = 255;
    }

    async _doClose() {
        this._open = false;
        this.remove_style_pseudo_class('checked');
        const ms = scaled(timing.revealMs);
        this._arrow.ease({rotation_angle_z: 0, duration: scaled(220), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        const icons = this.strip.row.get_children().filter(c => c.visible);
        await Promise.all(icons.map(c => mist(c, 'out', {duration: 240})));
        if (!this.alive)
            return;
        await this._ease(this.strip.reveal, 0, ms);
        if (!this.alive)
            return;
        this.strip.hide();
        for (const c of icons)
            c.opacity = 255;
    }

    _teardown() {
        if (this._poll)
            GLib.source_remove(this._poll);
        this._poll = 0;
        if (this._openIdleId)
            GLib.source_remove(this._openIdleId);
        this._openIdleId = 0;
        // give every icon back, exactly where it was
        for (const c of [...this._items.keys()].reverse())
            this._release(c);
        if (!this._stripGone)
            this.strip.destroy();
    }
});
