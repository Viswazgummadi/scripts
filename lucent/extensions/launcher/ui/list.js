// SPDX-License-Identifier: GPL-3.0-or-later
// The results column: Top Hit, then sections. Rows and headers come from pools and are reused
// across keystrokes (no actor churn while typing). One highlight actor slides between rows.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {makeIcon} from './icons.js';
import {tn} from '../core/gtype.js';

const ICON = 24;
const TOP_ICON = 40;

function markupSnippet(s) {
    // \u0001..\u0002 delimit the matched words from the index snippet
    return GLib.markup_escape_text(s, -1).replace(/\u0001/g, '<b>').replace(/\u0002/g, '</b>');
}

const Row = GObject.registerClass({GTypeName: tn('Row')},
class Row extends St.BoxLayout {
    _init(list) {
        super._init({style_class: 'sl-row', reactive: true, track_hover: true, x_expand: true});
        this._list = list;
        this.result = null;
        this._iconBin = new St.Bin({style_class: 'sl-row-icon', y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true, style_class: 'sl-row-text'});
        this._title = new St.Label({style_class: 'sl-title', x_expand: true});
        this._sub = new St.Label({style_class: 'sl-sub', x_expand: true});
        for (const l of [this._title, this._sub]) {
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            l.clutter_text.single_line_mode = true;
        }
        text.add_child(this._title);
        text.add_child(this._sub);
        this.add_child(this._iconBin);
        this.add_child(text);

        this.connect('notify::hover', () => {
            if (this.hover)
                this._list._onHover(this);
        });
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => this._list._onClick(this));
        this.add_action(click);
    }

    set(result, top) {
        this.result = result;
        this.set_style_class_name(top ? 'sl-row sl-top' : 'sl-row');
        if (result.big)
            this.add_style_class_name('sl-big');
        this._iconBin.set_child(makeIcon(result.icon, top ? TOP_ICON : (result.big ? 30 : ICON)));
        this._title.text = result.title ?? '';
        const sub = result.subtitle ?? '';
        if (result.snippet && !top) {
            this._sub.clutter_text.set_markup(markupSnippet(result.snippet));
        } else {
            this._sub.text = top && result.kind && !result.big ? (sub ? `${result.kind} · ${sub}` : result.kind) : sub;
        }
        this._sub.visible = this._sub.text.length > 0;
        // paths lose their middle, sentences their end (like Finder)
        this._sub.clutter_text.ellipsize = !result.snippet && (sub.startsWith('~') || sub.startsWith('/')) ? Pango.EllipsizeMode.MIDDLE : Pango.EllipsizeMode.END;
        this.setSelected(false);
    }

    setSelected(on) {
        if (on) {
            this.add_style_pseudo_class('selected');
            this.style = `background-color: ${this._list.accent};`;
        } else {
            this.remove_style_pseudo_class('selected');
            this.style = null;
        }
    }
});

