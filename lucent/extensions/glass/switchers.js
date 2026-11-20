// SPDX-License-Identifier: GPL-3.0-or-later
// Liquid glass behind the shell's switchers (Alt+Tab, the window and app cyclers).
//
// Each switcher is a full-screen SwitcherPopup added to the UI group, holding one SwitcherList:
// the visible box. When a popup appears, a shadow and a glass layer (shared/liquid.js, the same
// material as Lucent Launcher) are placed in the UI group just below it, kept on the list's box,
// faded with the popup, and removed with it. The list's own flat background is turned off.
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Glass} from './liquid.js';

// widest an app switcher item gets for a long name, px
const MAX_ITEM = 128;

const LIQUID = {band: 22, refraction: 22, dispersion: 0.3, rim: 0.65, glow: 0.07};
const LIQUID_LIGHT = {...LIQUID, rim: 0.9, glow: 0.09};

export class SwitcherGlass {
    // side(): 'dark' or 'light', the material the menus use; iconSize(): largest app icon, px
    constructor(side, iconSize) {
        this._side = side;
        this._iconSize = iconSize;
        this._dressed = new Map(); // popup -> {glass, shadow, list}
        Main.uiGroup.connectObject('child-added', (_g, actor) => this._watch(actor), this);
        for (const actor of Main.uiGroup.get_children())
            this._watch(actor);
    }

    destroy() {
        Main.uiGroup.disconnectObject(this);
        for (const popup of [...this._dressed.keys()])
            this._undress(popup);
        this._dressed = null;
    }

    _watch(actor) {
        if (!actor.has_style_class_name?.('switcher-popup') || this._dressed.has(actor))
            return;
        // the list is created after the popup is added, and it is shown after a short delay
        actor.connectObject(
            'notify::mapped', () => this._dress(actor),
            'destroy', () => this._undress(actor, true), this);
        this._dress(actor);
    }

    _dress(popup) {
        const list = popup._switcherList;
        if (!popup.mapped || !list || this._dressed?.has(popup))
            return;
        this._shrinkIcons(list);
        const dark = this._side() !== 'light';
        const node = list.get_theme_node();
        const radius = Math.max(8, node.get_border_radius(St.Corner.TOPLEFT));

        const shadow = new St.Widget({style_class: `lucent-liquid-shadow lucent-liquid-shadow-${dark ? 'dark' : 'light'}`, reactive: false});
        const glass = new Glass();
        glass.reactive = false;
        Main.uiGroup.insert_child_below(shadow, popup);
        Main.uiGroup.insert_child_below(glass, popup);
        list.add_style_class_name('lucent-liquid');
        glass.configure({
            radius,
            tint: dark ? [0.11, 0.11, 0.12, 0.36] : [0.97, 0.97, 0.98, 0.56],
            sat: 1.8,
            blur: 18,
            liquid: dark ? LIQUID : LIQUID_LIGHT,
        });

        let sized = false;
        const sync = () => {
            if (!list.has_allocation())
                return;
            const [x, y] = list.get_transformed_position();
            const [w, h] = list.get_transformed_size();
            sized = w >= 1 && h >= 1;
            follow();
            glass.set_position(Math.round(x), Math.round(y));
            glass.set_size(Math.round(w), Math.round(h));
            glass.setOrigin(Math.round(x), Math.round(y));
            shadow.set_position(Math.round(x) + 10, Math.round(y) + 10);
            shadow.set_size(Math.max(0, Math.round(w) - 20), Math.max(0, Math.round(h) - 20));
            shadow.style = `border-radius: ${radius}px;`;
        };
        // never drawn before the list has a size: an effect on a zero-sized actor has nothing to draw into
        function follow() {
            glass.opacity = shadow.opacity = popup.opacity;
            glass.visible = shadow.visible = popup.visible && sized;
        }
        list.connectObject('notify::allocation', sync, this);
        popup.connectObject('notify::opacity', follow, 'notify::visible', follow, this);
        sync();
        follow();
        glass.build();
        this._dressed.set(popup, {glass, shadow, list});
    }

    // The app switcher picks the largest of 96/64/48/32/22 px that fits the screen. Cap it. This runs
    // while the popup is still transparent (it fades in after a short delay), so nothing jumps.
    _shrinkIcons(list) {
        if (!Array.isArray(list.icons) || typeof list._setIconSize !== 'function')
            return; // not the app switcher (window thumbnails keep their size)
        if (!list._iconSize)
            list._setIconSize();
        const size = Math.min(list._iconSize, this._iconSize());
        if (size === list._iconSize)
            return;
        list._iconSize = size;
        for (const icon of list.icons)
            icon.set_size?.(size);
        // The shell makes every item square, so a smaller icon narrows it and cuts long names.
        // Instead every item gets one width: the longest name's (at most MAX_ITEM), never less
        // than the icon.
        const names = list.icons.map(icon => icon.label?.get_preferred_width(-1)[1] ?? 0);
        const width = Math.round(Math.min(MAX_ITEM, Math.max(size, ...names)));
        for (const item of list._items ?? []) {
            item._square = false;
            item.set_style(`min-width: ${width}px;`);
        }
        list.queue_relayout();
    }

    // `dying`: the popup is being destroyed, and its list with it: leave the list alone
    _undress(popup, dying = false) {
        const it = this._dressed?.get(popup);
        if (!dying)
            popup.disconnectObject(this);
        if (!it)
            return;
        this._dressed.delete(popup);
        if (!dying) {
            it.list.disconnectObject(this);
            it.list.remove_style_class_name('lucent-liquid');
        }
        it.glass.teardown();
        it.glass.destroy();
        it.shadow.destroy();
    }
}
