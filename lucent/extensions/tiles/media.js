// SPDX-License-Identifier: GPL-3.0-or-later
// The activity tile's popover: every media player (One UI 9 style card), plus everything else
// that's going on.
//
//   ╭──────────────────────────────────────────╮  card: the album art, darkened (layout.json
//   │ ┌──────┐ Choopultho Guchi            ⇱   │  "playerBackground": art | blur | none)
//   │ │ art  │ Chakri                          │  the track's own cover (no art: the app's
//   │ └──────┘                                 │  icon), title (scrolls when long) + artist
//   │ ▁▂▃▅▆▇▆▅▃━━━━━━━━━━━◉─────────────────── │  glass visualiser driven by the live audio,
//   │ 2:21                                5:24 │  in the album's colours; drag/click to seek
//   │   ⤨      (⏮)     (⏸)     (⏭)      ⟲      │  click the total: time remaining
//   ╰──────────────────────────────────────────╯
//   [a] Other player · Title             ⏯       click the row to switch
//   ACTIVITY
//   ⚙ llvm 42%
//   Keys while open: Space play/pause, ←/→ seek 5 s.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {accentColor, artPath, artStyle, blurredPath, paletteColors, thumbPath} from './art.js';
import {supports, markUnsupported} from './caps.js';
import {drawGlass} from './glass.js';
import {Levels} from './levels.js';
import {Marquee} from './marquee.js';

const TICK_MS = 250;
const SEEK_STEP = 5e6; // µs
const VERIFY_MS = 900; // how long a player gets to apply shuffle/repeat before we call it unsupported
const TITLE_WIDTH = 222; // 380 card − 2×20 padding − 64 art − 14 gap − open button + gap
const BG_OPACITY = 150; // album art blended into the glass (~60 %), not an opaque block

