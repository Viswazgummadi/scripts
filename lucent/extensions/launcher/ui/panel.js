// SPDX-License-Identifier: GPL-3.0-or-later
// The launcher panel: a glass capsule that grows into results and a preview.
//
//  root (full stage, catches clicks outside)
//   └ panel ─┬ shadow, hairline           (soft drop shadow + dark outer hairline)
//            ├ glass                      (blurred live backdrop, rounded)
//            ├ content ─┬ bar             [⌕] [chip] entry+ghost [toast] [cats]
//            │          ├ separator
//            │          └ body ─ list │ preview
//            └ rim                        (1 px light edge)
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Glass, edgeFade, onPixel, roundCorners} from './glass.js';
import {ResultList} from './list.js';
import {Preview} from './preview.js';
import {completion} from '../core/fuzzy.js';
import {copyFiles, copyImage, copyText, openUri, quickLook, reveal, spawn} from '../core/util.js';
import {webSearchUrl} from '../providers/web.js';

const BAR_H = 56;
const RADIUS = 28;
const LIST_W = 340;
const MIN_BODY = 300;
const MAX_BODY = 440;
// How long an emptied list waits for slower sources before the panel shrinks to the bar.
const COLLAPSE_GRACE_MS = 180;

const ACCENTS = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800', orange: '#ed5b00',
    red: '#e62d42', pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
};

const MODES = [
    {key: 'apps', label: 'Apps', icon: 'view-app-grid-symbolic', placeholder: 'Search Apps'},
    {key: 'files', label: 'Files', icon: 'folder-symbolic', placeholder: 'Search Files'},
    {key: 'actions', label: 'Actions', icon: 'bolt-symbolic', fallback: 'system-run-symbolic', placeholder: 'Search Actions'},
    {key: 'clipboard', label: 'Clipboard', icon: 'edit-paste-symbolic', placeholder: 'Search Clipboard'},
];

function ms(v, cfg) {
    if (cfg?.animations === false)
        return 0;
    const s = St.Settings.get();
    if (s.enable_animations === false)
        return 0;
    // Just Perfection scales every ease(); keep our own timing (like close-fade/panel-blocks)
    return s.slow_down_factor >= 0.5 ? Math.round(v / s.slow_down_factor) : v;
}

export class LauncherPanel {
    constructor({config, engine}) {
        this._config = config;
        this._engine = engine;
        this._built = false;
        this._open = false;
        this._grab = null;
        this._mode = null;
        this._view = null;
        this._targetHeight = BAR_H;
        this._userMoved = false;
        this._remember = null;
        this._ghostFor = null;
        this._toastTimer = 0;
        this._collapseTimer = 0;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        St.Settings.get().connectObject('notify::high-contrast', () => this._applyTheme(), this);
        this._iface.connectObject('changed::accent-color', () => this._applyTheme(),
            'changed::color-scheme', () => this._applyTheme(), this);
    }

    get isOpen() {
        return this._open;
    }