const Header = GObject.registerClass({GTypeName: tn('Header')},
class Header extends St.BoxLayout {
    _init(list) {
        super._init({style_class: 'sl-header', x_expand: true});
        this._label = new St.Label({style_class: 'sl-header-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._more = new St.Button({style_class: 'sl-more', label: 'Show More', can_focus: false, y_align: Clutter.ActorAlign.CENTER});
        this._more.connect('clicked', () => list._onMore(this._key));
        this.add_child(this._label);
        this.add_child(this._more);
    }

    set(key, title, more) {
        this._key = key;
        this._label.text = title;
        this._more.visible = more > 0;
    }
});

// callbacks (plain functions, not GObject signals, so null results pass through cleanly)
export const ResultList = GObject.registerClass({GTypeName: tn('ResultList')},
class ResultList extends St.ScrollView {
    _init({onActivate, onSelected, onMore}) {
        super._init({
            style_class: 'sl-list-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: false, y_expand: true,
        });
        this.accent = '#2190a4';
        this._scrollTimeline = null;
        this.connect('destroy', () => {
            this._scrollTimeline?.stop();
            this._scrollTimeline = null;
        });
        this._box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'sl-list', x_expand: true});
        this.set_child(this._box);

        this._rows = [];
        this._headers = [];
        this._items = [];        // selectable results, display order
        this._rowFor = [];       // row actor per item
        this._sectionStart = []; // item index where each section starts
        this._sel = -1;
        this._animate = false;
        this._pointerAt = null;
        this._hoverArmed = false;
        this._onActivateCb = onActivate;
        this._onSelectedCb = onSelected;
        this._onMoreCb = onMore;
    }

    get items() {
        return this._items;
    }

    get selectedIndex() {
        return this._sel;
    }

    get selected() {
        return this._items[this._sel] ?? null;
    }

    naturalHeight() {
        const [, nat] = this._box.get_preferred_height(-1);
        return nat;
    }

    _row(i) {
        while (this._rows.length <= i)
            this._rows.push(new Row(this));
        return this._rows[i];
    }

    _header(i) {
        while (this._headers.length <= i)
            this._headers.push(new Header(this));
        return this._headers[i];
    }

    // view: {top, sections}; keepId: result id to keep selected if still present
    setView(view, keepId = null) {
        this._box.remove_all_children();
        this._items = [];
        this._rowFor = [];
        this._sectionStart = [];
        let r = 0, h = 0;
        if (view.top) {
            const hd = this._header(h++);
            hd.set('top', 'Top Hit', 0);
            this._box.add_child(hd);
            const row = this._row(r++);
            row.set(view.top, true);
            this._box.add_child(row);
            this._sectionStart.push(0);
            this._items.push(view.top);
            this._rowFor.push(row);
        }
        for (const s of view.sections) {
            const hd = this._header(h++);
            hd.set(s.key, s.title, s.more);
            this._box.add_child(hd);
            this._sectionStart.push(this._items.length);
            for (const it of s.items) {
                const row = this._row(r++);
                row.set(it, false);
                this._box.add_child(row);
                this._items.push(it);
                this._rowFor.push(row);
            }
        }
        // trim pools that grew huge (browsing modes) so memory stays flat
        if (this._rows.length > 160 && r < 80) {
            for (const row of this._rows.splice(80))
                row.destroy();
        }

        let idx = keepId ? this._items.findIndex(x => x.id === keepId) : -1;
        if (idx < 0)
            idx = this._items.length ? 0 : -1;
        this._hoverArmed = false; // content moved under a still pointer: don't steal the selection
        this._pointerAt = global.get_pointer().slice(0, 2);
        this._sel = -1;
        this.select(idx, false);
        if (idx <= 0)
            this.vadjustment.value = 0;
    }

    clear() {
        this.setView({top: null, sections: []});
    }

    select(i, animate = true) {
        if (i >= this._items.length)
            i = this._items.length - 1;
        if (i < 0) {
            this._rowFor[this._sel]?.setSelected(false);
            this._sel = -1;
            this._onSelectedCb?.(null);
            return;
        }
        if (i === this._sel)
            return;
        this._rowFor[this._sel]?.setSelected(false);
        this._sel = i;
        this._rowFor[i].setSelected(true);
        this._ensureVisible(animate);
        this._onSelectedCb?.(this._items[i]);
    }

    move(delta) {
        if (!this._items.length)
            return;
        const i = Math.max(0, Math.min(this._items.length - 1, (this._sel < 0 ? 0 : this._sel) + delta));
        this.select(i);
    }

    moveSection(dir) {
        const starts = this._sectionStart;
        if (!starts.length)
            return;
        let k = 0;
        for (let j = 0; j < starts.length; j++) {
            if (starts[j] <= this._sel)
                k = j;
        }
        const next = Math.max(0, Math.min(starts.length - 1, k + dir));
        if (dir < 0 && starts[k] < this._sel)
            this.select(starts[k]);
        else
            this.select(starts[next]);
    }

    setAccent(color) {
        this.accent = color;
        this._rowFor[this._sel]?.setSelected(true);
    }

    _ensureVisible(animate) {
        const row = this._rowFor[this._sel];
        if (!row || !this.mapped)
            return;
        // get_allocation_box() brings the layout up to date first. (Selecting a row restyles it,
        // so has_allocation() is false right then, and waiting for an idle was not enough: the
        // list never scrolled to a row the keyboard moved to.)
        const adj = this.vadjustment;
        const box = row.get_allocation_box();
        // keep the section header visible when moving up to a section's first row
        const headerPad = this._sectionStart.includes(this._sel) ? 28 : 6;
        let v = adj.value;
        if (box.y1 - headerPad < v)
            v = Math.max(0, box.y1 - headerPad);
        if (this._sel === 0 || v < 16) // near the first rows the list rests exactly at its top
            v = 0;
        else if (box.y2 + 6 > v + adj.page_size)
            v = box.y2 + 6 - adj.page_size;
        if (v !== adj.value)
            this._scrollTo(v, animate ? 120 : 0);
    }

    // Scroll to `v`, eased over `ms`. A timeline on this actor drives it: an adjustment has no frame
    // clock of its own, and adjustment.ease() silently did nothing here.
    _scrollTo(v, ms) {
        const adj = this.vadjustment;
        this._scrollTimeline?.stop();
        this._scrollTimeline = null;
        if (!ms) {
            adj.value = v;
            return;
        }
        const from = adj.value;
        const tl = new Clutter.Timeline({actor: this, duration: ms, progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        tl.connect('new-frame', () => {
            adj.value = from + (v - from) * tl.get_progress();
        });
        tl.connect('stopped', () => {
            if (this._scrollTimeline === tl)
                this._scrollTimeline = null;
        });
        this._scrollTimeline = tl;
        tl.start();
    }

    _onHover(row) {
        // only real pointer motion selects (not content re-flowing under a resting pointer)
        const [x, y] = global.get_pointer();
        if (!this._hoverArmed) {
            if (this._pointerAt && Math.abs(x - this._pointerAt[0]) + Math.abs(y - this._pointerAt[1]) < 2)
                return;
            this._hoverArmed = true;
        }
        const i = this._rowFor.indexOf(row);
        if (i >= 0)
            this.select(i, true);
    }

    _onClick(row) {
        const i = this._rowFor.indexOf(row);
        if (i >= 0) {
            this.select(i, false);
            this._onActivateCb?.(this._items[i]);
        }
    }

    _onMore(key) {
        this._onMoreCb?.(key);
    }
});
