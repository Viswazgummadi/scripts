// SPDX-License-Identifier: GPL-3.0-or-later
// Marquee: a fixed-width text strip. Text that fits sits still; text that doesn't scrolls
// left in a seamless loop like a music player's display: hold 1.5 s, scroll at an even speed,
// loop around (a second copy follows the first), hold again. The edges fade softly (the left
// one only once the text is moving). Pausable (e.g. while the pointer is on the tile).
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const SPEED = 32;      // px per second
const HOLD_MS = 1500;  // pause at the start of every loop
const GAP = 36;        // px between the end of the text and its next copy
const FADE = 14;       // px edge fade

const FadeEffect = GObject.registerClass(
class FadeEffect extends Clutter.ShaderEffect {
    _init() {
        super._init();
        this.setEdges(1, 0, FADE);
    }

    vfunc_get_static_snippet() {
        const decl = 'uniform float width; uniform float left; uniform float right;';
        const code = `
            vec4 c = texture2D(cogl_sampler0, cogl_tex_coord_in[0].st);
            float x = cogl_tex_coord_in[0].s * width;
            float a = (left > 0.0 ? smoothstep(0.0, left, x) : 1.0) *
                      (right > 0.0 ? smoothstep(0.0, right, width - x) : 1.0);
            cogl_color_out = c * a * cogl_color_in.a;`;
        const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, null);
        s.set_replace(code);
        return s;
    }

    setEdges(width, left, right) {
        this.set_uniform_float('width', 1, [Math.max(1, width)]);
        this.set_uniform_float('left', 1, [left]);
        this.set_uniform_float('right', 1, [right]);
        this.queue_repaint();
    }
});

function scaled(ms) {
    const f = St.Settings.get().slow_down_factor;
    return f >= 0.5 ? Math.round(ms / f) : ms;
}

export const Marquee = GObject.registerClass(
class Marquee extends St.Widget {
    // fit: shrink to the text when it's shorter than `width` (so it can be centred)
    _init({width = 180, styleClass = 'lt-value', fit = false} = {}) {
        super._init({clip_to_allocation: true, y_expand: true, style_class: 'lt-marquee'});
        this._w = width;
        this._fit = fit;
        this._text = null;
        this._overflow = false;
        this._paused = false;
        this._holdId = 0;

        this._row = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._a = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._b = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._spacer = new St.Widget({width: GAP, visible: false});
        this._row.add_child(this._a);
        this._row.add_child(this._spacer);
        this._row.add_child(this._b);
        this.add_child(this._row);

        this._fade = new FadeEffect();
        this._fade.enabled = false;
        this.add_effect(this._fade);
        this._row.connect('notify::translation-x', () => this._updateFade());
        // text can only be measured on stage; (re)measure when shown and when the font changes
        this._pending = false;
        this.connect('notify::mapped', () => {
            if (this.mapped && this._pending)
                this._restart();
        });
        this._a.connect('style-changed', () => this._restart());
        this.connect('destroy', () => this._stop());
    }

    get text() {
        return this._text;
    }

    set text(t) {
        if (t === this._text)
            return;
        this._text = t;
        this._a.text = t;
        this._b.text = t;
        this._restart();
    }

    set textWidth(w) {
        if (w === this._w)
            return;
        this._w = w;
        this.queue_relayout();
        this._restart();
    }

    // still: rest at the start of the text, no scrolling (e.g. while the player is paused)
    set still(v) {
        if (Boolean(v) === Boolean(this._still))
            return;
        this._still = Boolean(v);
        this._restart();
    }

    set paused(p) {
        this._paused = p;
        const tr = this._row.get_transition('translation-x');
        if (!tr)
            return;
        if (p)
            tr.pause();
        else
            tr.start();
    }

    // The fixed width (the tile never changes size because of its text), or with `fit` the
    // text's own width when that is smaller.
    vfunc_get_preferred_width() {
        let w = this._w;
        if (this._fit && this.get_stage())
            w = Math.min(w, Math.ceil(this._a.get_preferred_width(-1)[1]));
        return [w, w];
    }

    vfunc_get_preferred_height() {
        return this._a.get_preferred_height(-1);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [, natW] = this._row.get_preferred_width(-1);
        const [, natH] = this._row.get_preferred_height(-1);
        const cb = new Clutter.ActorBox();
        const textW = this._a.get_preferred_width(-1)[1];
        // text that fits is left-aligned in the strip
        cb.x1 = 0;
        cb.x2 = Math.max(natW, textW);
        cb.y1 = Math.floor((box.get_height() - natH) / 2);
        cb.y2 = cb.y1 + natH;
        this._row.allocate(cb);
    }

    _updateFade() {
        if (!this._overflow)
            return;
        const moved = Math.min(FADE, -this._row.translation_x);
        this._fade.setEdges(this._w, Math.max(0, moved), FADE);
    }

    _stop() {
        if (this._holdId)
            GLib.source_remove(this._holdId);
        this._holdId = 0;
        this._row.remove_transition('translation-x');
        this._row.translation_x = 0;
    }

    _restart() {
        this._stop();
        if (!this.mapped) {
            this._pending = true;
            return;
        }
        this._pending = false;
        const [, textW] = this._a.get_preferred_width(-1);
        this._overflow = textW > this._w + 0.5 && St.Settings.get().reducedMotion !== St.ReducedMotion.REDUCE;
        this._b.visible = this._spacer.visible = this._overflow;
        this._fade.enabled = this._overflow;
        if (!this._overflow)
            return;
        this._fade.setEdges(this._w, 0, FADE);
        if (!this._still)
            this._loop(textW + GAP);
    }

    _loop(distance) {
        this._holdId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
            this._holdId = 0;
            this._row.ease({
                translation_x: -distance,
                duration: scaled(Math.round(distance / SPEED * 1000)),
                mode: Clutter.AnimationMode.LINEAR,
                onStopped: finished => {
                    if (!finished)
                        return;
                    this._row.translation_x = 0; // the copy is now exactly where the original started
                    this._loop(distance);
                },
            });
            if (this._paused)
                this._row.get_transition('translation-x')?.pause();
            return GLib.SOURCE_REMOVE;
        });
    }
});
