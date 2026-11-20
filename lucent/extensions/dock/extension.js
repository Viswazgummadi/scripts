// SPDX-License-Identifier: GPL-3.0-or-later
// Lucent Dock: magnification for Dash to Dock.
//
// How it works. Each dock Dash to Dock puts on screen is an actor named "dashtodockContainer".
// While the pointer is over one, its icons are drawn by live clones in a layer just above the
// dock, scaled around the edge the dock sits on and spread apart along it; the real icons stay
// exactly where they are but become transparent. So:
//   - nothing in the dock's layout is changed: clicks, hover labels, drag and drop and hiding all
//     work on the real icons as before; only its background is stretched (a transform) to hold
//     the wider row, and a glass that follows the background, like Blur my Shell's, goes with it;
//   - the grown icons are not cut off by the dock's scroll area, which clips what it paints.
// When the pointer leaves, the clones ease back to the icons' own size and place, and the real
// icons are shown again.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {layout} from './magnifier.js';

const DOCK_NAME = 'dashtodockContainer';

// For each side the dock can sit on: the axis icons run along, and the pivot (the edge they grow from).
const SIDES = {
    bottom: {vertical: false, pivot: [0.5, 1]},
    top: {vertical: false, pivot: [0.5, 0]},
    left: {vertical: true, pivot: [0, 0.5]},
    right: {vertical: true, pivot: [1, 0.5]},
};

