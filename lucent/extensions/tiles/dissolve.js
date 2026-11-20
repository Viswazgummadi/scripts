// SPDX-License-Identifier: GPL-3.0-or-later
// The one transition every block uses: the same "mist" dissolve as Lucent Dissolve's window close,
// tuned for small text. Out = the element drifts with the wind and scatters into mist;
// in = the same thing played backwards (the element gathers out of the mist).
//
// Like Lucent Dissolve, it runs on a temporary overlay in Main.uiGroup that holds a live clone of the
// element (so the mist can leave the 32 px top bar), while the real element is made see-through.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EFFECT = 'lt-mist';

const DECL = `
uniform float progress;
uniform vec2 size;
uniform vec4 win;      // element rect inside the overlay (px)
uniform vec2 wind;     // drift direction (tex y points down)
uniform float travel;  // px a typical grain drifts
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

// Lucent Dissolve's mist shader with grain sizes scaled down for text.
const CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 lpx = uv * size - win.xy;

float n = vnoise(lpx / 28.0);
float t = clamp(progress * 1.3 - n * 0.3, 0.0, 1.0);
float e = t * t * (3.0 - 2.0 * t);

float speed = mix(0.7, 1.3, vnoise(lpx / vec2(5.0, 2.5)));
vec2 scatter = vec2(vnoise(lpx / 1.4), vnoise(lpx / 1.4 + 17.0)) - 0.5;
vec2 d = wind * travel * speed * pow(t, 1.5) + scatter * 6.0 * e;
vec2 src = lpx - d;

vec4 color = vec4(0.0);
if (src.x >= 0.0 && src.y >= 0.0 && src.x < win.z && src.y < win.w) {
    color = texture2D(cogl_sampler0, (src + win.xy) / size);
    float mist = mix(1.0, smoothstep(0.15, 0.85, vnoise(src * 1.2)), smoothstep(0.05, 0.7, t));
    color *= (1.0 - smoothstep(0.1, 1.0, t)) * mist;
}
cogl_color_out = color * cogl_color_in.a;
`;

const MistEffect = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.float('progress', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class MistEffect extends Clutter.ShaderEffect {
    _init(w, h, rect, wind, travel, progress) {
        super._init({name: EFFECT});
        this._progress = progress;
        this.set_uniform_float('size', 2, [Math.max(w, 1), Math.max(h, 1)]);
        this.set_uniform_float('win', 4, rect);
        this.set_uniform_float('wind', 2, wind);
        this.set_uniform_float('travel', 1, [travel]);
        this.set_uniform_float('progress', 1, [progress]);
    }

    vfunc_get_static_snippet() {
        const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECL, null);
        s.set_replace(CODE);
        return s;
    }

    get progress() {
        return this._progress;
    }

    set progress(v) {
        if (this._progress === v)
            return;
        this._progress = v;
        this.set_uniform_float('progress', 1, [v]);
        this.queue_repaint();
        this.notify('progress');
    }
});

// Just Perfection's animation speed scales every ease(); keep our own timing (as Lucent Dissolve can).
function ms(v) {
    const f = St.Settings.get().slow_down_factor;
    return f >= 0.5 ? Math.round(v / f) : v;
}

function plain() {
    return St.Settings.get().reducedMotion === St.ReducedMotion.REDUCE ||
        St.Settings.get().slow_down_factor < 0.5;
}

export const WIND = {
    away: {wind: [0.92, -0.39], travel: 16, margin: {left: 4, right: 30, top: 10, bottom: 4}},
    down: {wind: [0.25, 0.97], travel: 46, margin: {left: 6, right: 20, top: 4, bottom: 64}},
};

const live = new Set();