function fmt(us) {
    const s = Math.max(0, Math.floor(us / 1e6));
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function scaled(ms) {
    const s = St.Settings.get();
    if (s.reducedMotion === St.ReducedMotion.REDUCE)
        return 0;
    return s.slow_down_factor >= 0.5 ? Math.round(ms / s.slow_down_factor) : ms;
}

function button(icon, cls, onClick) {
    const b = new St.Button({
        style_class: `lt-mbtn ${cls}`,
        can_focus: true,
        child: new St.Icon({icon_name: icon}),
    });
    b.set_pivot_point(0.5, 0.5);
    b.connect('clicked', () => onClick(b));
    return b;
}

function bounce(actor) {
    if (!scaled(1))
        return;
    actor.remove_transition('scale-x');
    actor.remove_transition('scale-y');
    actor.set({scale_x: 0.86, scale_y: 0.86});
    actor.ease({scale_x: 1, scale_y: 1, duration: scaled(260), mode: Clutter.AnimationMode.EASE_OUT_BACK});
}

function appOf(st) {
    return st?.desktopEntry ? Shell.AppSystem.get_default().lookup_app(`${st.desktopEntry}.desktop`) : null;
}

function bringForward(mpris, st) {
    const app = appOf(st);
    if (app)
        app.activate();
    else
        mpris.raise(st);
}

// ---- the visualiser slider ---------------------------------------------------------------------
// GNOME's Slider (drag, scroll, keyboard, grabs) drawn by glass.js. Everything that changes
// eases per frame: the visualiser height (flat when paused or while dragging, for precision),
// the thumb size, the drag glow, the colours (on a new track) and the position (glides after a
// seek or skip instead of jumping). Frames only run while the popover is open and something moves.
const THUMB = 7, THUMB_ACTIVE = 9;
const MIN_PAINT_US = 15500; // ~60 fps cap for the visualiser

const approach = (cur, target, rate, dt) => {
    const v = cur + (target - cur) * Math.min(1, dt * rate);
    return Math.abs(v - target) < 0.002 ? target : v;
};
const mix = (a, b, rate, dt) => a.map((v, i) => approach(v, b[i], rate, dt));
const same = (a, b) => a.every((v, i) => v === b[i]);

const GlassSlider = GObject.registerClass(
class GlassSlider extends Slider.Slider {
    _init(levels) {
        super._init(0);
        this.add_style_class_name('lt-wave');
        this.track_hover = true;
        this._levels = levels;
        this._colors = paletteColors(null);
        this._colorsTo = this._colors;
        this._accent = this._colors[0];
        this._accentTo = this._accent;
        this._lv = [0, 0, 0];
        this._playing = false;
        this._dragging = false;
        this._height = 0;
        this._thumb = THUMB;
        this._halo = 0;
        this._stretch = 0; // 0..1, how fast the ring is being dragged
        this._prevShown = 0;
        this._shown = 0;
        this._t = 0;
        this._last = 0;
        this._tl = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._tl.connect('new-frame', () => this._frame());
        this.connect('drag-begin', () => {
            this._dragging = true;
            this._kick();
        });
        this.connect('drag-end', () => {
            this._dragging = false;
            this._kick();
        });
        this.connect('notify::hover', () => this._kick());
        this.connect('notify::value', () => {
            // follow the finger exactly; and while hidden there is nothing to animate
            if (this._dragging || !scaled(1) || !this._active)
                this._shown = this._value;
            this._kick();
        });
    }

    // Jump straight to the true state (used when the popover opens: it must look already in
    // sync, not catch up in front of you).
    _snap() {
        const t = this._targets();
        this._shown = this._prevShown = this._value;
        this._stretch = 0;
        this._height = t.height;
        this._thumb = t.thumb;
        this._halo = t.halo;
        this._colors = this._colorsTo;
        this._accent = this._accentTo;
    }

    setColors(colors, accent) {
        this._colorsTo = colors;
        this._accentTo = accent;
        if (!this._active || !scaled(1)) {
            this._colors = colors;
            this._accent = accent;
        }
        this._kick();
    }

    set playing(on) {
        this._playing = on;
        this._kick();
    }

    set active(on) {
        if (on && !this._active)
            this._snap();
        this._active = on;
        this._kick();
    }

    _targets() {
        return {
            // waves stay up while you drag (a softer synthetic wave if paused): the bar never goes dead
            height: !scaled(1) ? 0 : this._playing ? 1 : this._dragging ? 0.55 : 0,
            thumb: this._dragging || this.hover ? THUMB_ACTIVE : THUMB,
            halo: this._dragging ? 1 : 0,
        };
    }

    _settled() {
        const t = this._targets();
        return t.height === 0 && this._height === 0 && this._stretch === 0 && this._thumb === t.thumb && this._halo === t.halo &&
            Math.abs(this._shown - this._value) < 0.0005 &&
            same(this._accent, this._accentTo) && this._colors.every((c, i) => same(c, this._colorsTo[i]));
    }

    _kick() {
        const need = this._active && !this._settled();
        if (need && !this._tl.is_playing()) {
            this._last = GLib.get_monotonic_time();
            this._tl.start();
        } else if (!need && this._tl.is_playing()) {
            this._tl.stop();
        }
        this.queue_repaint();
    }

    _frame() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.1, (now - this._last) / 1e6);
        this._last = now;
        const t = this._targets();
        this._t += dt;
        this._height = approach(this._height, t.height, 5, dt); // ~0.4 s
        // elastic: the faster the ring moves under the finger, the more the wave swells (eases off ~0.25 s)
        const speed = Math.abs(this._shown - this._prevShown) / Math.max(dt, 1e-3) / (this._maxValue || 1);
        this._prevShown = this._shown;
        this._stretch = approach(this._stretch, this._dragging ? Math.min(1, speed * 0.9) : 0, this._dragging ? 12 : 4, dt);
        this._thumb = approach(this._thumb, t.thumb, 14, dt);
        this._halo = approach(this._halo, t.halo, 10, dt);
        this._accent = mix(this._accent, this._accentTo, 6, dt);
        this._colors = this._colors.map((c, i) => mix(c, this._colorsTo[i], 6, dt));
        // live audio levels, or a gentle synthetic motion when they aren't available
        const lv = this._levels.live
            ? [this._levels.bass, this._levels.mid, this._levels.treble]
            : [0.6 + 0.25 * Math.sin(this._t * 1.3), 0.55 + 0.3 * Math.sin(this._t * 1.7 + 1), 0.5 + 0.3 * Math.sin(this._t * 2.3 + 2)];
        // levels.js already smooths (12 ms rise / 140 ms fall); this only hides the 16 ms steps
        this._lv = mix(this._lv, lv, 40, dt);
        // beat pulse: jumps on a detected kick, decays over ~180 ms
        const since = (now - (this._levels.beatAt || 0)) / 1e6;
        this._pulse = this._levels.live && since < 0.6 ? this._levels.beatStrength * Math.exp(-since / 0.18) : 0;
        const gap = this._value - this._shown;
        this._shown = Math.abs(gap) > 0.02 ? approach(this._shown, this._value, 9, dt) : this._value;
        // redraw at most ~60 times a second, even on a faster display (state still steps every frame)
        if (now - (this._painted ?? 0) >= MIN_PAINT_US) {
            this._painted = now;
            this.queue_repaint();
        }
        if (this._settled())
            this._kick();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        drawGlass(cr, {
            w, h, value: Math.max(0, Math.min(1, this._shown / (this._maxValue || 1))),
            thumb: this._thumb, height: this._height * (1 + 0.28 * this._stretch), levels: this._lv, t: this._t,
            colors: this._colors, accent: this._accent, halo: this._halo, pulse: this._pulse ?? 0,
        });
        cr.$dispose();
    }
});

