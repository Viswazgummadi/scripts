// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class LucentGlassPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const levels = [
            ['none', _('None')],
            ['light', _('Light (30%)')],
            ['medium', _('Medium (45%)')],
            ['heavy', _('Heavy (60%)')],
        ];
        const page = new Adw.PreferencesPage();

        const bar = new Adw.PreferencesGroup({
            title: _('Top bar'),
            description: _('Medium is the lightest smoke that keeps white text readable over a bright wallpaper.'),
        });
        const smoke = new Adw.ComboRow({
            title: _('Smoke'),
            subtitle: _('Darkens the bar behind its text'),
            model: Gtk.StringList.new(levels.map(([, label]) => label)),
            selected: Math.max(0, levels.findIndex(([id]) => id === settings.get_string('bar-smoke'))),
        });
        smoke.connect('notify::selected', () => settings.set_string('bar-smoke', levels[smoke.selected][0]));
        settings.connect('changed::bar-smoke', () => {
            const index = levels.findIndex(([id]) => id === settings.get_string('bar-smoke'));
            if (index >= 0 && index !== smoke.selected)
                smoke.selected = index;
        });
        bar.add(smoke);
        const shadow = new Adw.SwitchRow({
            title: _('Text shadow'),
            subtitle: _('A soft shadow under the bar\'s text and icons'),
        });
        settings.bind('bar-text-shadow', shadow, 'active', Gio.SettingsBindFlags.DEFAULT);
        bar.add(shadow);
        page.add(bar);

        const menus = new Adw.PreferencesGroup({title: _('Menus and notifications')});
        const popovers = new Adw.SwitchRow({
            title: _('Readable glass'),
            subtitle: _('Menus, notifications, switchers, dialogs and the overview search field, with a tint calculated to pass WCAG AA over any window'),
        });
        settings.bind('popovers', popovers, 'active', Gio.SettingsBindFlags.DEFAULT);
        menus.add(popovers);
        const switchers = new Adw.SwitchRow({
            title: _('Liquid glass switchers'),
            subtitle: _('Alt+Tab and the other switchers on liquid glass, like Lucent Launcher'),
        });
        settings.bind('liquid-switchers', switchers, 'active', Gio.SettingsBindFlags.DEFAULT);
        menus.add(switchers);
        const iconSize = new Adw.SpinRow({
            title: _('Switcher icon size'),
            subtitle: _('Largest size of the app icons in Alt+Tab, in pixels'),
            adjustment: new Gtk.Adjustment({lower: 32, upper: 96, step_increment: 8, page_increment: 16}),
        });
        settings.bind('switcher-icon-size', iconSize, 'value', Gio.SettingsBindFlags.DEFAULT);
        menus.add(iconSize);
        page.add(menus);

        window.add(page);
    }
}
