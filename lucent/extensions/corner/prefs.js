// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LucentCornerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Hot corner'),
            description: _('The top corner beside the system menu opens Quick Settings.'),
        });

        const dwell = new Adw.SpinRow({
            title: _('Dwell time'),
            subtitle: _('Milliseconds the pointer rests in the corner before the menu opens'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1000, step_increment: 10, page_increment: 100}),
        });
        settings.bind('dwell-time', dwell, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(dwell);

        const overview = new Adw.SwitchRow({
            title: _('React in the overview'),
            subtitle: _('Off: the corner does nothing while the overview is shown'),
        });
        settings.bind('open-in-overview', overview, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(overview);

        page.add(group);
        window.add(page);
    }
}
