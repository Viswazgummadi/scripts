// SPDX-License-Identifier: GPL-3.0-or-later
// Lucent Dissolve: replaces the window-close animation.
//
// How it hooks in. GNOME's window manager, in its close path and nowhere else, adds the window
// actor to its `_destroying` set and then immediately calls `actor.ease(...)` with its own
// shrink-and-fade. We watch that set; when an actor is added we swap that one `ease()` call for
// our animation and hand GNOME's completion callback through unchanged. All of GNOME's own
// bookkeeping stays as it is, so a window can never be left half closed, and no method of the
// window manager is replaced (other extensions that patch it are not disturbed).
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {cleanUp, playClose, warmUpActors} from './effects.js';

const WARM_UP_DELAY_MS = 3000;
const WARM_UP_HOLD_MS = 500;
const MIN_SPEED_FACTOR = 0.5;

export default class LucentDissolveExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._running = new Set();
        this._warmId = 0;
        this._warm = [];

        const closing = Main.wm._destroying;
        if (!(closing instanceof Set)) {
            console.warn(`${this.uuid}: this GNOME Shell closes windows differently; leaving its animation alone`);
            return;
        }
        this._closing = closing;
        const arm = actor => this._arm(actor);
        closing.add = function (actor) {
            arm(actor);
            return Set.prototype.add.call(this, actor);
        };

        // Compile the shaders shortly after login, not during the first close.
        this._warmId = GLib.timeout_add(GLib.PRIORITY_LOW, WARM_UP_DELAY_MS, () => {
            this._warm = warmUpActors();
            for (const actor of this._warm)
                Main.uiGroup.add_child(actor);
            this._warmId = GLib.timeout_add(GLib.PRIORITY_LOW, WARM_UP_HOLD_MS, () => {
                this._warmId = 0;
                this._clearWarmUp();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._warmId)
            GLib.source_remove(this._warmId);
        this._warmId = 0;
        this._clearWarmUp();
        if (this._closing)
            delete this._closing.add;
        this._closing = null;
        // Let windows that are closing right now finish at once.
        for (const finish of [...this._running])
            finish();
        this._running = null;
        this._settings = null;
    }

    _clearWarmUp() {
        for (const actor of this._warm)
            actor.destroy();
        this._warm = [];
    }

    // Replace only the very next ease() on this actor, which is GNOME's close animation.
    _arm(actor) {
        const type = actor.meta_window?.get_window_type();
        const isDialog = type === Meta.WindowType.DIALOG || type === Meta.WindowType.MODAL_DIALOG;
        if (!isDialog && type !== Meta.WindowType.NORMAL)
            return;

        actor.ease = params => {
            delete actor.ease;
            try {
                this._play(actor, isDialog, params.onStopped);
            } catch (e) {
                console.warn(`${this.uuid}: falling back to the standard animation: ${e.message}`);
                cleanUp(actor);
                actor.ease(params);
            }
        };
    }

    _play(actor, isDialog, onStopped) {
        const st = St.Settings.get();
        const reduceMotion = st.reducedMotion === St.ReducedMotion.REDUCE;
        let style = this._settings.get_string('style');
        if (reduceMotion)
            style = 'fade';
        else if (style === 'random')
            style = Math.random() < 0.5 ? 'mist' : 'pixels';

        // Clutter multiplies every duration by the desktop's animation speed factor. Undo that
        // when asked to, except when the factor says "almost no animation": that wish wins.
        let duration = this._settings.get_int('duration');
        if (this._settings.get_boolean('keep-own-timing') && st.slow_down_factor >= MIN_SPEED_FACTOR)
            duration = Math.round(duration / st.slow_down_factor);

        let finish = null;
        const done = () => {
            this._running?.delete(finish);
            onStopped?.();
        };
        finish = playClose(actor, {style, duration, isDialog, reduceMotion, onStopped: done});
        this._running.add(finish);
    }
}