// Dissolve `actor` out (dir 'out') or in (dir 'in'). Resolves when done. The real actor ends
// at opacity 0 after 'out' and 255 after 'in'.
export function mist(actor, dir, {duration = 420, style = WIND.away} = {}) {
    return new Promise(resolve => {
        const [w, h] = actor.get_transformed_size();
        if (!actor.mapped || w < 1 || h < 1 || plain()) {
            actor.ease({
                opacity: dir === 'out' ? 0 : 255,
                duration: plain() ? 150 : ms(duration),
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                onStopped: () => resolve(),
            });
            return;
        }
        const [x, y] = actor.get_transformed_position();
        const m = style.margin;
        const W = Math.ceil(w + m.left + m.right), H = Math.ceil(h + m.top + m.bottom);
        const overlay = new Clutter.Actor({x: Math.floor(x - m.left), y: Math.floor(y - m.top), width: W, height: H});
        overlay.add_child(new Clutter.Clone({source: actor, x: m.left, y: m.top, width: w, height: h}));
        overlay.add_effect(new MistEffect(W, H, [m.left, m.top, w, h], style.wind, style.travel,
            dir === 'out' ? 0 : 1));
        Main.uiGroup.add_child(overlay);
        live.add(overlay);
        actor.opacity = 0; // the clone still paints it

        let finished = false;
        let sid = 0;
        const finish = actorGone => {
            if (finished)
                return;
            finished = true;
            if (!actorGone) {
                actor.disconnect(sid);
                if (dir === 'in')
                    actor.opacity = 255;
            }
            live.delete(overlay);
            overlay.destroy();
            resolve();
        };
        sid = actor.connect('destroy', () => finish(true));
        // clearAll() destroys overlays directly: treat that as finished too
        overlay.connect('destroy', () => finish(false));
        overlay.ease_property(`@effects.${EFFECT}.progress`, dir === 'out' ? 1 : 0, {
            duration: ms(duration),
            mode: dir === 'out' ? Clutter.AnimationMode.LINEAR : Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => finish(false),
        });
        // Follow the element while the panel slides it around (tiles resizing next to it).
        overlay.get_transition(`@effects.${EFFECT}.progress`)?.connect('new-frame', () => {
            if (finished || !actor.mapped)
                return;
            const [nx, ny] = actor.get_transformed_position();
            overlay.set_position(Math.floor(nx - m.left), Math.floor(ny - m.top));
        });
    });
}

// Smoothly animate a container's width to its new natural width (after its content changed).
export function settleWidth(box, fromWidth, duration = 220) {
    return new Promise(resolve => {
        box.width = -1;
        const [, to] = box.get_preferred_width(-1);
        if (!fromWidth || Math.abs(to - fromWidth) < 1 || plain()) {
            resolve();
            return;
        }
        box.width = fromWidth;
        box.ease({
            width: to,
            duration: ms(duration),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                box.width = -1;
                resolve();
            },
        });
    });
}

// Wait for the next allocation so transformed positions are current.
export function nextFrame() {
    return new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));
}

// Swap `oldActor` for `newActor` inside `box`: mist out, swap, mist in (the mist follows the
// element if the panel slides it). `swapIn()` must make newActor present and
// oldActor absent. `settle`: animate `box`'s own width (for boxes that aren't a fluid Tile).
// `alive()` is checked after every step, so a block destroyed mid-transition stops cleanly.
// Resolves true when it ran to the end.
export async function crossMist(box, oldActor, newActor, swapIn,
    {outStyle = WIND.away, duration = 380, alive = () => true, settle = true} = {}) {
    const fromWidth = box.width;
    if (oldActor?.visible)
        await mist(oldActor, 'out', {duration: Math.round(duration * 0.85), style: outStyle});
    if (!alive())
        return false;
    newActor.opacity = 0;
    swapIn();
    // A plain box squeezes its children while its width animates, so let it settle first;
    // a Tile keeps content at full size, so its mist-in overlaps the resize.
    if (settle)
        await settleWidth(box, fromWidth, 280);
    await nextFrame();
    if (!alive())
        return false;
    await mist(newActor, 'in', {duration});
    return alive();
}

// Remove any overlays still on screen (disable()).
export function clearAll() {
    for (const o of live)
        o.destroy();
    live.clear();
}