export default class LucentDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._docks = new Map(); // dock -> {controller, target, layer, stretch, clones: Map(icon -> {clone, destroyId}), labels: Moved, separators: Moved}
        Main.uiGroup.connectObject(
            'child-added', (group, actor) => this._attach(actor),
            'child-removed', (group, actor) => this._detach(actor), this);
        for (const actor of Main.uiGroup.get_children())
            this._attach(actor);
    }

    disable() {
        Main.uiGroup.disconnectObject(this);
        for (const dock of [...this._docks.keys()])
            this._detach(dock);
        this._docks = null;
        this._settings = null;
    }

    _attach(dock) {
        if (dock.name !== DOCK_NAME || this._docks.has(dock))
            return;
        // The dock's outer actor is not reactive and gets no pointer events; Dash to Dock tracks
        // the pointer on an inner box. Listen on the outermost reactive actor inside the dock.
        const target = reactiveInside(dock);
        if (!target)
            return;
        const controller = new Clutter.MotionController();
        const entry = {controller, target, layer: null, stretch: null, clones: new Map(), labels: new Moved(), separators: new Moved()};
        controller.connect('motion', () => this._update(dock, entry));
        controller.connect('leave', () => this._settle(entry));
        target.add_action(controller);
        dock.connectObject('destroy', () => this._detach(dock), this);
        this._docks.set(dock, entry);
    }

    _detach(dock) {
        const entry = this._docks?.get(dock);
        if (!entry)
            return;
        this._docks.delete(dock);
        dock.disconnectObject(this);
        entry.target.remove_action(entry.controller);
        this._clear(entry);
    }

    _update(dock, entry) {
        const magnification = this._settings.get_double('magnification');
        const icons = dockIcons(dock);
        if (!icons.length)
            return;
        const side = SIDES[Object.keys(SIDES).find(s => dock.has_style_class_name(s)) ?? 'bottom'];

        entry.settling = null;
        if (!entry.layer) {
            entry.layer = new Clutter.Actor({reactive: false});
            Main.uiGroup.insert_child_above(entry.layer, dock);
        }
        // Clones for icons that appeared, none for icons that went.
        const live = new Set(icons.map(i => i.icon));
        for (const icon of [...entry.clones.keys()]) {
            if (!live.has(icon))
                this._drop(entry, icon, true);
        }

        // Where each icon is laid out: the icons themselves are never moved, so this is exact.
        const boxes = icons.map(({icon}) => {
            const [x, y] = icon.get_transformed_position();
            const [w, h] = icon.get_transformed_size();
            return {x, y, w, h};
        });
        const [px, py] = global.get_pointer();
        const along = b => (side.vertical ? b.y + b.h / 2 : b.x + b.w / 2);
        const length = b => (side.vertical ? b.h : b.w);
        const result = layout(boxes.map(along), boxes.map(length), side.vertical ? py : px,
            magnification, this._settings.get_double('reach'));
        const grown = result.reduce((sum, r, i) => sum + (r.scale - 1) * length(boxes[i]), 0);
        this._stretch(dock, entry, side, grown);
        this._moveSeparators(dock, entry, side, boxes.map(along), boxes.map(length), result);

        icons.forEach(({icon, container}, i) => {
            let clone = entry.clones.get(icon)?.clone;
            if (!clone) {
                clone = new Clutter.Clone({source: icon});
                entry.layer.add_child(clone);
                // the dock may rebuild its icons at any time, even while they settle
                const destroyId = icon.connect('destroy', () => this._drop(entry, icon, false));
                entry.clones.set(icon, {clone, destroyId});
            }
            const b = boxes[i];
            clone.remove_all_transitions();
            clone.set({x: b.x, y: b.y, width: b.w, height: b.h});
            clone.set_pivot_point(...side.pivot);
            clone.scale_x = clone.scale_y = result[i].scale;
            clone.translation_x = side.vertical ? 0 : result[i].shift;
            clone.translation_y = side.vertical ? result[i].shift : 0;
            icon.opacity = 0;

            // The dock shows an icon's name just beyond its normal size: move it out by what the
            // icon gained. Set directly, without touching transitions: the dock fades labels.
            const label = container.label;
            if (label) {
                entry.labels.track(label);
                const grown = (result[i].scale - 1) * (side.vertical ? b.w : b.h);
                label.translation_x = side.vertical ? grown * (side.pivot[0] === 0 ? 1 : -1) : result[i].shift;
                label.translation_y = side.vertical ? result[i].shift : grown * (side.pivot[1] === 0 ? 1 : -1);
            }
        });
    }

    // Widen the dock's background by what the grown icons add, about its centre, as the row grows
    // equally on both sides. A transform, not a new size: the dock's layout and input stay as they
    // are, and a glass drawn behind the dock from the background's transformed box (Blur my Shell
    // does this) grows with it.
    _stretch(dock, entry, side, grown) {
        const background = dockBackground(dock);
        if (entry.stretch?.background !== background) {
            entry.stretch?.release();
            entry.stretch = background ? new Stretch(background, side.vertical) : null;
        }
        entry.stretch?.set(grown);
    }

    // A separator (between pinned and running apps) stays in the dock: move it to the middle of
    // the gap between the grown icons on either side of it.
    _moveSeparators(dock, entry, side, centers, sizes, result) {
        for (const separator of dockSeparators(dock)) {
            const [x, y] = separator.get_transformed_position();
            const [w, h] = separator.get_transformed_size();
            const at = side.vertical ? y + h / 2 : x + w / 2;
            const i = centers.findLastIndex(c => c < at);
            if (i < 0 || i + 1 >= centers.length)
                continue;
            const before = centers[i] + result[i].shift + sizes[i] * result[i].scale / 2;
            const after = centers[i + 1] + result[i + 1].shift - sizes[i + 1] * result[i + 1].scale / 2;
            const was = (centers[i] + sizes[i] / 2 + centers[i + 1] - sizes[i + 1] / 2) / 2;
            const move = (before + after) / 2 - was;
            entry.separators.track(separator);
            separator.remove_transition('translation-x');
            separator.remove_transition('translation-y');
            separator.set({translation_x: side.vertical ? 0 : move, translation_y: side.vertical ? move : 0});
        }
    }

    // The pointer left: grow the clones back to the icons' own size and place, then hand over.
    _settle(entry) {
        entry.labels.reset();
        const ms = this._settings.get_int('settle-time');
        const clones = [...entry.clones.values()].map(c => c.clone);
        const st = St.Settings.get();
        if (!clones.length || !ms || !st.enable_animations || st.reducedMotion === St.ReducedMotion.REDUCE) {
            this._clear(entry);
            return;
        }
        entry.stretch?.ease(ms);
        entry.separators.ease(ms);
        // Hand over once every clone is back, unless a new hover took over in the meantime
        // (it clears the token); a clone whose icon went away also counts as back.
        const token = entry.settling = {};
        let left = clones.length;
        for (const clone of clones) {
            clone.ease({
                scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
                duration: ms,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (--left === 0 && entry.settling === token)
                        this._clear(entry);
                },
            });
        }
    }

    // Forget one icon's clone. `alive` is false when the icon itself is being destroyed.
    _drop(entry, icon, alive) {
        const it = entry.clones.get(icon);
        if (!it)
            return;
        entry.clones.delete(icon);
        icon.disconnect(it.destroyId);
        it.clone.destroy();
        if (alive)
            icon.opacity = 255;
    }

    _clear(entry) {
        for (const icon of [...entry.clones.keys()])
            this._drop(entry, icon, true);
        entry.labels.reset();
        entry.stretch?.release();
        entry.stretch = null;
        entry.separators.reset();
        entry.layer?.destroy();
        entry.layer = null;
    }
}

/**
 * Actors of the dock's own (labels, separators) that this moves with translation, to be put back.
 * Dash to Dock may destroy any of them at any time (it rebuilds its icons), so each is forgotten
 * the moment it is destroyed instead of being touched afterwards.
 */
class Moved {
    constructor() {
        this._actors = new Map(); // actor -> destroy handler id
    }

    track(actor) {
        if (!this._actors.has(actor))
            this._actors.set(actor, actor.connect('destroy', () => this._actors.delete(actor)));
    }

