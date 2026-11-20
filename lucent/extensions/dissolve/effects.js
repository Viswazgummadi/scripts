// SPDX-License-Identifier: GPL-3.0-or-later
// The close animations of Lucent Dissolve: two fragment shaders and a plain fade.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

const SHADER_NAME = 'lucent-dissolve-shader';
const BLUR_NAME = 'lucent-dissolve-blur';

// Dialogs are small: they get a shorter version of the same animation.
const DIALOG_FACTOR = 0.43;
const FADE = {scale: 0.92, drift: 10, blur: 10};
const FADE_DIALOG = {scale: 0.95, drift: 0, blur: 6};

// How far a typical grain of mist travels, and how much room around the window it may fly into.
const MIST_TRAVEL = 55;
const MIST_MARGIN = {left: 12, right: 100, top: 60, bottom: 16};

const COMMON_DECL = `
uniform float progress;
uniform vec2 size;
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
`;

const MIST_DECL = `${COMMON_DECL}
uniform vec4 win;          // window rectangle inside the stage: x, y, w, h (px)
const float TRAVEL = ${MIST_TRAVEL.toFixed(1)};
const vec2 WIND = vec2(0.92, -0.39);   // right and up (texture y points down)

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

// Every pixel follows one smooth curve: it drifts with the wind, scatters into a fine mist and
// fades, all at once. Soft noise puts some areas slightly ahead of others.
const MIST_CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 lpx = uv * size - win.xy;     // window-local pixels

float n = vnoise(lpx / 110.0);
float t = clamp(progress * 1.3 - n * 0.3, 0.0, 1.0);
float e = t * t * (3.0 - 2.0 * t);

float speed = mix(0.7, 1.3, vnoise(lpx / vec2(12.0, 5.0)));
vec2 scatter = vec2(vnoise(lpx / 2.5), vnoise(lpx / 2.5 + 17.0)) - 0.5;
vec2 d = WIND * TRAVEL * speed * pow(t, 1.5) + scatter * 14.0 * e;
d.y -= 10.0 * e * vnoise(lpx / 30.0 + 5.0);
vec2 src = lpx - d;

vec4 color = vec4(0.0);
if (src.x >= 0.0 && src.y >= 0.0 && src.x < win.z && src.y < win.w) {
    color = texture2D(cogl_sampler0, (src + win.xy) / size);
    float mist = mix(1.0, smoothstep(0.15, 0.85, vnoise(src * 0.7)), smoothstep(0.05, 0.7, t));
    color *= (1.0 - smoothstep(0.1, 1.0, t)) * mist;
}
cogl_color_out = color * cogl_color_in.a;
`;

const PIXELS_DECL = `${COMMON_DECL}
const float BLOCK = 16.0;
`;

// The window turns blocky, then the blocks flash and blink out in random order, top first.
const PIXELS_CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 px = uv * size;
vec2 cell = floor(px / BLOCK);
vec2 center = (cell + 0.5) * BLOCK / size;

float chunky = smoothstep(0.0, 0.2, progress);
vec2 fineCell = floor(px / 5.0);
vec2 midUV = (fineCell + 0.5) * 5.0 / size;
vec2 suv = chunky < 0.5 ? mix(uv, midUV, chunky * 2.0) : mix(midUV, center, chunky * 2.0 - 1.0);
vec4 color = texture2D(cogl_sampler0, suv);

