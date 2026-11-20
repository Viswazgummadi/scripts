// SPDX-License-Identifier: GPL-3.0-or-later
// Activity tile: what you're doing right now (build, download, long command, the current player).
//   - constant width: text that doesn't fit scrolls like a player's display (marquee.js)
//   - several at once: the most important one, and every 6 s it dissolves to the next
//   - any open player (playing or paused) keeps the tile on the bar
//   - hover and/or click (layout.json "playerOpen": both | hover | click): popover with every
//     player (full controls) + the activity list; a hover-opened popover closes once the pointer
//     has left both the tile and the popover for a moment
//   - middle-click: play/pause the current player
//   - hidden when nothing is going on: it grows out of / shrinks into nothing, fluidly
//   - builds also notify "done" / "failed"
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ActivityWatcher} from './activity.js';
import {crossMist} from './dissolve.js';
import {MediaPanel} from './media.js';
import {Marquee} from './marquee.js';
import {fmtDuration} from './ninja.js';
import {Notifier} from './notify.js';
import {Tile} from './tile.js';

const ROTATE_SEC = 6;
const HOVER_CLOSE_MS = 400; // pointer away from tile + popover this long: close a hover-opened popover
const POINTER_POLL_MS = 120;
const POINTER_SLACK = 10;   // px of forgiveness around the tile and the popover