    // ---- construction (lazy: nothing exists until the first open) ------------------------------
    _build() {
        if (this._built)
            return;
        this._built = true;
        const cfg = this._config.v;

        this._root = new St.Widget({style_class: 'sl-root', reactive: true, visible: false, x: 0, y: 0});
        Main.layoutManager.uiGroup.add_child(this._root);
        // click outside the panel closes; inside, this gesture never competes with rows/buttons
        const outsidePanel = () => {
            const [x, y] = global.get_pointer();
            const [px, py] = this._panel.get_transformed_position();
            const [pw, ph] = this._panel.get_transformed_size();
            return x < px || y < py || x > px + pw || y > py + ph;
        };
        const outside = new Clutter.ClickGesture();
        outside.connect('may-recognize', () => outsidePanel());
        outside.connect('recognize', () => {
            if (outsidePanel())
                this.close();
        });
        this._root.add_action(outside);

        this._panel = new St.Widget({style_class: 'sl-panel', name: 'lucent-launcher-panel', layout_manager: new Clutter.BinLayout(), reactive: true,
            width: cfg.width ?? 760, height: BAR_H, pivot_point: new Graphene.Point({x: 0.5, y: 0.0})});
        this._shadow = new St.Widget({style_class: 'sl-shadow', x_expand: true, y_expand: true});
        this._hairline = new St.Widget({style_class: 'sl-hairline', x_expand: true, y_expand: true});
        this._glass = new Glass();
        this._rim = new St.Widget({style_class: 'sl-rim', x_expand: true, y_expand: true});
        this._content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true,
            clip_to_allocation: true, style_class: 'sl-content'});

        // bar
        this._bar = new St.BoxLayout({style_class: 'sl-bar', x_expand: true});
        this._searchIcon = new St.Icon({icon_name: 'system-search-symbolic', style_class: 'sl-search-icon', y_align: Clutter.ActorAlign.CENTER});
        this._chip = new St.Label({style_class: 'sl-chip', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._entryWrap = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._entry = new St.Entry({style_class: 'sl-entry', hint_text: 'Search', x_expand: true, can_focus: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._entry.clutter_text.single_line_mode = true;
        this._ghost = new St.Label({style_class: 'sl-ghost', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER,
            reactive: false, visible: false});
        this._ghost.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._entryWrap.add_child(this._entry);
        this._entryWrap.add_child(this._ghost);
        this._toast = new St.Label({style_class: 'sl-toast', opacity: 0, y_align: Clutter.ActorAlign.CENTER});
        this._cats = new St.BoxLayout({style_class: 'sl-cats', y_align: Clutter.ActorAlign.CENTER});
        this._catButtons = new Map();
        for (const m of MODES) {
            const b = new St.Button({style_class: 'sl-cat', can_focus: false, toggle_mode: false,
                child: new St.Icon({icon_name: m.icon, fallback_icon_name: m.fallback ?? null, style_class: 'sl-cat-icon'})});
            b.connect('clicked', () => this.setMode(this._mode === m.key ? null : m.key));
            this._catButtons.set(m.key, b);
            this._cats.add_child(b);
        }
        for (const a of [this._searchIcon, this._chip, this._entryWrap, this._toast, this._cats])
            this._bar.add_child(a);

        this._sep = new St.Widget({style_class: 'sl-sep', x_expand: true, visible: false});
        this._body = new St.BoxLayout({style_class: 'sl-body', x_expand: true, visible: false});
        this._list = new ResultList({
            onActivate: r => this._activate(r, {}),
            onSelected: r => this._preview.show(r),
            onMore: key => this._engine.expand(key),
        });
        this._list.set_width(LIST_W);
        edgeFade(this._list);
        this._vsep = new St.Widget({style_class: 'sl-vsep', y_expand: true});
        this._preview = new Preview();
        this._body.add_child(this._list);
        this._body.add_child(this._vsep);
        this._body.add_child(this._preview);

        this._content.add_child(this._bar);
        this._content.add_child(this._sep);
        this._content.add_child(this._body);

        for (const a of [this._shadow, this._hairline, this._glass, this._content, this._rim])
            this._panel.add_child(a);
        // the content is cut by the same shape as the glass, so nothing (a selected row, a
        // picture) can show past the corners
        roundCorners(this._content, RADIUS);
        this._root.add_child(this._panel);

        // typing
        this._entry.clutter_text.connect('text-changed', () => this._onText());
        this._entry.clutter_text.connect('cursor-changed', () => this._placeGhost());
        this._keys = new Clutter.KeyController();
        this._keys.connect('key-press', () => this._onKey());
        this._entry.add_action_full('sl-keys', Clutter.EventPhase.CAPTURE, this._keys);

        this._applyTheme();
    }

    _applyTheme() {
        if (!this._built)
            return;
        const cfg = this._config.v;
        const scheme = cfg.theme === 'auto' || !cfg.theme ? (this._iface.get_string('color-scheme') === 'prefer-light' || this._iface.get_string('color-scheme') === 'default' ? 'light' : 'dark') : cfg.theme;
        const dark = scheme !== 'light';
        const g = cfg.glass ?? {};
        // High contrast asks for solid surfaces: the panel becomes nearly opaque and plain.
        const highContrast = St.Settings.get().high_contrast;
        const liquid = (g.style ?? 'liquid') === 'liquid' && !highContrast;
        this._root.set_style_class_name(`sl-root ${dark ? 'sl-dark' : 'sl-light'}${liquid ? ' sl-liquid' : ''}`);
        let accent = ACCENTS.blue;
        try {
            accent = ACCENTS[this._iface.get_string('accent-color')] ?? ACCENTS.blue;
        } catch {
            accent = ACCENTS.blue;
        }
        this._accent = accent;
        this._list.setAccent(accent);
        this._chip.style = `background-color: ${accent};`;
        // liquid glass is clearer than frosted: less tint and blur, a little more colour
        const tintA = highContrast ? 0.96 : Math.max(0, Math.min(1, liquid ? g.liquidTint ?? 0.36 : g.tint ?? 0.5));
        this._glass.configure({
            radius: RADIUS,
            tint: dark ? [0.11, 0.11, 0.12, tintA] : [0.97, 0.97, 0.98, Math.min(1, tintA + 0.2)],
            sat: liquid ? g.liquidSaturation ?? 1.8 : g.saturation ?? 1.7,
            // liquid glass is clearer: less blur, and the edge does the work
            blur: liquid ? g.liquidBlur ?? 18 : g.blur ?? 64,
            // the edge is always drawn by the shader, on the same shape as the glass; frosted and
            // high contrast get the rim line only
            liquid: liquid ? {
                band: 26, refraction: g.refraction ?? 26, dispersion: 0.3,
                rim: dark ? 0.65 : 0.9, glow: dark ? 0.07 : 0.09,
            } : {band: 0, refraction: 0, dispersion: 0, rim: highContrast ? 0.9 : dark ? 0.35 : 0.7, glow: 0},
        });
        if (this._open)
            this._position();
    }

    configChanged() {
        if (!this._built)
            return;
        this._panel.width = this._config.v.width ?? 760;
        this._applyTheme();
    }

    _position() {
        const mon = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        // every edge on a whole device pixel, so opposite edges are drawn alike (see onPixel)
        const s = this._scale = global.display.get_monitor_scale(mon.index) || 1;
        const w = onPixel(Math.min(this._config.v.width ?? 760, mon.width - 32), s);
        this._panel.width = w;
        const x = onPixel(mon.x + (mon.width - w) / 2, s);
        const y = onPixel(mon.y + mon.height * Math.max(0.05, Math.min(0.5, this._config.v.top ?? 0.2)), s);
        this._panel.set_position(x, y);
        this._glass.setOrigin(x, y);
        this._maxBody = Math.min(MAX_BODY, mon.y + mon.height - y - BAR_H - 40);
    }

    // ---- open / close ----------------------------------------------------------------------------
    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._open)
            return;
        this._build();
        this._open = true;
        this._root.set_size(global.stage.width, global.stage.height);
        Main.layoutManager.uiGroup.set_child_above_sibling(this._root, null);
        this._position();
        this._glass.build();
        this._root.show();

        // GNOME 51's own dialogs trust pushModal the same way (Clutter.Grab has no state query)
        if (Main.overview.visible)
            Main.overview.hide();
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
        this._engine.open();

        // reopen with the last query selected (macOS keeps it), unless it is stale
        const keep = this._remember && Date.now() - this._remember.at < (this._config.v.rememberQuerySeconds ?? 600) * 1000;
        this._mode = keep ? this._remember.mode : null;
        this._syncMode();
        this._settingText = true;
        this._entry.text = keep ? this._remember.text : '';
        this._settingText = false;
        this._entry.grab_key_focus();
        if (keep && this._entry.text)
            this._entry.clutter_text.set_selection(0, this._entry.text.length);
        this._search();

        this._panel.remove_all_transitions();
        this._panel.opacity = 0;
        this._panel.scale_x = this._panel.scale_y = 0.965;
        this._panel.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: ms(170, this._config.v), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (finished)
                    this._repaintAll();
            }});
    }

    close() {
        if (!this._open)
            return;
        this._open = false;
        this._remember = {text: this._entry.text, mode: this._mode, at: Date.now()};
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._engine.close();
        this._clearCollapse();
        this._panel.remove_all_transitions();
        this._panel.ease({
            opacity: 0, scale_x: 0.985, scale_y: 0.985, duration: ms(120, this._config.v), mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (this._open)
                    return;
                this._root.hide();
                this._glass.teardown();
                // drop heavy things (window clones, images) but keep the cheap row pool
                this._preview.show(null);
                this._list.clear();
                this._panel.height = BAR_H;
                this._targetHeight = BAR_H;
                this._sep.hide();
                this._body.hide();
            },
        });
    }

    // ---- query -------------------------------------------------------------------------------------
    setMode(mode) {
        this._mode = mode;
        this._syncMode();
        this._search();
        this._entry.grab_key_focus();
    }

    _syncMode() {
        const m = MODES.find(x => x.key === this._mode);
        this._chip.visible = Boolean(m);
        this._chip.text = m?.label ?? '';
        this._entry.hint_text = m?.placeholder ?? 'Search';
        for (const [k, b] of this._catButtons) {
            if (k === this._mode)
                b.add_style_pseudo_class('checked');
            else
                b.remove_style_pseudo_class('checked');
        }
        this._syncCats();
    }

    _syncCats() {
        const show = !this._entry.text;
        this._cats.ease({opacity: show ? 255 : 0, duration: ms(120, this._config.v), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._cats.reactive = show;
    }

    _onText() {
        if (this._settingText)
            return;
        this._userMoved = false;
        this._syncCats();
        this._search();
    }

    _search() {
        this._ghost.hide();
        this._engine.search(this._entry.text, this._mode);
    }

    // engine → UI
    onView(view) {
        if (!this._built || !this._open)
            return;
        this._view = view;
        const keepId = this._userMoved ? this._list.selected?.id : null;
        const has = !view.empty;
        // When the results go away while they are on show, they stay and fade out as the panel
        // folds up (cleared when it has); emptying them at once left a blank slab of glass folding.
        if (has || !this._body.visible) {
            this._list.setView(view, keepId);
            if (!has)
                this._preview.show(null);
        }
        this._updateGhost();
        // "No Results" only once every source has answered; until then keep the panel as it is,
        // so typing does not flash it shut and open again while slower sources are still out.
        const q = view.query.raw.trim();
        if (!has && (q || this._mode) && !view.pending)
            this._showToast('No Results', 0);
        else if (this._toast.text === 'No Results')
            this._showToast('', 0);
        this._clearCollapse();
        if (!has && view.pending && this._body.visible) {
            this._collapseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COLLAPSE_GRACE_MS, () => {
                this._collapseTimer = 0;
                this._resize(false);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._resize(has);
    }

    // The screen is only redrawn where the compositor believes something changed. After the panel
    // has changed size, part of where it was could be left out, and over a still desktop (nothing
    // else repainting there) the old panel stayed on screen as a ghost; screenshots and recordings
    // render the whole frame afresh, so they never showed it. One full repaint once it settles.
    _repaintAll() {
        this._root?.queue_redraw();
        global.stage.queue_redraw();
    }

    _clearCollapse() {
        if (this._collapseTimer) {
            GLib.source_remove(this._collapseTimer);
            this._collapseTimer = 0;
        }
    }

    _resize(has) {
        let target = BAR_H;
        if (has) {
            const nat = this._list.naturalHeight() + 16;
            let bodyH = Math.round(Math.max(MIN_BODY, Math.min(this._maxBody ?? MAX_BODY, nat)));
            // the panel's bottom edge on a whole device pixel too
            bodyH = onPixel(BAR_H + 1 + bodyH, this._scale ?? 1) - BAR_H - 1;
            this._body.height = bodyH;
            target = BAR_H + 1 + bodyH;
            this._sep.show();
            this._body.show();
        }
        for (const a of [this._sep, this._body]) {
            a.remove_transition('opacity');
            if (has)
                a.opacity = 255;
        }
        // compare with where the panel is going, not where it is mid-animation: otherwise a shrink
        // that just started is left running when results come back, and they end up hidden
        if (Math.abs(this._targetHeight - target) < 1 && (has || !this._body.visible))
            return;
        this._targetHeight = target;
        this._panel.remove_transition('height');
        const duration = ms(has ? 220 : 160, this._config.v);
        if (!has) {
            for (const a of [this._sep, this._body])
                a.ease({opacity: 0, duration: Math.round(duration * 0.8), mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._panel.ease({
            height: target, duration, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: finished => {
                if (finished)
                    this._repaintAll();
                if (finished && !has) {
                    this._sep.hide();
                    this._body.hide();
                    this._sep.opacity = this._body.opacity = 255;
                    // now that it is folded away, show what the engine last said: nothing
                    if (this._view?.empty) {
                        this._list.setView(this._view);
                        this._preview.show(null);
                    }
                }
            },
        });
    }

    // ---- ghost completion ("saf|ari — Application") ------------------------------------------------
    _updateGhost() {
        const text = this._entry.text;
        const top = this._view?.top;
        this._ghostFor = null;
        if (!text || !top || this._list.selectedIndex > 0 || top.big) {
            this._ghost.hide();
            return;
        }
        const rest = completion(text, top.completion ?? top.title);
        const kind = top.kind ? ` — ${top.kind}` : '';
        if (!rest && !kind) {
            this._ghost.hide();
            return;
        }
        this._ghostFor = rest ? text + rest : null;
        const esc = s => GLib.markup_escape_text(s, -1);
        // The typed text is laid out again, invisible, in front of the suggestion: in the entry's
        // own font it ends exactly where the entry's text ends, at any scale, with no measuring.
        this._ghost.clutter_text.set_markup(`<span alpha="1">${esc(text)}</span>${esc(rest)}<span alpha="55%">${esc(kind)}</span>`);
        this._ghost.show();
        this._placeGhost();
    }

    _placeGhost() {
        if (!this._ghost.visible)
            return;
        const later = global.compositor.get_laters();
        if (this._ghostLater)
            return;
        this._ghostLater = later.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._ghostLater = 0;
            const ct = this._entry.clutter_text;
            const len = ct.text.length;
            const atEnd = this._caretAtEnd();
            const [ok, cx] = ct.position_to_coords(len);
            if (!ok || !atEnd || !ct.has_allocation()) {
                this._ghost.opacity = 0;
                return GLib.SOURCE_REMOVE;
            }
            // The ghost starts where the entry's text starts. When the text has scrolled (it is wider
            // than the entry) the two no longer line up, and there is no room to suggest anyway.
            const ctBox = ct.get_allocation_box();
            const enBox = this._entry.get_allocation_box();
            const room = ctBox.get_width() - cx;
            this._ghost.translation_x = enBox.x1 + ctBox.x1;
            this._ghost.width = ctBox.get_width();
            this._ghost.opacity = room > 24 ? 255 : 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _caretAtEnd() {
        const ct = this._entry.clutter_text;
        const len = ct.text.length;
        const pos = ct.get_cursor_position();
        const bound = ct.get_selection_bound();
        return (pos === -1 || pos === len) && (bound === -1 || bound === pos || bound === len);
    }

    _acceptGhost() {
        if (!this._ghostFor)
            return false;
        this._entry.text = this._ghostFor;
        this._entry.clutter_text.set_cursor_position(-1);
        this._entry.clutter_text.set_selection_bound(-1);
        return true;
    }

    // ---- actions -------------------------------------------------------------------------------------
    _activate(r, {ctrl = false}) {
        if (!r)
            return;
        this._engine.learn(r);
        const fn = ctrl && r.secondary ? r.secondary : r.activate;
        this.close();
        try {
            fn?.();
        } catch (e) {
            Main.notifyError('Lucent Launcher', e.message);
        }
    }

    _copy(r) {
        const data = r?.copy?.();
        if (!data)
            return;
        if (data.uris)
            copyFiles(data.uris);
        else if (data.imagePath)
            copyImage(data.imagePath);
        else if (data.text !== undefined)
            copyText(data.text);
        this._showToast('Copied', 1200);
    }

    _showToast(text, ms_ = 1200) {
        if (this._toastTimer) {
            GLib.source_remove(this._toastTimer);
            this._toastTimer = 0;
        }
        if (!text) {
            this._toast.ease({opacity: 0, duration: 120});
            return;
        }
        this._toast.text = text;
        this._toast.ease({opacity: 255, duration: 120});
        if (ms_ > 0) {
            this._toastTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms_, () => {
                this._toastTimer = 0;
                this._toast.ease({opacity: 0, duration: 200});
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _webSearch() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        this.close();
        openUri(webSearchUrl(this._config, text));
    }

    _onKey() {
        const [, sym] = this._keys.get_key();
        const [, pressed, latched, locked] = this._keys.get_state();
        const state = pressed | latched | locked;
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const STOP = Clutter.EVENT_STOP;
        // results that are fading out with the panel are no longer the answer to what is typed
        const r = this._view?.empty ? null : this._list.selected;
        const ct = this._entry.clutter_text;
        const moved = () => {
            this._userMoved = true;
            this._updateGhost();
            return STOP;
        };

        switch (sym) {
        case Clutter.KEY_Escape:
            if (this._entry.text || this._mode) {
                this._mode = null;
                this._syncMode();
                this._entry.text = '';
                return STOP;
            }
            this.close();
            return STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            if (ctrl)
                this._list.moveSection(1);
            else
                this._list.move(1);
            return moved();
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            if (ctrl)
                this._list.moveSection(-1);
            else
                this._list.move(-1);
            return moved();
        case Clutter.KEY_Page_Down:
            this._list.move(8);
            return moved();
        case Clutter.KEY_Page_Up:
            this._list.move(-8);
            return moved();
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activate(r, {ctrl});
            return STOP;
        case Clutter.KEY_Tab:
            if (!shift && this._acceptGhost())
                return STOP;
            this._list.move(shift ? -1 : 1);
            return moved();
        case Clutter.KEY_ISO_Left_Tab:
            this._list.move(-1);
            return moved();
        case Clutter.KEY_Right:
            if (!ctrl && !shift && this._caretAtEnd() && this._acceptGhost())
                return STOP;
            return Clutter.EVENT_PROPAGATE;
        case Clutter.KEY_BackSpace:
            if (!this._entry.text && this._mode) {
                this.setMode(null);
                return STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        case Clutter.KEY_Delete:
            if (shift && r) {
                if (r.remove)
                    r.remove();
                else
                    this._engine.frecency.forget(r.id);
                this._search();
                return STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (ctrl) {
            switch (sym) {
            case Clutter.KEY_n:
                this._list.move(1);
                return moved();
            case Clutter.KEY_p:
                this._list.move(-1);
                return moved();
            case Clutter.KEY_c:
            case Clutter.KEY_C:
                if (ct.get_selection()) // copying typed text stays normal
                    return Clutter.EVENT_PROPAGATE;
                if (shift && r?.copyPath) {
                    const d = r.copyPath();
                    copyText(d.text);
                    this._showToast('Path Copied');
                } else {
                    this._copy(r);
                }
                return STOP;
            case Clutter.KEY_y:
            case Clutter.KEY_Y:
                if (r?.quickLook)
                    r.quickLook();
                return STOP;
            case Clutter.KEY_r:
            case Clutter.KEY_R:
                if (r?.reveal) {
                    this.close();
                    reveal(r.reveal);
                }
                return STOP;
            case Clutter.KEY_b:
            case Clutter.KEY_B:
                this._webSearch();
                return STOP;
            case Clutter.KEY_comma:
                this.close();
                spawn(['gio', 'open', GLib.build_filenamev([GLib.get_user_config_dir(), 'lucent-launcher', 'config.json'])]);
                return STOP;
            case Clutter.KEY_1: case Clutter.KEY_2: case Clutter.KEY_3: case Clutter.KEY_4: {
                const m = MODES[sym - Clutter.KEY_1].key;
                this.setMode(this._mode === m ? null : m);
                return STOP;
            }
            case Clutter.KEY_0:
                this.setMode(null);
                return STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- hooks for automated tests (see debug() in extension.js) ---------------------------------
    devState() {
        const v = this._view;
        return {
            open: this._open,
            text: this._built ? this._entry.text : '',
            mode: this._mode,
            selected: this._list?.selected?.title ?? null,
            ghost: this._ghost?.visible ? this._ghost.text : null,
            height: this._panel?.height,
            pending: v?.pending ?? false,
            pendingIds: [...(this._engine?._pending ?? [])],
            glassBox: this._glass ? (() => {
                const g = this._glass;
                const [ok, box] = g.get_paint_box();
                const fx = g.get_effect('sl-glass-mask');
                const [tx, ty] = g.get_transformed_position();
                const [tw, th] = g.get_transformed_size();
                return {paint: ok ? [box.x1, box.y1, box.x2, box.y2] : null, actor: [tx, ty, tw, th], target: fx?.get_target_size?.() ?? null};
            })() : null,
            listScroll: this._list ? (() => {
                const a = this._list.vadjustment;
                const fx = this._list.get_effect('sl-edge-fade');
                return {value: a?.value, upper: a?.upper, page: a?.page_size, fade: fx?.enabled ?? null, h: this._list.height};
            })() : null,
            top: v?.top ? `${v.top.title} [${v.top.section}] ${Math.round(v.top._final)}` : null,
            sections: (v?.sections ?? []).map(s => ({title: s.title, items: s.items.map(i => `${i.title} · ${i.subtitle ?? ''} (${Math.round(i._final)})`)})),
        };
    }

    devType(text) {
        if (!this._open)
            this.open();
        this._entry.text = text;
    }

    devKey(name) {
        const map = {down: [Clutter.KEY_Down], up: [Clutter.KEY_Up], tab: [Clutter.KEY_Tab]};
        if (name === 'down' || name === 'up') {
            this._list.move(name === 'down' ? 1 : -1);
            this._userMoved = true;
            this._updateGhost();
        } else if (name === 'tab') {
            this._acceptGhost();
        } else if (/^mode:/.test(name)) {
            this.setMode(name.slice(5) || null);
        }
        return map[name] ?? null;
    }

    panelRect(margin = 40) {
        if (!this._built)
            return null;
        const [x, y] = this._panel.get_transformed_position();
        const [w, h] = this._panel.get_transformed_size();
        return [Math.max(0, Math.round(x - margin)), Math.max(0, Math.round(y - margin)), Math.round(w + 2 * margin), Math.round(h + 2 * margin)];
    }

    destroy() {
        this._iface?.disconnectObject(this);
        St.Settings.get().disconnectObject(this);
        if (this._toastTimer)
            GLib.source_remove(this._toastTimer);
        this._clearCollapse();
        if (this._ghostLater)
            global.compositor.get_laters().remove(this._ghostLater);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._glass?.teardown();
        this._root?.destroy();
        this._root = null;
        this._built = false;
        this._open = false;
    }
}

