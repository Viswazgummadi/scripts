// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LucentDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Magnification'),
            description: _('Works with Dash to Dock and Ubuntu Dock. Everything else about the dock is set in its own preferences.'),
        });
        const row = (key, title, subtitle, lower, upper, step, digits) => {
            const spin = new Adw.SpinRow({
                title, subtitle, digits,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
            });
            settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(spin);
        };
        row('magnification', _('Size'), _('Times the normal size, under the pointer; 1 turns it off'), 1, 2.5, 0.1, 1);
        row('reach', _('Reach'), _('How many icons to each side swell with it'), 1, 5, 0.5, 1);
        row('settle-time', _('Settle time'), _('Milliseconds to shrink back when the pointer leaves'), 0, 300, 10, 0);
        page.add(group);
        window.add(page);
    }
}