function makeFace(width) {
    const box = new St.BoxLayout({style_class: 'lt-face lt-activity', y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({style_class: 'lt-activity-icon', y_align: Clutter.ActorAlign.CENTER});
    const marquee = new Marquee({width, styleClass: 'lt-value'});
    box.add_child(icon);
    box.add_child(marquee);
    return {box, icon, marquee};
}

export const ActivityBlock = GObject.registerClass(
class ActivityBlock extends Tile {
    _init(getTextWidth = () => 130, getBackground = () => 'art', getOpenMode = () => ({mode: 'both', delay: 150})) {
        super._init('Activity', {menu: true});
        this._getTextWidth = getTextWidth;
        this._getOpenMode = getOpenMode;
        this._hoverOpenId = 0;
        this._pollId = 0;
        this._byHover = false;
        this._awayMs = 0;
        this._suppressHover = false;
        this._box = new St.BoxLayout({style_class: 'lt-block', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._box);
        this._face = makeFace(this._getTextWidth());
        this._box.add_child(this._face.box);
        this.connect('notify::hover', () => (this._face.marquee.paused = this.hover));
        this._currentId = null;
        this._list = [];
        this._shownAt = 0;
        this._busy = false;
        this._notifier = new Notifier('Builds', 'system-run-symbolic');

        this._watcher = new ActivityWatcher({
            onChange: list => this._update(list),
            onBuildFinished: (b, ok, sec) => this._notifier.show({
                title: `${b.name} ${ok ? 'done' : 'failed'}`,
                body: `${fmtDuration(sec)} · ${b.done} steps${b.targets.length ? ` · ${b.targets.join(' ')}` : ''}`,
                iconName: ok ? 'system-run-symbolic' : 'dialog-error-symbolic',
            }),
        });

        // popover
        this.menu.box.add_style_class_name('lt-menu');
        this._panel = new MediaPanel(this._watcher.mpris, () => this._watcher.others, getBackground);
        this.menu.box.add_child(this._panel);
        this.menu.connect('open-state-changed', (m, open) => {
            if (open) {
                this._panel.start();
            } else {
                this._stopPoll();
                this._byHover = false;
                this._panel.stop();
                if (!this._list.length)
                    this.setShown(false, this._box);
            }
        });
        this.menu.actor.connect('key-press-event', (a, ev) =>
            this._panel.handleKey(ev.get_key_symbol()) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);

        // the popover opens on the primary button only, so middle-click can be play/pause
        if (this._clickGesture)
            this._clickGesture.required_button = Clutter.BUTTON_PRIMARY;
        // middle-click: play/pause
        const middle = new Clutter.ClickGesture({required_button: Clutter.BUTTON_MIDDLE});
        middle.connect('recognize', () => this._watcher.mpris?.playPause());
        this.add_action(middle);

        // hover to open
        this.connect('notify::hover', () => this._onHover());
        this._clickGesture?.connect('recognize', () => {
            // a click decides: the popover stays until clicked away, and the hover that is
            // still going on must not reopen it right after a click closed it
            this._cancelHoverOpen();
            this._byHover = false;
            this._suppressHover = true;
        });
        this.applyConfig();

        this.connect('destroy', () => {
            this._cancelHoverOpen();
            this._stopPoll();
            this._watcher.destroy();
            this._notifier.destroy();
        });
    }

    _mode() {
        const {mode} = this._getOpenMode();
        return ['both', 'hover', 'click'].includes(mode) ? mode : 'both';
    }

    _onHover() {
        if (!this.hover) {
            this._suppressHover = false;
            this._cancelHoverOpen();
            return;
        }
        if (this._mode() === 'click' || this._suppressHover || this.menu.isOpen || !this.container.visible)
            return;
        this._cancelHoverOpen();
        const delay = Math.max(0, Number(this._getOpenMode().delay) || 0);
        this._hoverOpenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hoverOpenId = 0;
            if (this.hover && !this.menu.isOpen) {
                this._byHover = true;
                this.menu.open({animate: true});
                this._startPoll();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHoverOpen() {
        if (this._hoverOpenId)
            GLib.source_remove(this._hoverOpenId);
        this._hoverOpenId = 0;
    }

    // While a hover-opened popover is up the menu holds the pointer grab, so crossing events
    // can't be trusted: check where the pointer is instead.
    _startPoll() {
        this._stopPoll();
        this._awayMs = 0;
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_POLL_MS, () => {
            if (!this.menu.isOpen || !this._byHover) {
                this._pollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const [px, py] = global.get_pointer();
            const inside = [this, this.menu.actor].some(a => {
                if (!a.mapped)
                    return false;
                const [x, y] = a.get_transformed_position();
                const [w, h] = a.get_transformed_size();
                return px >= x - POINTER_SLACK && px <= x + w + POINTER_SLACK &&
                    py >= y - POINTER_SLACK && py <= y + h + POINTER_SLACK;
            });
            this._awayMs = inside ? 0 : this._awayMs + POINTER_POLL_MS;
            if (this._awayMs >= HOVER_CLOSE_MS) {
                this._pollId = 0;
                this.menu.close({animate: true});
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPoll() {
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollId = 0;
    }

    // The layout manager asks whether this tile wants to be on the panel right now.
    get active() {
        return this._list.length > 0;
    }

    _fill(face, a) {
        face.icon.icon_name = a.icon;
        face.marquee.text = a.text;
        face.marquee.still = Boolean(a.paused); // paused: rest at the start of the text
        for (const [cls, on] of [['lt-alarm', a.failed], ['lt-dim', a.paused]]) {
            if (on)
                face.box.add_style_class_name(cls);
            else
                face.box.remove_style_class_name(cls);
        }
    }

    _update(list) {
        this._list = list;
        this._panel.refresh(); // closed: updates the card silently, so opening shows it already in sync
        if (!list.length) {
            this._currentId = null;
            if (!this.menu.isOpen)
                this.setShown(false, this._box);
            return;
        }
        let next = list.find(a => a.id === this._currentId);
        // a more important newcomer takes over at once; otherwise rotate every ROTATE_SEC
        if (!next || list[0].priority > next.priority)
            next = list[0];
        else if (list.length > 1 && Date.now() - this._shownAt >= ROTATE_SEC * 1000)
            next = list[(list.indexOf(next) + 1) % list.length];

        if (!this.container.visible || this._currentId === null) {
            this._currentId = next.id;
            this._shownAt = Date.now();
            this._fill(this._face, next);
            this.setShown(true, this._box);
        } else if (next.id === this._currentId) {
            this._fill(this._face, next); // live numbers / play state: the tile resizes itself smoothly
        } else {
            this._swap(next);
        }
    }

    // layout.json changed
    applyConfig() {
        this._face.marquee.textWidth = this._getTextWidth();
        // "hover" only: clicking the tile does nothing (middle-click still plays/pauses)
        if (this._clickGesture)
            this._clickGesture.enabled = this._mode() !== 'hover';
    }

    async _swap(a) {
        if (this._busy)
            return;
        this._busy = true;
        this._shownAt = Date.now();
        this._currentId = a.id;
        const old = this._face;
        const face = makeFace(this._getTextWidth());
        this._fill(face, a);
        try {
            const done = await crossMist(this._box, old.box, face.box, () => {
                this._box.remove_child(old.box);
                old.box.destroy();
                this._box.add_child(face.box);
                this._face = face;
            }, {alive: () => this.alive, settle: false});
            const latest = done && this._list.find(x => x.id === this._currentId);
            if (latest)
                this._fill(this._face, latest);
        } catch (e) {
            console.error(`lucent-tiles: ${e.message}`);
        }
        this._busy = false;
    }
});
