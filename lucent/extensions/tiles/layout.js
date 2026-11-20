// SPDX-License-Identifier: GPL-3.0-or-later
// Where the tiles live and how they look, from ~/.config/lucent-tiles/layout.json (defaults in settings.js)
// (created on first run, re-read whenever you save it: moved tiles shrink away and grow back
// in at their new spot).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {timing} from './tile.js';
import {DEFAULTS, DIR, FILE} from './settings.js';


const ROLE = {
    clock: 'dateMenu', system: 'lucent-tiles-system', activity: 'lucent-tiles-activity', drawer: 'lucent-tiles-drawer',
};
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function boxFor(name) {
    return {left: Main.panel._leftBox, center: Main.panel._centerBox, right: Main.panel._rightBox}[name] ??
        Main.panel._rightBox;
}

export class Layout {
    constructor(tiles) {
        this._tiles = tiles; // {system, activity, drawer}
        this._dir = DIR;
        this.file = FILE;
        this._clock = Main.panel.statusArea.dateMenu;
        this._clockStyle = this._clock?.container.style ?? null;
        this._ensureFile();
        this._cfg = this._read();
        this._applyLook();
        for (const [name, tile] of Object.entries(this._tiles)) {
            Main.panel.addToStatusArea(ROLE[name], tile, 0, 'right');
            this._placeTile(name, tile);
        }

        this._monitor = Gio.File.new_for_path(this.file).monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (m, f, o, type) => {
            if (type !== Gio.FileMonitorEvent.CHANGES_DONE_HINT && type !== Gio.FileMonitorEvent.CREATED)
                return;
            if (this._reloadId)
                GLib.source_remove(this._reloadId);
            this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._reloadId = 0;
                this._reload();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _ensureFile() {
        if (GLib.file_test(this.file, GLib.FileTest.EXISTS))
            return;
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            GLib.file_set_contents(this.file, encoder.encode(`${JSON.stringify(DEFAULTS, null, 2)}\n`));
        } catch (e) {
            console.warn(`lucent-tiles: ${this.file}: ${e.message}`);
        }
    }

    _read() {
        let user = {};
        try {
            const [ok, bytes] = GLib.file_get_contents(this.file);
            if (ok)
                user = JSON.parse(decoder.decode(bytes));
        } catch (e) {
            console.warn(`lucent-tiles: ${this.file}: ${e.message} (using defaults)`);
        }
        return {
            ...DEFAULTS, ...user,
            tiles: {...DEFAULTS.tiles, ...(user.tiles ?? {})},
            drawer: {...DEFAULTS.drawer, ...(user.drawer ?? {})},
        };
    }

    _applyLook() {
        const c = this._cfg;
        timing.resizeMs = Number(c.resizeMs) || 0;
        timing.revealMs = Number(c.revealMs) || 0;
        const tiles = c.style !== 'plain'; // "tile" (an old "pill" value means the same)
        if (tiles)
            Main.panel.add_style_class_name('lt-tiles');
        else
            Main.panel.remove_style_class_name('lt-tiles');
        if (this._cssFile)
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._cssFile);
        this._cssFile = null;
        this._applyCss(tiles);
        const half = Math.max(0, Number(c.gap) || 0) / 2;
        const margin = `margin: 0 ${half}px;`;
        for (const tile of Object.values(this._tiles))
            tile.container.style = margin;
        if (this._clock)
            this._clock.container.style = margin;
    }

    // Padding is a theme property (-natural-hpadding), so it goes into a small generated stylesheet.
    _applyCss(tiles) {
        const c = this._cfg;
        const px = (v, d) => Math.max(0, Math.round(Number.isFinite(Number(v)) ? Number(v) : d));
        const hp = px(c.hpadding, 8), tray = px(c.trayHpadding ?? hp, hp);
        const css = [
            tiles ? `#panel.lt-tiles .panel-button { -natural-hpadding: ${hp}px; -minimum-hpadding: ${Math.min(hp, 4)}px; }` : '',
            `#panel .lt-drawer-row .panel-button { -natural-hpadding: ${tray}px; -minimum-hpadding: ${Math.min(tray, 3)}px; }`,
        ].join('\n');
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (this._cssFile)
            theme.unload_stylesheet(this._cssFile);
        const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-tiles', 'spacing.css']);
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            GLib.file_set_contents(path, encoder.encode(`${css}\n`));
            this._cssFile = Gio.File.new_for_path(path);
            theme.load_stylesheet(this._cssFile);
        } catch (e) {
            this._cssFile = null;
            console.warn(`lucent-tiles: spacing.css: ${e.message}`);
        }
    }

    get activityWidth() {
        return Math.max(60, Number(this._cfg.activityWidth) || 130);
    }

    get playerOpen() {
        return {mode: this._cfg.playerOpen, delay: this._cfg.hoverDelayMs};
    }

    get playerBackground() {
        return ['blur', 'art', 'none'].includes(this._cfg.playerBackground) ? this._cfg.playerBackground : 'art';
    }

    // Insert the tile's container where the config says.
    _place(name, tile) {
        const spec = this._cfg.tiles[name] ?? DEFAULTS.tiles[name];
        const c = tile.container;
        const anchorName = spec.after ?? spec.before;
        const anchor = anchorName ? Main.panel.statusArea[ROLE[anchorName] ?? anchorName]?.container : null;
        c.get_parent()?.remove_child(c);
        if (anchor?.get_parent() && anchor !== c) {
            const parent = anchor.get_parent();
            if (spec.after)
                parent.insert_child_above(c, anchor);
            else
                parent.insert_child_below(c, anchor);
            return;
        }
        const box = boxFor(spec.box);
        const n = box.get_n_children();
        let i = Number.isInteger(spec.index) ? spec.index : 0;
        if (i < 0)
            i = n + 1 + i;
        box.insert_child_at_index(c, Math.max(0, Math.min(n, i)));
    }

    _placeTile(name, tile) {
        this._place(name, tile);
        tile.afterPlace?.();
    }

    get drawerConfig() {
        return this._cfg.drawer;
    }

    async _reload() {
        const before = this._cfg.tiles;
        this._cfg = this._read();
        this._applyLook();
        for (const tile of Object.values(this._tiles))
            tile.applyConfig?.();
        // Move only the tiles whose place changed: shrink away, move, grow back in.
        for (const [name, tile] of Object.entries(this._tiles)) {
            if (JSON.stringify(before[name]) === JSON.stringify(this._cfg.tiles[name]))
                continue;
            if (tile.container.visible)
                await tile.setShown(false, tile._box);
            if (!tile.alive)
                return;
            this._placeTile(name, tile);
            if (tile.active ?? true)
                await tile.setShown(true, tile._box);
            else
                tile.container.hide();
        }
    }

    destroy() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._monitor?.cancel();
        Main.panel.remove_style_class_name('lt-tiles');
        if (this._cssFile)
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._cssFile);
        this._cssFile = null;
        if (this._clock)
            this._clock.container.style = this._clockStyle;
    }
}
