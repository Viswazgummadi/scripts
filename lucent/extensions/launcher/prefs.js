// SPDX-License-Identifier: GPL-3.0-or-later
// Preferences for Lucent Launcher.
//
// The launcher keeps its settings in ~/.config/lucent-launcher/config.json and reloads that file
// whenever it is saved. This window is a comfortable editor for the common settings in it; the
// tables (web shortcuts, quick keys, projects, excluded paths) are edited in the file itself.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {DEFAULTS, DIR} from './core/config.js';

const FILE = GLib.build_filenamev([DIR, 'config.json']);

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

    // 'glass.blur' -> the user's value, or the default
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

export default class LucentLauncherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const store = new Store();
        window.set_default_size(640, 760);

        const switchRow = (path, title, subtitle = null) => {
            const row = new Adw.SwitchRow({title, subtitle, active: Boolean(store.get(path))});
            row.connect('notify::active', () => store.set(path, row.active));
            return row;
        };
        const spinRow = (path, title, subtitle, {lower, upper, step, digits = 0, scale = 1}) => {
            const row = new Adw.SpinRow({
                title, subtitle, digits,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
            });
            row.value = store.get(path) * scale;
            row.connect('notify::value', () =>
                store.set(path, Number((row.value / scale).toFixed(digits + Math.round(Math.log10(scale))))));
            return row;
        };
        const comboRow = (path, title, choices) => {
            const row = new Adw.ComboRow({
                title,
                model: Gtk.StringList.new(choices.map(([, label]) => label)),
                selected: Math.max(0, choices.findIndex(([id]) => id === store.get(path))),
            });
            row.connect('notify::selected', () => store.set(path, choices[row.selected][0]));
            return row;
        };
        const entryRow = (path, title, validate = () => true) => {
            // titles here contain accelerators such as <Super>space, which are not markup
            const row = new Adw.EntryRow({title, use_markup: false, text: String(store.get(path) ?? ''), show_apply_button: true});
            row.connect('apply', () => {
                if (validate(row.text)) {
                    row.remove_css_class('error');
                    store.set(path, row.text);
                } else {
                    row.add_css_class('error');
                }
            });
            return row;
        };
        const group = (page, title, description, rows) => {
            const g = new Adw.PreferencesGroup({title, description});
            for (const row of rows)
                g.add(row);
            page.add(g);
        };

        // ---- General --------------------------------------------------------------------------------
        const general = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});
        group(general, _('Opening'), null, [
            entryRow('shortcut', _('Shortcut, for example <Super>space or <Control>space'),
                text => Gtk.accelerator_parse(text)[0]),
            switchRow('freeSuperSpace', _('Borrow Super+Space'),
                _('With one keyboard layout GNOME\'s "switch input source" key does nothing; the launcher uses it and gives it back when switched off')),
        ]);
        group(general, _('Look'), null, [
            comboRow('theme', _('Style'), [['auto', _('Follow the system')], ['dark', _('Dark')], ['light', _('Light')]]),
            spinRow('width', _('Width'), _('Pixels'), {lower: 520, upper: 1200, step: 20}),
            spinRow('top', _('Distance from the top'), _('Percent of the screen height'), {lower: 5, upper: 45, step: 1, scale: 100}),
            switchRow('animations', _('Animations')),
        ]);
        group(general, _('Glass'), _('What the panel does to the windows behind it.'), [
            spinRow('glass.blur', _('Blur'), _('Radius in pixels'), {lower: 0, upper: 120, step: 4}),
            spinRow('glass.tint', _('Tint'), _('Percent; higher is more opaque'), {lower: 0, upper: 95, step: 5, scale: 100}),
            spinRow('glass.saturation', _('Saturation'), _('Colour boost; 1 leaves colours as they are'),
                {lower: 1, upper: 2.5, step: 0.1, digits: 1}),
        ]);
        window.add(general);

        // ---- Privacy --------------------------------------------------------------------------------
        const privacy = new Adw.PreferencesPage({title: _('Privacy'), icon_name: 'preferences-system-privacy-symbolic'});
        group(privacy, _('Network'),
            _('Nothing you type leaves this computer unless one of these is on or you choose a web result.'), [
                switchRow('webSuggestions', _('Search suggestions'), _('Sends what you type to DuckDuckGo while you type')),
                switchRow('onlineDefinitions', _('Online definitions'), _('Looks a word up when you ask for its meaning')),
                entryRow('searchEngine', _('Search engine address (%s is the query)'), text => text.includes('%s')),
            ]);
        group(privacy, _('Clipboard history'), null, [
            switchRow('clipboard.enabled', _('Keep a history'), _('Remembers what you copy so you can paste it again')),
            switchRow('clipboard.persist', _('Save it to disk'), _('Off: the history is forgotten when you log out')),
            spinRow('clipboard.max', _('Entries kept'), null, {lower: 10, upper: 500, step: 10}),
            spinRow('clipboard.retentionHours', _('Forget after'), _('Hours'), {lower: 1, upper: 168, step: 1}),
        ]);
        window.add(privacy);

        // ---- Sources --------------------------------------------------------------------------------
        const sources = new Adw.PreferencesPage({title: _('Sources'), icon_name: 'system-search-symbolic'});
        const providers = [
            ['apps', _('Applications')], ['windows', _('Open windows')], ['files', _('Files and folders')],
            ['calculator', _('Calculator')], ['conversions', _('Units and currency')], ['dictionary', _('Definitions')],
            ['system', _('System actions and toggles')], ['clipboard', _('Clipboard history')], ['media', _('Media controls')],
            ['commands', _('Commands, SSH hosts and Makefile targets')], ['web', _('Web search')],
            ['remote', _('Results from other applications')],
        ];
        group(sources, _('What the launcher searches'), null, providers.map(([id, title]) => {
            const row = new Adw.SwitchRow({title, active: store.get(`providers.${id}`) !== false});
            row.connect('notify::active', () => store.set(`providers.${id}`, row.active));
            return row;
        }));
        const open = new Adw.ActionRow({
            title: _('Open the settings file'),
            subtitle: _('Web shortcuts, quick keys, projects, file locations and the terminal are edited there'),
            activatable: true,
        });
        open.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        open.connect('activated', () => Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(FILE, null), null));
        group(sources, _('Advanced'), null, [open]);
        window.add(sources);
    }
}
