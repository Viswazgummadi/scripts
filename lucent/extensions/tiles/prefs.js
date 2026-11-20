// SPDX-License-Identifier: GPL-3.0-or-later
// Preferences for Lucent Tiles. The settings live in ~/.config/lucent-tiles/layout.json, which the
// extension re-reads whenever it is saved; this window edits that file. Where each tile sits and
// which items the tray drawer takes are edited in the file itself.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {DEFAULTS, DIR, FILE} from './settings.js';

/** The settings file as an object, read and written whole. */
class Store {
    constructor() {
        this.data = {};
        try {
            const [, bytes] = GLib.file_get_contents(FILE);
            this.data = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            // no file yet, or not valid JSON: start from the defaults
        }
    }

    get(path) {
        const walk = root => path.split('.').reduce((node, key) => node?.[key], root);
        return walk(this.data) ?? walk(DEFAULTS);
    }

    set(path, value) {
        const keys = path.split('.');
        let node = this.data;
        for (const key of keys.slice(0, -1)) {
            if (typeof node[key] !== 'object' || node[key] === null)
                node[key] = {};
            node = node[key];
        }
        if (JSON.stringify(node[keys.at(-1)]) === JSON.stringify(value))
            return;
        node[keys.at(-1)] = value;
        GLib.mkdir_with_parents(DIR, 0o755);
        GLib.file_set_contents(FILE, `${JSON.stringify(this.data, null, 2)}\n`);
    }
}

export default class LucentTilesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const store = new Store();
        window.set_default_size(620, 720);

        const spinRow = (path, title, subtitle, lower, upper, step) => {
            const row = new Adw.SpinRow({
                title, subtitle,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
            });
            row.value = Number(store.get(path));
            row.connect('notify::value', () => store.set(path, Math.round(row.value)));
            return row;
        };
        const comboRow = (path, title, subtitle, choices) => {
            const row = new Adw.ComboRow({
                title, subtitle,
                model: Gtk.StringList.new(choices.map(([, label]) => label)),
                selected: Math.max(0, choices.findIndex(([id]) => id === store.get(path))),
            });
            row.connect('notify::selected', () => store.set(path, choices[row.selected][0]));
            return row;
        };
        const group = (page, title, description, rows) => {
            const g = new Adw.PreferencesGroup({title, description});
            for (const row of rows)
                g.add(row);
            page.add(g);
        };

        const page = new Adw.PreferencesPage();
        group(page, _('Bar'), _('Tiles are ordinary top-bar buttons: their highlight comes from the shell theme.'), [
            comboRow('style', _('Spacing'), null, [['tile', _('Tight (the values below)')], ['plain', _('The theme\'s own')]]),
            spinRow('gap', _('Gap between tiles'), _('Pixels'), 0, 24, 1),
            spinRow('hpadding', _('Padding inside a tile'), _('Pixels; GNOME uses 12'), 0, 24, 1),
            spinRow('activityWidth', _('Activity text width'), _('Pixels; longer text scrolls'), 60, 400, 10),
        ]);
        group(page, _('Player'), null, [
            comboRow('playerOpen', _('Opens on'), null,
                [['both', _('Hover or click')], ['hover', _('Hover')], ['click', _('Click')]]),
            spinRow('hoverDelayMs', _('Hover delay'), _('Milliseconds the pointer rests before it opens'), 0, 1000, 10),
            comboRow('playerBackground', _('Card background'), null,
                [['art', _('Album art, darkened')], ['blur', _('Album art, blurred')], ['none', _('None')]]),
        ]);
        group(page, _('Motion'), null, [
            spinRow('resizeMs', _('Resize'), _('Milliseconds a tile takes to change width'), 0, 1000, 10),
            spinRow('revealMs', _('Appear and disappear'), _('Milliseconds'), 0, 1000, 10),
        ]);
        group(page, _('Tray drawer'), null, [
            spinRow('drawer.autoCloseSec', _('Close by itself after'), _('Seconds without use; 0 keeps it open'), 0, 120, 1),
        ]);
        const open = new Adw.ActionRow({
            title: _('Open the settings file'),
            subtitle: _('Where each tile sits, and which items the tray drawer takes'),
            activatable: true,
        });
        open.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        open.connect('activated', () => Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(FILE, null), null));
        group(page, _('Advanced'), null, [open]);
        window.add(page);
    }
}