float die = 0.18 + 0.78 * (hash(cell) * 0.8 + (1.0 - uv.y) * 0.2);
float left = die - progress;
if (left <= 0.0) {
    color = vec4(0.0);
} else {
    float flash = 1.0 - smoothstep(0.0, 0.05, left);
    color.rgb = mix(color.rgb, vec3(color.a), flash * 0.75);
    vec2 g = fract(px / BLOCK);
    float line = step(g.x, 0.06) + step(g.y, 0.06);
    color.rgb *= 1.0 - 0.18 * chunky * min(line, 1.0);
}
cogl_color_out = color * cogl_color_in.a;
`;

const ProgressShader = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.float('progress', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class ProgressShader extends Clutter.ShaderEffect {
    _init(decl, code, width, height) {
        super._init({name: SHADER_NAME});
        this._decl = decl;
        this._code = code;
        this._progress = 0;
        this.set_uniform_float('size', 2, [Math.max(width, 1), Math.max(height, 1)]);
        this.set_uniform_float('progress', 1, [0]);
    }

    vfunc_get_static_snippet() {
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, this._decl, null);
        snippet.set_replace(this._code);
        return snippet;
    }

    get progress() {
        return this._progress;
    }

    set progress(value) {
        if (this._progress === value)
            return;
        this._progress = value;
        this.set_uniform_float('progress', 1, [value]);
        this.queue_repaint();
        this.notify('progress');
    }
});

// One class per style: Clutter caches the compiled snippet per class.
const MistShader = GObject.registerClass(
class MistShader extends ProgressShader {
    _init(width, height, windowRect) {
        super._init(MIST_DECL, MIST_CODE, width, height);
        this.set_uniform_float('win', 4, windowRect);
    }
});

const PixelsShader = GObject.registerClass(
class PixelsShader extends ProgressShader {
    _init(width, height) {
        super._init(PIXELS_DECL, PIXELS_CODE, width, height);
    }
});

/**
 * Two tiny actors that carry the shaders, so the GPU driver compiles them before the first
 * window closes instead of during it. The caller adds them to the stage and destroys them.
 *
 * @returns {Clutter.Actor[]}
 */
export function warmUpActors() {
    const mist = new Clutter.Actor({width: 4, height: 4, opacity: 1});
    mist.add_effect(new MistShader(4, 4, [0, 0, 4, 4]));
    const pixels = new Clutter.Actor({width: 4, height: 4, opacity: 1});
    pixels.add_effect(new PixelsShader(4, 4));
    return [mist, pixels];
}

/**
 * Play a close animation on a window actor.
 *
 * @param {Meta.WindowActor} actor - the closing window
 * @param {object} options
 * @param {string} options.style - 'mist', 'pixels' or 'fade'
 * @param {number} options.duration - milliseconds, already adjusted for the animation speed
 * @param {boolean} options.isDialog - dialogs get the short version
 * @param {boolean} options.reduceMotion - fade only, without movement
 * @param {Function} options.onStopped - GNOME's completion callback; must run exactly once
 * @returns {Function} call it to end the animation at once (it still runs onStopped)
 */
export function playClose(actor, {style, duration, isDialog, reduceMotion, onStopped}) {
    // GNOME's dialog animation squashes the actor; start from rest.
    actor.set_pivot_point(0.5, 0.5);
    actor.scale_x = 1;
    actor.scale_y = 1;
    if (isDialog)
        duration = Math.round(duration * DIALOG_FACTOR);

    if (style === 'mist')
        return playMist(actor, duration, onStopped);
    if (style === 'pixels')
        return playPixels(actor, duration, onStopped);
    return playFade(actor, isDialog ? FADE_DIALOG : FADE, Math.round(duration * 0.57), reduceMotion, onStopped);
}

/**
 * Remove whatever a failed attempt left on the actor.
 *
 * @param {Meta.WindowActor} actor
 */
export function cleanUp(actor) {
    actor.remove_effect_by_name(SHADER_NAME);
    actor.remove_effect_by_name(BLUR_NAME);
}

// A window actor can only draw inside its own bounds. For the mist a larger transparent stage
// is built around it holding a live clone; the real actor is hidden and the shader runs on the stage.
function playMist(actor, duration, onStopped) {
    const [w, h] = actor.get_size();
    const m = MIST_MARGIN;
    const stageW = w + m.left + m.right;
    const stageH = h + m.top + m.bottom;

    const stage = new Clutter.Actor({
        x: actor.x - m.left,
        y: actor.y - m.top,
        width: stageW,
        height: stageH,
        reactive: false,
    });
    stage.add_child(new Clutter.Clone({source: actor, x: m.left, y: m.top}));
    actor.get_parent().insert_child_above(stage, actor);
    stage.add_effect(new MistShader(stageW, stageH, [m.left, m.top, w, h]));
    actor.opacity = 0;

    let done = false;
    const finish = () => {
        if (done)
            return;
        done = true;
        actor.disconnect(destroyId);
        stage.destroy();
        onStopped?.();
    };
    // GNOME may cut the animation short and destroy the window actor first.
    const destroyId = actor.connect('destroy', () => {
        done = true;
        stage.destroy();
    });

    stage.ease_property(`@effects.${SHADER_NAME}.progress`, 1.0, {
        duration,
        mode: Clutter.AnimationMode.LINEAR,
        onStopped: finish,
    });
    return finish;
}

function playPixels(actor, duration, onStopped) {
    const [w, h] = actor.get_size();
    actor.add_effect(new PixelsShader(w, h));
    actor.ease_property(`@effects.${SHADER_NAME}.progress`, 1.0, {
        duration,
        mode: Clutter.AnimationMode.LINEAR,
        onStopped,
    });
    return () => actor.remove_all_transitions();
}

function playFade(actor, shape, duration, reduceMotion, onStopped) {
    if (!reduceMotion) {
        actor.ease({
            scale_x: shape.scale,
            scale_y: shape.scale,
            translation_y: actor.translation_y + shape.drift,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1.0});
        actor.add_effect_with_name(BLUR_NAME, blur);
        actor.ease_property(`@effects.${BLUR_NAME}.radius`, shape.blur, {
            duration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }
    actor.ease({
        opacity: 0,
        duration,
        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        onStopped,
    });
    return () => actor.remove_all_transitions();
}
