// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LucentDissolvePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const styles = [
            ['mist', _('Mist')],
            ['pixels', _('Pixels')],
            ['fade', _('Soft fade')],
            ['random', _('Mist or pixels, at random')],
        ];
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Closing a window'),
            description: _('With reduced motion switched on in Accessibility, windows always fade without moving.'),
        });

        const style = new Adw.ComboRow({
            title: _('Style'),
            model: Gtk.StringList.new(styles.map(([, label]) => label)),
            selected: Math.max(0, styles.findIndex(([id]) => id === settings.get_string('style'))),
        });
        style.connect('notify::selected', () => settings.set_string('style', styles[style.selected][0]));
        settings.connect('changed::style', () => {
            const index = styles.findIndex(([id]) => id === settings.get_string('style'));
            if (index >= 0 && index !== style.selected)
                style.selected = index;
        });
        group.add(style);

        const duration = new Adw.SpinRow({
            title: _('Duration'),
            subtitle: _('Milliseconds; dialogs take a little under half'),
            adjustment: new Gtk.Adjustment({lower: 150, upper: 2000, step_increment: 50, page_increment: 200}),
        });
        settings.bind('duration', duration, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(duration);

        const timing = new Adw.SwitchRow({
            title: _('Keep this timing'),
            subtitle: _('Ignore a faster or slower animation speed set for the whole desktop'),
        });
        settings.bind('keep-own-timing', timing, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(timing);

        page.add(group);
        window.add(page);
    }
}
