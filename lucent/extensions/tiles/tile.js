// SPDX-License-Identifier: GPL-3.0-or-later
// Tile: a top-bar button whose width is fluid.
//
// Whenever its content's natural width changes (new text, a different face, a new activity),
// the tile eases from its old width to the new one instead of jumping, so the panel lays its
// neighbours out again on every frame and they slide smoothly. Showing/hiding works the same
// way: the tile grows out of zero width while its content gathers out of the mist, and back.
// The content is always allocated at its full natural size, centred and clipped, so text never
// squashes or ellipsizes mid-animation.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {mist} from './dissolve.js';

export const timing = {resizeMs: 280, revealMs: 320};

function scaled(ms) {
    const s = St.Settings.get();
    if (s.reducedMotion === St.ReducedMotion.REDUCE)
        return 0;
    // Just Perfection's speed scales every ease(); keep our own timing
    return s.slow_down_factor >= 0.5 ? Math.round(ms / s.slow_down_factor) : 0;
}

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

export const Tile = GObject.registerClass(
class Tile extends PanelMenu.Button {
    _init(name, {menu = false} = {}) {
        super._init(0.5, name, !menu);
        this.add_style_class_name('lt-tile');
        this.clip_to_allocation = true;
        this._animW = -1;     // width being animated (-1 = follow content)
        this._target = null;  // last natural width seen
        this._reveal = 1;     // 0..1 multiplier used to grow/shrink in and out
        this._tweens = new Map();
        this._dead = false;
        this._want = true;
        this._animating = false;
        this._laterId = 0;
        this.connect('destroy', () => {
            this._dead = true;
            for (const tl of this._tweens.values())
                tl.stop();
            this._tweens.clear();
            if (this._laterId)
                global.compositor.get_laters().remove(this._laterId);
        });
    }

    get alive() {
        return !this._dead;
    }

    vfunc_get_preferred_width(forHeight) {
        const [min, nat] = super.vfunc_get_preferred_width(forHeight);
        if (this._target !== nat)
            this._targetChanged(nat);
        const w = (this._animW >= 0 ? this._animW : nat) * this._reveal;
        // natural = animated width; minimum stays GNOME's, so a crowded panel can still squeeze us
        return [Math.min(min, w), w];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const child = this.get_first_child();
        if (!child)
            return;
        const [, natW] = child.get_preferred_width(-1);
        const cb = new Clutter.ActorBox();
        cb.x1 = Math.round((box.get_width() - natW) / 2);
        cb.x2 = cb.x1 + natW;
        cb.y1 = 0;
        cb.y2 = box.get_height();
        child.allocate(cb);
    }

    _targetChanged(nat) {
        const prev = this._target;
        this._target = nat;
        if (prev === null || !this.mapped || this._reveal === 0 || !scaled(timing.resizeMs))
            return; // first layout / hidden: just take the new size
        // Can't start animations inside layout; do it right before the next frame.
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            if (this._dead)
                return GLib.SOURCE_REMOVE;
            const from = this._animW >= 0 ? this._animW : prev;
            const to = this._target;
            this._animW = from;
            this._tween('w', from, to, scaled(timing.resizeMs), v => {
                this._animW = v;
                this.queue_relayout();
            }).then(done => {
                if (done && !this._dead) {
                    this._animW = -1;
                    this.queue_relayout();
                }
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    // Eases a number with a Clutter timeline (frame-synced). Resolves true when it completed,
    // false when it was replaced by a newer tween of the same key.
    _tween(key, from, to, ms, set) {
        this._tweens.get(key)?.stop();
        if (!ms) {
            set(to);
            return Promise.resolve(true);
        }
        return new Promise(resolve => {
            const tl = new Clutter.Timeline({actor: this, duration: ms});
            tl.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            tl.connect('new-frame', () => set(from + (to - from) * tl.get_progress()));
            tl.connect('stopped', (t, finished) => {
                if (this._tweens.get(key) === tl)
                    this._tweens.delete(key);
                if (finished)
                    set(to);
                resolve(finished);
            });
            this._tweens.set(key, tl);
            tl.start();
        });
    }

    _setReveal(v) {
        this._reveal = v;
        this.queue_relayout();
    }

    // Show or hide the tile, fluidly. Repeated calls just update the wanted state.
    async setShown(shown, content) {
        this._want = shown;
        if (this._animating)
            return;
        this._animating = true;
        try {
            while (!this._dead && this.container.visible !== this._want) {
                const ms = scaled(timing.revealMs);
                if (this._want) {
                    content.opacity = 0;
                    this._setReveal(0);
                    this.container.show();
                    const grow = this._tween('r', 0, 1, ms, v => this._setReveal(v));
                    await wait(ms * 0.35);
                    if (!this._dead)
                        await mist(content, 'in');
                    await grow;
                } else {
                    await mist(content, 'out', {duration: 300});
                    if (!this._dead)
                        await this._tween('r', this._reveal, 0, ms, v => this._setReveal(v));
                    if (!this._dead) {
                        this.container.hide();
                        content.opacity = 255;
                        this._setReveal(1);
                    }
                }
            }
        } finally {
            this._animating = false;
        }
    }
});
