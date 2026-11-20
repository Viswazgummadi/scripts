// SPDX-License-Identifier: GPL-3.0-or-later
// The clock block's quote moment: the top-bar clock dissolves into a quote, holds it (longer for
// longer quotes, paused while the pointer is over it), then the quote dissolves downwards and the
// clock gathers back. Shown once; nothing is kept.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {crossMist, clearAll, WIND} from './dissolve.js';

const wait = msec => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, msec, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

export class ClockQuote {
    constructor(quotes, events) {
        this._quotes = quotes;
        this._events = events;
        this._menu = Main.panel.statusArea.dateMenu;
        this._clock = this._menu._clockDisplay;
        this._box = this._clock.get_parent();
        this._dead = false;
        this._busy = false;

        // "clock": the shell theme styles (pads, highlights) it exactly like the time label it replaces
        this._quote = new St.BoxLayout({style_class: 'clock lt-quote', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._text = new St.Label({style_class: 'lt-quote-text', y_align: Clutter.ActorAlign.CENTER});
        this._by = new St.Label({style_class: 'lt-quote-by', y_align: Clutter.ActorAlign.CENTER, opacity: 170});
        this._quote.add_child(this._text);
        this._quote.add_child(this._by);
        this._box.insert_child_above(this._quote, this._clock);
    }

    _maxChars() {
        const w = Main.layoutManager.primaryMonitor?.width ?? 1920;
        return Math.max(40, Math.floor(w * 0.40 / 7.5));
    }

    async play() {
        if (this._busy || this._dead)
            return;
        const q = this._quotes.pickFitting(this._maxChars(), new Date(), this._events?.today() ?? []);
        if (!q)
            return;
        this._busy = true;
        try {
            this._text.text = q.by ? `“${q.text}”` : q.text;
            this._by.text = q.by ? `— ${q.by}` : '';
            this._by.visible = Boolean(q.by);

            await crossMist(this._box, this._clock, this._quote, () => {
                this._clock.visible = false;
                this._quote.visible = true;
            }, {duration: 460, alive: () => !this._dead});
            if (this._dead)
                return;

            // hold: ~4 s + 55 ms per character, max 12 s; paused while hovered
            let left = Math.min(12000, 4000 + 55 * q.text.length);
            while (left > 0 && !this._dead) {
                await wait(250);
                if (!this._menu.hover)
                    left -= 250;
            }
            if (this._dead)
                return;

            await crossMist(this._box, this._quote, this._clock, () => {
                this._quote.visible = false;
                this._clock.visible = true;
            }, {outStyle: WIND.down, duration: 620, alive: () => !this._dead});
        } catch (e) {
            console.error(`lucent-tiles: quote: ${e.message}`);
            if (!this._dead) {
                this._quote.visible = false;
                this._restore();
            }
        } finally {
            this._busy = false;
        }
    }

    _restore() {
        this._clock.visible = true;
        this._clock.opacity = 255;
        this._box.width = -1;
    }

    destroy() {
        this._dead = true;
        clearAll();
        this._quote.destroy();
        this._restore();
    }
}
