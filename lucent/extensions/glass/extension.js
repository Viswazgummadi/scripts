// SPDX-License-Identifier: GPL-3.0-or-later
// Lucent Glass: readable materials for blurred shell surfaces.
//
// The look is in the stylesheet. This file decides, for each kind of surface, whether it needs
// the dark or the light material, and puts the matching class on the UI group. It decides by
// looking at the colour of the text the current theme draws there: light text gets the dark
// material, dark text the light one. Themes do not always agree with the light/dark setting
// (and not even with themselves across surfaces), so the text is the only reliable witness.
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {SwitcherGlass} from './switchers.js';

const SHADOW_CLASS = 'lucent-bar-shadow';
const SMOKE_CLASSES = {
    light: 'lucent-smoke-light',
    medium: 'lucent-smoke-medium',
    heavy: 'lucent-smoke-heavy',
};

// For each surface: the style classes, outermost first, of a typical piece of text on it.
const SURFACES = {
    menus: ['popup-menu-boxpointer popup-menu', 'popup-menu-content', 'popup-menu-item'],
    quick: ['popup-menu-boxpointer popup-menu', 'quick-settings popup-menu-content', 'quick-toggle button', 'quick-toggle-title'],
    date: ['popup-menu-boxpointer popup-menu', 'popup-menu-content datemenu-popover', 'calendar', 'calendar-day'],
    banner: ['message notification-banner', 'message-content'],
};
const SIDES = ['dark', 'light'];

/**
 * Relative luminance of an sRGB colour (WCAG definition).
 *
 * @param {Cogl.Color} color
 * @returns {number} 0 (black) to 1 (white)
 */
function luminance(color) {
    const channel = value => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue);
}

export default class LucentGlassExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._idleId = 0;
        this._settings.connectObject('changed', () => this._apply(), this);
        this._switchers = null;
        // A theme or light/dark switch can change the text colours: look again, once things settle.
        St.ThemeContext.get_for_stage(global.stage).connectObject('changed', () => this._queueApply(), this);
        // High contrast asks for solid, plain surfaces: the tints step aside while it is on.
        St.Settings.get().connectObject('notify::high-contrast', () => this._queueApply(), this);
        this._apply();
    }

    disable() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        St.Settings.get().disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        this._switchers?.destroy();
        this._switchers = null;
        this._clear();
    }

    _queueApply() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._apply();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clear() {
        for (const surface of Object.keys(SURFACES)) {
            for (const side of SIDES)
                Main.uiGroup.remove_style_class_name(`lucent-${surface}-${side}`);
        }
        Main.uiGroup.remove_style_class_name('lucent-overview');
        Main.panel.remove_style_class_name(SHADOW_CLASS);
        for (const name of Object.values(SMOKE_CLASSES))
            Main.panel.remove_style_class_name(name);
    }

    _apply() {
        // Our own classes recolour some text; take them off before looking at the theme's.
        this._clear();
        if (this._settings.get_boolean('popovers') && !St.Settings.get().high_contrast) {
            const sides = Object.fromEntries(Object.entries(SURFACES).map(
                ([surface, chain]) => [surface, this._sideFor(chain)]));
            for (const [surface, side] of Object.entries(sides))
                Main.uiGroup.add_style_class_name(`lucent-${surface}-${side}`);
            this._menusSide = sides.menus;
            Main.uiGroup.add_style_class_name('lucent-overview');
        }
        if (this._settings.get_boolean('bar-text-shadow'))
            Main.panel.add_style_class_name(SHADOW_CLASS);
        const smoke = SMOKE_CLASSES[this._settings.get_string('bar-smoke')];
        if (smoke)
            Main.panel.add_style_class_name(smoke);

        // High contrast asks for plain, solid surfaces: no liquid glass then either.
        const liquid = this._settings.get_boolean('liquid-switchers') && !St.Settings.get().high_contrast;
        if (liquid && !this._switchers)
            this._switchers = new SwitcherGlass(() => this._menusSide ?? this._sideFor(SURFACES.menus),
                () => this._settings?.get_int('switcher-icon-size') ?? 64);
        else if (!liquid && this._switchers) {
            this._switchers.destroy();
            this._switchers = null;
        }
    }

    // Build a hidden stand-in for a piece of text on a surface and ask the theme for its colour.
    _sideFor(chain) {
        const root = new St.Widget({style_class: chain[0], visible: false});
        let leaf = root;
        for (const styleClass of chain.slice(1)) {
            const child = new St.Widget({style_class: styleClass});
            leaf.add_child(child);
            leaf = child;
        }
        Main.uiGroup.add_child(root);
        const textIsLight = luminance(leaf.get_theme_node().get_foreground_color()) > 0.5;
        root.destroy();
        return textIsLight ? 'dark' : 'light';
    }
}