    // Back to no translation over `ms` milliseconds; they stay tracked until reset().
    ease(ms) {
        for (const actor of this._actors.keys())
            actor.ease({translation_x: 0, translation_y: 0, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Back to no translation now, and forget them.
    reset() {
        for (const [actor, id] of this._actors) {
            actor.disconnect(id);
            actor.remove_transition('translation-x');
            actor.remove_transition('translation-y');
            actor.set({translation_x: 0, translation_y: 0});
        }
        this._actors.clear();
    }
}

/**
 * The dock's background, stretched along the dock about its centre.
 *
 * Dash to Dock clips the box that holds the background (and Blur my Shell's glass beside it) to
 * that box's own size, and sets the clip again whenever it lays the box out. While the background
 * is stretched, the clip is widened along the dock by the same amount, every time Dash to Dock
 * sets it, so the wider glass is not cut off at the old ends. Across the dock the clip is left
 * alone: it is what slides the dock out of view when it hides.
 */
class Stretch {
    constructor(background, vertical) {
        this.background = background;
        this._vertical = vertical;
        this._box = background.get_parent()?.get_parent() ?? null; // dash-background < dash < box
        this._own = null; // the clip this sets, to tell it from Dash to Dock's
        this._base = null; // Dash to Dock's clip
        background.set_pivot_point(0.5, 0.5);
        background.connectObject(
            'notify::scale-x', () => this._clip(),
            'notify::scale-y', () => this._clip(),
            'destroy', () => this.release(), this);
        this._box?.connectObject('notify::clip-rect', () => this._dockClipped(), 'destroy', () => {
            this._box = null;
        }, this);
        this._dockClipped();
    }

    // Grow the background by `grown` pixels along the dock, at once.
    set(grown) {
        const length = this._vertical ? this.background.height : this.background.width;
        if (length <= 0)
            return;
        const scale = (length + grown) / length;
        this.background.remove_transition('scale-x');
        this.background.remove_transition('scale-y');
        this.background.set_scale(this._vertical ? 1 : scale, this._vertical ? scale : 1);
    }

    // Back to its own size over `ms` milliseconds.
    ease(ms) {
        this.background.ease({scale_x: 1, scale_y: 1, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    release() {
        if (!this.background)
            return;
        const background = this.background;
        this.background = null;
        background.disconnectObject(this);
        background.remove_transition('scale-x');
        background.remove_transition('scale-y');
        background.set_scale(1, 1);
        if (this._box) {
            this._box.disconnectObject(this);
            if (this._own && this._base)
                this._box.set_clip(...this._base);
        }
        this._box = null;
    }

    _dockClipped() {
        if (!this._box?.has_clip)
            return;
        const rect = this._box.get_clip();
        if (this._own && rect.every((v, i) => v === this._own[i]))
            return;
        this._base = rect;
        this._own = null;
        this._clip();
    }

    _clip() {
        if (!this._box || !this._base || !this.background)
            return;
        const [x, y, w, h] = this._base;
        const length = this._vertical ? this.background.height : this.background.width;
        const scale = this._vertical ? this.background.scale_y : this.background.scale_x;
        const half = Math.ceil(Math.max(0, scale - 1) * length / 2);
        this._own = this._vertical ? [x, y - half, w, h + 2 * half] : [x - half, y, w + 2 * half, h];
        this._box.set_clip(...this._own);
    }
}

/**
 * The separators shown in the dock.
 *
 * @param {Clutter.Actor} dock
 * @returns {Clutter.Actor[]}
 */
function dockSeparators(dock) {
    const out = [];
    const walk = actor => {
        for (const child of actor.get_children()) {
            if (child.has_style_class_name?.('dash-separator')) {
                if (child.visible && child.mapped)
                    out.push(child);
            } else if (!child.has_style_class_name?.('dash-item-container')) {
                walk(child);
            }
        }
    };
    walk(dock);
    return out;
}

/**
 * The dock's background: Dash to Dock's dash keeps it in a "dash-background" widget, a sibling of
 * the scroll view, so it is not clipped with the icons.
 *
 * @param {Clutter.Actor} dock
 * @returns {Clutter.Actor|null}
 */
function dockBackground(dock) {
    const queue = [dock];
    while (queue.length) {
        const actor = queue.shift();
        if (actor.has_style_class_name?.('dash-background'))
            return actor;
        if (!actor.has_style_class_name?.('dash-item-container'))
            queue.push(...actor.get_children());
    }
    return null;
}

/**
 * The first reactive actor inside the dock, breadth first.
 *
 * @param {Clutter.Actor} dock
 * @returns {Clutter.Actor|null}
 */
function reactiveInside(dock) {
    const queue = [dock];
    while (queue.length) {
        const actor = queue.shift();
        if (actor.reactive)
            return actor;
        queue.push(...actor.get_children());
    }
    return null;
}

/**
 * The dock's icons in order (the "show applications" button and every app), each with the
 * dash item container that holds it.
 *
 * @param {Clutter.Actor} dock
 * @returns {{icon: Clutter.Actor, container: Clutter.Actor}[]}
 */
function dockIcons(dock) {
    const out = [];
    const walk = actor => {
        for (const child of actor.get_children()) {
            if (child.has_style_class_name?.('dash-item-container')) {
                const icon = child.get_first_child();
                if (icon && child.visible && child.mapped)
                    out.push({icon, container: child});
            } else {
                walk(child);
            }
        }
    };
    walk(dock);
    return out;
}