// Fades an actor out towards its bottom, so the album art melts into the popover's glass
// instead of ending in an edge.
const BottomFade = GObject.registerClass(
class BottomFade extends Clutter.ShaderEffect {
    vfunc_get_static_snippet() {
        const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, '', null);
        s.set_replace(`
            vec4 c = texture2D(cogl_sampler0, cogl_tex_coord_in[0].st);
            float a = 1.0 - smoothstep(0.55, 1.0, cogl_tex_coord_in[0].t);
            cogl_color_out = c * a * cogl_color_in.a;`);
        return s;
    }
});

// ---- the big card -----------------------------------------------------------------------------
const PlayerCard = GObject.registerClass(
class PlayerCard extends St.Widget {
    _init(mpris, levels, getBackground) {
        super._init({style_class: 'lt-card', layout_manager: new Clutter.BinLayout()});
        this._mpris = mpris;
        this._getBackground = getBackground;
        this._name = null;
        this._dragging = false;
        this._remaining = false;
        this._shownTitle = null;
        this._artUrl = undefined;

        // layers: two backdrops (cross-fade), scrim, content
        this._bgs = [0, 1].map(() => new St.Bin({style_class: 'lt-card-bg', x_expand: true, y_expand: true, opacity: 0}));
        this._bgOn = 0;
        this._scrim = new St.Widget({style_class: 'lt-card-scrim', x_expand: true, y_expand: true});
        for (const layer of [...this._bgs, this._scrim])
            layer.add_effect(new BottomFade());
        const content = new St.BoxLayout({style_class: 'lt-card-content', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        for (const a of [...this._bgs, this._scrim, content])
            this.add_child(a);

        // header: [cover]  title / artist  [open in app]
        const head = new St.BoxLayout({style_class: 'lt-card-head'});
        // the cover: two layers that cross-fade on a new track, over a tile holding the app's
        // icon for tracks without art
        this._cover = new St.Widget({style_class: 'lt-cover', layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER});
        this._appIcon = new St.Icon({style_class: 'lt-cover-icon', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._thumbs = [0, 1].map(() => new St.Bin({style_class: 'lt-cover-img', x_expand: true, y_expand: true, opacity: 0}));
        this._thumbOn = 0;
        this._thumbFor = undefined; // art path currently shown (null = none)
        this._cover.add_child(this._appIcon);
        for (const t of this._thumbs)
            this._cover.add_child(t);
        // the thumbnail is rendered for the cover's exact device pixels, known once it's on stage
        // (deferred: restyling from inside a layout pass would queue a relayout mid-allocation)
        this._thumbIdle = 0;
        const queueThumb = () => {
            if (this._thumbIdle || !this._cover.mapped)
                return;
            this._thumbIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._thumbIdle = 0;
                this._applyThumb();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._cover.connect('notify::mapped', queueThumb);
        this._cover.connect('notify::allocation', queueThumb);
        try {
            this._cover.connect('resource-scale-changed', queueThumb);
        } catch {
            // older/newer Clutter without the signal: allocation/mapped still cover the common case
        }
        this.connect('destroy', () => {
            if (this._thumbIdle)
                GLib.source_remove(this._thumbIdle);
            this._thumbIdle = 0;
            for (const id of this._verifyIds ?? [])
                GLib.source_remove(id);
            this._verifyIds = null;
        });

        this._info = new St.BoxLayout({style_class: 'lt-info', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new Marquee({width: TITLE_WIDTH, styleClass: 'lt-title'});
        this._artist = new St.Label({style_class: 'lt-sub'});
        this._artist.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        this._info.add_child(this._title);
        this._info.add_child(this._artist);

        this._open = button('send-to-symbolic', 'lt-mbtn-small', () => bringForward(this._mpris, this._st()));
        this._open.y_align = Clutter.ActorAlign.START;
        head.add_child(this._cover);
        head.add_child(this._info);
        head.add_child(this._open);
        content.add_child(head);
        this._titleRow = this._info; // what the title-change animation moves

        // visualiser + times
        this._progressBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'lt-progress'});
        this._slider = new GlassSlider(levels);
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
            const st = this._st();
            this._dragTrack = st ? `${st.name}|${st.trackId}|${st.title}` : null;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            const st = this._st();
            if (st && `${st.name}|${st.trackId}|${st.title}` === this._dragTrack)
                this._mpris.setPosition(st, this._slider.value * st.length);
            this._dragTrack = null;
            this.tick();
        });
        this._slider.connect('notify::value', () => {
            if (this._dragging)
                this.tick();
        });
        const times = new St.BoxLayout({style_class: 'lt-times'});
        this._elapsed = new St.Label({style_class: 'lt-time', x_expand: true});
        this._total = new St.Label({style_class: 'lt-time'});
        const totalBtn = new St.Button({style_class: 'lt-time-btn', child: this._total, can_focus: false});
        totalBtn.connect('clicked', () => {
            this._remaining = !this._remaining;
            this.tick();
        });
        times.add_child(this._elapsed);
        times.add_child(totalBtn);
        this._progressBox.add_child(this._slider);
        this._progressBox.add_child(times);
        content.add_child(this._progressBox);

        // controls: (shuffle)  (⏮)  (⏯)  (⏭)  (repeat): mirror-symmetric around play. A side
        // the player can't do stays as an empty slot, so play is always dead centre.
        const controls = new St.BoxLayout({style_class: 'lt-controls', x_align: Clutter.ActorAlign.CENTER});
        this._shuffle = button('media-playlist-shuffle-symbolic', 'lt-mbtn-side', b => {
            bounce(b);
            this._toggleVerified('shuffle', st => this._mpris.setShuffle(st, !st.shuffle), st => st.shuffle);
        });
        this._repeat = button('media-playlist-repeat-symbolic', 'lt-mbtn-side', b => {
            bounce(b);
            this._toggleVerified('loop', st => this._mpris.setLoop(st, {None: 'Playlist', Playlist: 'Track', Track: 'None'}[st.loop] ?? 'None'), st => st.loop);
        });
        this._prev = button('media-skip-backward-symbolic', 'lt-mbtn-circle', b => {
            bounce(b);
            this._mpris.previous(this._st());
        });
        this._play = button('media-playback-start-symbolic', 'lt-mbtn-circle lt-mbtn-play', b => {
            bounce(b);
            this._mpris.playPause(this._st());
        });
        this._next = button('media-skip-forward-symbolic', 'lt-mbtn-circle', b => {
            bounce(b);
            this._mpris.next(this._st());
        });
        // every button is a fixed square centred in the row: never stretched to the tallest one
        for (const b of [this._shuffle, this._prev, this._play, this._next, this._repeat]) {
            b.y_align = Clutter.ActorAlign.CENTER;
            b.child.x_align = b.child.y_align = Clutter.ActorAlign.CENTER;
            controls.add_child(b);
        }
        content.add_child(controls);
    }

    _st() {
        return this._name ? this._mpris.get(this._name) : null;
    }

    set active(on) {
        this._slider.active = on;
    }

    // Shuffle / repeat: some players accept a change and ignore it (Spotify). Check, and if
    // nothing happened, remember it and hide the button (keeping its space, so nothing jumps).
    _toggleVerified(feature, apply, read) {
        const st = this._st();
        if (!st)
            return;
        const before = read(st);
        apply(st);
        this._verifyIds ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_MS, () => {
            this._verifyIds.delete(id);
            const now = this._mpris.get(st.name);
            if (now && read(now) === before) {
                markUnsupported(now.identity, feature);
                if (this._st() === now)
                    this.show(now);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._verifyIds.add(id);
    }

    // Title: fade out, swap, slide up into place.
    _setTitle(title) {
        if (this._shownTitle === null || !scaled(1) || !this.mapped) {
            this._titleRow.remove_all_transitions();
            this._titleRow.opacity = 255;
            this._titleRow.translation_y = 0;
            this._title.text = title;
            this._shownTitle = title;
            return;
        }
        if (title === this._shownTitle)
            return;
        this._shownTitle = title;
        this._titleRow.remove_all_transitions();
        this._titleRow.ease({
            opacity: 0, translation_y: -4, duration: scaled(120), mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                this._title.text = title;
                this._titleRow.translation_y = 8;
                this._titleRow.ease({opacity: 255, translation_y: 0, duration: scaled(260), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            },
        });
    }

    _setBackdrop(path) {
        const mode = this._getBackground();
        let style = null;
        if (path && mode === 'blur') {
            const b = blurredPath(path);
            style = b ? artStyle(b) : null;
        } else if (path && mode === 'art') {
            style = artStyle(path);
        }
        this.set_style_class_name(`lt-card lt-card-${style ? mode : 'plain'}`);
        const key = style ?? '';
        if (key === this._bgKey)
            return;
        this._bgKey = key;
        const d = this.mapped ? scaled(320) : 0; // hidden: apply at once
        const next = this._bgs[1 - this._bgOn], cur = this._bgs[this._bgOn];
        this._bgOn = 1 - this._bgOn;
        next.remove_all_transitions();
        cur.remove_all_transitions();
        if (style) {
            next.style = style;
            next.opacity = 0;
            next.ease({opacity: BG_OPACITY, duration: d, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        cur.ease({opacity: 0, duration: d, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // The cover thumbnail: cross-fade to the new track's art (or back to the app icon tile).
    _applyThumb() {
        const path = this._artFile ?? null;
        let px = 0;
        if (path && this._cover.mapped)
            px = Math.ceil(this._cover.width * this._cover.get_resource_scale());
        if (path && !px)
            return; // not on stage yet: done when it is
        const key = path ? `${path}@${px}` : null;
        if (key === this._thumbFor)
            return;
        const first = this._thumbFor === undefined;
        this._thumbFor = key;
        const file = path ? thumbPath(path, px) : null;
        const d = this.mapped && !first ? scaled(320) : 0;
        const next = this._thumbs[1 - this._thumbOn], cur = this._thumbs[this._thumbOn];
        this._thumbOn = 1 - this._thumbOn;
        if (file) {
            next.style = artStyle(file);
            next.remove_all_transitions();
            next.opacity = 0;
            next.ease({opacity: 255, duration: d, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        cur.remove_all_transitions();
        cur.ease({opacity: 0, duration: d, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._appIcon.ease({opacity: file ? 0 : 255, duration: d, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _setArt(url) {
        url ||= null;
        if (url === this._artUrl)
            return;
        this._artUrl = url;
        artPath(url).then(path => {
            if (this._artUrl !== url)
                return;
            this._artFile = path;
            this._applyThumb();
            this._setBackdrop(path);
            const colors = paletteColors(path);
            this._slider.setColors(colors, accentColor(path) ?? colors[0]);
        });
    }

    show(st) {
        const changedPlayer = this._name !== st.name;
        this._name = st.name;
        if (changedPlayer)
            this._shownTitle = null;
        this._artist.text = st.artists.join(', ') || st.identity;
        const app = appOf(st);
        if (app)
            this._appIcon.gicon = app.get_icon();
        else
            this._appIcon.icon_name = 'audio-x-generic-symbolic';
        this._setTitle(st.title);
        this._setArt(st.artUrl);

        const playing = st.status === 'Playing';
        this._play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._play.child.translation_x = playing ? 0 : 1.5;
        this._slider.playing = playing;
        for (const [b, can] of [[this._prev, st.canPrev], [this._next, st.canNext],
            [this._play, st.canControl && (playing || st.canPlay)]]) {
            b.reactive = can;
            b.opacity = can ? 255 : 90;
        }

        // shuffle left, repeat right; unsupported ones keep their slot (invisible)
        const canShuffle = st.shuffle !== null && st.canControl && supports(st.identity, 'shuffle') !== false;
        const canLoop = st.loop !== null && st.canControl && supports(st.identity, 'loop') !== false;
        for (const [btn, can] of [[this._shuffle, canShuffle], [this._repeat, canLoop]]) {
            btn.reactive = can;
            btn.opacity = can ? 255 : 0;
        }
        this._shuffle.checked = canShuffle && Boolean(st.shuffle);
        this._repeat.child.icon_name = st.loop === 'Track' ? 'media-playlist-repeat-song-symbolic' : 'media-playlist-repeat-symbolic';
        this._repeat.checked = canLoop && (st.loop === 'Playlist' || st.loop === 'Track');
        this.tick();
    }

    tick() {
        const st = this._st();
        if (!st)
            return;
        const has = st.length > 0;
        this._progressBox.visible = has;
        if (!has)
            return;
        const pos = this._dragging ? this._slider.value * st.length : this._mpris.positionOf(st);
        if (!this._dragging)
            this._slider.value = Math.min(1, pos / st.length);
        this._slider.reactive = st.canSeek;
        this._elapsed.text = fmt(pos);
        this._total.text = this._remaining ? `-${fmt(st.length - pos)}` : fmt(st.length);
    }
});

// ---- a compact row for a non-selected player -------------------------------------------------
function compactRow(mpris, st, onSelect) {
    const row = new St.BoxLayout({style_class: 'lt-row', reactive: true, track_hover: true});
    const art = new St.Bin({style_class: 'lt-row-art'});
    artPath(st.artUrl).then(p => {
        if (p)
            art.style = artStyle(p);
    });
    const info = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const t = new St.Label({style_class: 'lt-row-title', text: st.title});
    const s = new St.Label({style_class: 'lt-row-sub', text: [st.identity, st.artists[0]].filter(Boolean).join(' · ')});
    t.clutter_text.ellipsize = 3;
    s.clutter_text.ellipsize = 3;
    info.add_child(t);
    info.add_child(s);
    const play = button(st.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
        'lt-mbtn-small', b => {
            bounce(b);
            mpris.playPause(st);
        });
    row.add_child(art);
    row.add_child(info);
    row.add_child(play);
    for (const a of [art, info]) {
        a.reactive = true; // the click to switch players lives here (the play button handles its own)
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => onSelect(st.name));
        a.add_action(click);
    }
    return row;
}

export const MediaPanel = GObject.registerClass(
class MediaPanel extends St.BoxLayout {
    _init(mpris, getActivities, getBackground = () => 'art') {
        super._init({style_class: 'lt-pop', orientation: Clutter.Orientation.VERTICAL});
        this._mpris = mpris;
        this._getActivities = getActivities;
        this._selected = null;
        this._open = false;
        this._levels = new Levels();

        this._card = new PlayerCard(mpris, this._levels, getBackground);
        this._others = new St.BoxLayout({style_class: 'lt-others', orientation: Clutter.Orientation.VERTICAL});
        this._actHeader = new St.Label({style_class: 'lt-section', text: 'ACTIVITY'});
        this._acts = new St.BoxLayout({style_class: 'lt-acts', orientation: Clutter.Orientation.VERTICAL});
        this._empty = new St.Label({style_class: 'lt-empty', text: 'Nothing playing'});
        for (const a of [this._card, this._others, this._empty, this._actHeader, this._acts])
            this.add_child(a);
        this._timer = 0;
        this._othersKey = '';
        this.connect('destroy', () => this.stop());
    }

    start() {
        this._open = true;
        this.refresh();
        this._card.tick(); // position as of this very moment, before the first frame
        this._card.active = true;
        if (!this._timer) {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                this._card.tick();
                return GLib.SOURCE_CONTINUE;
            });
        }
        this._mpris.syncPosition(this._current());
    }

    stop() {
        this._open = false;
        this._card.active = false;
        this._levels.stop();
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _current() {
        const players = this._mpris.players;
        return players.find(p => p.name === this._selected) ?? players[0] ?? null;
    }

    refresh() {
        const players = this._mpris.players;
        const cur = this._current();
        this._card.visible = Boolean(cur);
        if (cur)
            this._card.show(cur);
        // listen to the audio only while the popover is open and something plays
        if (this._open && cur?.status === 'Playing')
            this._levels.start();
        else
            this._levels.stop();

        // rebuild the other-player rows only when something about them changed
        const others = players.filter(p => p !== cur);
        const key = others.map(p => `${p.name}|${p.title}|${p.status}|${p.artUrl}`).join('\n');
        if (key !== this._othersKey) {
            this._othersKey = key;
            this._others.destroy_all_children();
            for (const p of others) {
                this._others.add_child(compactRow(this._mpris, p, name => {
                    this._selected = name;
                    this.refresh();
                }));
            }
        }
        this._others.visible = others.length > 0;

        if (!this._open)
            return; // the card above is kept current while closed; the rest is built on open
        const acts = this._getActivities();
        this._acts.destroy_all_children();
        for (const a of acts) {
            const row = new St.BoxLayout({style_class: 'lt-act'});
            row.add_child(new St.Icon({icon_name: a.icon, style_class: 'lt-act-icon'}));
            const l = new St.Label({text: a.text, style_class: 'lt-act-text', y_align: Clutter.ActorAlign.CENTER});
            l.clutter_text.ellipsize = 3;
            row.add_child(l);
            if (a.failed)
                row.add_style_class_name('lt-alarm');
            this._acts.add_child(row);
        }
        this._actHeader.visible = this._acts.visible = acts.length > 0;
        this._empty.visible = !cur && acts.length === 0;
    }

    // Space / ← / → while the popover is open.
    handleKey(keyval) {
        const st = this._current();
        if (!st)
            return false;
        if (keyval === Clutter.KEY_space) {
            this._mpris.playPause(st);
            return true;
        }
        if (keyval === Clutter.KEY_Left || keyval === Clutter.KEY_Right) {
            this._mpris.seekBy(st, keyval === Clutter.KEY_Left ? -SEEK_STEP : SEEK_STEP);
            this._card.tick();
            return true;
        }
        return false;
    }
});

