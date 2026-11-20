// SPDX-License-Identifier: GPL-3.0-or-later
// Shared by Lucent Launcher and Lucent Glass (copied into each at build time: build.json "shared").
// The glass: live clones of what is behind the panel (wallpaper + windows), blurred, then
// saturated, tinted and cut to a rounded rectangle by one small fragment shader.
//
//   outer (clip_to_allocation; GlassMask: rounded alpha + saturation + tint)
//     └ inner (MARGIN larger than outer on every side, clip_to_allocation, Shell.BlurEffect ACTOR)
//         └ backdrop: a clone per window and of the wallpaper, offset to line up with the screen
//
// Blur and mask sit on two nested actors so their order is fixed: blur first, then the mask.
// The inner actor reaches past the panel so the blur near the edges is made of real pixels, not
// of the transparent nothing beyond a clip (which would darken the rim).
// Windows are cloned without the widgets other extensions put inside them whose effects read the
// screen behind them (Blur my Shell's "bms-" widgets): painting those a second time, somewhere
// else, would leave them holding the wrong backdrop, and the desktop would show it.
// Nothing here exists while the panel is closed (build()/teardown() on open/close).
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GType names unique per loaded copy of this file: it is copied into every extension that uses
// it, and a development reload imports a fresh copy; GObject refuses a type name twice.
const SUFFIX = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, import.meta.url, -1).slice(0, 8);
const tn = name => `LucentLiquid_${name}_${SUFFIX}`;

// All lengths are in device pixels. The liquid terms (band, refraction, dispersion, rim, glow) are
// zero for plain rounding and frosted glass.
const POINTS = 33;
// ClutterShaderEffect takes vectors of at most four floats, not arrays: the curve travels as
// vec4 uniforms holding two points (or two normals) each, unpacked into arrays in the shader.
const PACKS = Math.ceil(POINTS / 2);
const PACKED_UNIFORMS = Array.from({length: PACKS}, (_, k) => `uniform vec4 cp${k};\nuniform vec4 cn${k};`).join('\n');
const UNPACK = Array.from({length: POINTS}, (_, i) =>
    `curve[${i}] = cp${i >> 1}.${i & 1 ? 'zw' : 'xy'}; normals[${i}] = cn${i >> 1}.${i & 1 ? 'zw' : 'xy'};`).join('\n    ');

const DECL = `#define POINTS ${POINTS}
uniform vec2 size;
uniform vec2 texorigin;
uniform vec2 texsize;
uniform vec4 tint;
uniform float sat;
uniform float scale;
uniform float band;
uniform float refraction;
uniform float dispersion;
uniform float rim;
uniform float glow;
// The shape: a box whose corners are one curve, built in JavaScript (cornerCurve) as POINTS
// points from where it leaves the top edge to where it meets the side (or, for a capsule, the tip
// at the middle of the end), with the outward normal at each. corner = how far the curve reaches
// along each edge. The distance to it, and the normal, are exact.
${PACKED_UNIFORMS}
uniform vec2 corner;
// signed distance to the shape (negative inside) and the outward normal, for p relative to the centre
float shape(vec2 p, vec2 b, out vec2 nrm) {
    vec2 a = abs(p);
    vec2 s = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
    vec2 origin = b - corner;
    if (a.x <= origin.x || a.y <= origin.y) {
        // along a straight edge
        float dx = a.x - b.x, dy = a.y - b.y;
        nrm = dx > dy ? vec2(s.x, 0.0) : vec2(0.0, s.y);
        return max(dx, dy);
    }
    vec2 q = a - origin; // the curve's own frame: x along the edge toward the corner, y up
    vec2 curve[POINTS];
    vec2 normals[POINTS];
    ${UNPACK}
    float best = 1e9;
    float side = 1.0;
    vec2 bestN = vec2(0.0, 1.0);
    for (int i = 0; i < POINTS - 1; i++) {
        vec2 a0 = curve[i], a1 = curve[i + 1];
        vec2 ab = a1 - a0;
        float t = clamp(dot(q - a0, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        vec2 c = a0 + ab * t;
        float dd = length(q - c);
        if (dd < best) {
            best = dd;
            bestN = normalize(mix(normals[i], normals[i + 1], t));
            side = dot(q - c, bestN) > 0.0 ? 1.0 : -1.0;
        }
    }
    nrm = bestN * s;
    return best * side;
}
vec3 unpremultiply(vec4 c) {
    return c.a > 0.0 ? c.rgb / c.a : c.rgb;
}
vec4 tap(vec2 uv) {
    return texture2D(cogl_sampler0, clamp(uv, vec2(0.0), vec2(1.0)));
}
`;

const CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 half_ = size * 0.5;
// The texture holds the actor plus some padding (textureFrame): map back onto the actor exactly.
vec2 p = texorigin + uv * texsize - half_;
// the outward normal of the shape, and how deep into the edge band this pixel is
vec2 n;
// The shape sits a pixel inside the actor's box: the actor clips at its box, and an edge drawn on
// the box itself loses the outer half of its smoothing and looks cut.
float d = shape(p, half_ - vec2(0.75 * scale), n);
float edge = band > 0.0 ? clamp(1.0 + d / band, 0.0, 1.0) : 0.0; // 0 inside the band, 1 on the rim
float bend = edge * edge * edge;

// lens: near the rim the backdrop is taken from further in, as through a thick rounded pane;
// red, green and blue bend by slightly different amounts
vec2 step_ = -n * bend * refraction / size;
vec4 c = tap(uv + step_);
vec3 rgb = unpremultiply(c);
if (dispersion > 0.0) {
    rgb.r = unpremultiply(tap(uv + step_ * (1.0 + dispersion))).r;
    rgb.b = unpremultiply(tap(uv + step_ * (1.0 - dispersion))).b;
}

float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
rgb = clamp(mix(vec3(l), rgb, sat), 0.0, 1.0);
rgb = mix(rgb, tint.rgb, tint.a);

// light from above: a crisp specular line on the rim, brightest where it faces up, a fainter
// bounce along the bottom, and a soft glow inside the band
// light from straight above: the left and right halves mirror each other exactly
float up = max(-n.y, 0.0);
float down = max(n.y, 0.0);
float line = 1.0 - smoothstep(0.0, 1.6 * scale, -d);
// nearly even all round, so the outline never fades out at the ends; a little brighter facing up
rgb = mix(rgb, vec3(1.0), clamp(line * rim * (0.62 + 0.38 * up + 0.12 * down), 0.0, 1.0));
rgb += vec3(bend * glow * (0.45 + 0.55 * up));

float a = 1.0 - smoothstep(-0.7 * scale, 0.7 * scale, d);
cogl_color_out = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a) * a * cogl_color_in.a;
`;

// ---- where an effect's texture sits ----------------------------------------------------------------
// An offscreen effect draws its actor into a texture slightly larger than the actor, laid out by
// Clutter's _clutter_actor_box_enlarge_for_effects (mutter, clutter-actor-box.c): the bottom-right
// is rounded up past +0.75 px, the top-left set the rounded size + 3 px before it. For a 760 px
// box that is -2 .. 761: 2 px of padding before, 1 px after. The texture is that box at the
// rounded-up resource scale. Returns the texture's origin and size in the actor's own units, so a
// shader can map a texture coordinate back onto the actor exactly.
function textureFrame(effect, actor) {
    const [ok, tw, th] = effect.get_target_size();
    if (!ok || !actor)
        return null;
    const [w, h] = allocatedSize(actor);
    const x2 = Math.ceil(w + 0.75), y2 = Math.ceil(h + 0.75);
    const rs = Math.ceil(actor.get_resource_scale() || 1);
    return {x: x2 - Math.round(w) - 3, y: y2 - Math.round(h) - 3, w: tw / rs, h: th / rs};
}

// ---- the corner curve ------------------------------------------------------------------------------
// Each corner is a curve whose curvature rises evenly from zero where it leaves the straight edge
// (an Euler spiral), runs as a circular arc, and falls back to zero into the other edge: there is
// no point where the bend suddenly starts, and the middle stays round. It reaches CORNER_REACH
// times the radius along each edge. When the box is too short for that (the closed search bar, a
// capsule), the curve meets the middle of the end instead, still in the arc, so the end is round
// rather than flat; between the two it blends, so a growing panel changes smoothly.

const CORNER_REACH = 1.45;
const SPIRAL_SHARE = 0.6; // of a full corner's length spent in the spirals
const STEPS = 720;

// The curve for a spiral share `c` and out-spiral fraction `u` (0: ends in the arc), traced with
// unit length: x along the edge toward the corner, y down from the edge.
function trace(c, u) {
    const [l1, l2, l3] = [c, 1 - c, u * c];
    const km = (Math.PI / 2) / (l1 / 2 + l2 + l3 / 2);
    const total = l1 + l2 + l3, ds = total / STEPS;
    const kappa = s => (s < l1 ? km * s / Math.max(l1, 1e-9) : s < l1 + l2 ? km : km * (1 - (s - l1 - l2) / Math.max(l3, 1e-9)));
    const xs = [0], ys = [0], th = [0];
    let x = 0, y = 0, t = 0;
    for (let i = 1; i <= STEPS; i++) {
        const t1 = t + (kappa((i - 1) * ds) + kappa(i * ds)) / 2 * ds;
        x += (Math.cos(t) + Math.cos(t1)) / 2 * ds;
        y += (Math.sin(t) + Math.sin(t1)) / 2 * ds;
        t = t1;
        xs.push(x);
        ys.push(y);
        th.push(t);
    }
    return {xs, ys, th};
}

const shapeCache = new Map();

// Points (and outward normals) of the corner curve for a box w x h with corner radius r, all in
// device pixels, in the frame the shader uses: from the start on the top edge (0, reachY) along +x,
// ending at (reachX, 0).
function cornerShape(w, h, r) {
    const half = Math.max(1, Math.min(w, h) / 2);
    const rr = Math.max(0.5, Math.min(r, half));
    const reach = CORNER_REACH * rr;
    const ry = Math.min(half, reach);
    const u = reach > rr ? Math.max(0, Math.min(1, (half - rr) / (reach - rr))) : 1;
    const rx = Math.min(reach, w / 2);
    const key = `${Math.round(rx * 4)}:${Math.round(ry * 4)}:${Math.round(u * 200)}`;
    let shape = shapeCache.get(key);
    if (shape)
        return shape;

    // the spiral share that gives the reach asked for along each edge
    let c = SPIRAL_SHARE;
    if (u < 1) {
        let lo = 0, hi = 0.98;
        for (let k = 0; k < 30; k++) {
            const m = (lo + hi) / 2;
            const tr = trace(m, u);
            if (tr.xs[STEPS] / tr.ys[STEPS] < rx / ry)
                lo = m;
            else
                hi = m;
        }
        c = (lo + hi) / 2 * (1 - u) + SPIRAL_SHARE * u;
    }
    const {xs, ys, th} = trace(c, u);
    const sx = rx / xs[STEPS], sy = ry / ys[STEPS];
    const points = [], normals = [];
    for (let i = 0; i < POINTS; i++) {
        const k = Math.round(i * STEPS / (POINTS - 1));
        points.push(xs[k] * sx, ry - ys[k] * sy);
        // tangent (cos t, -sin t) in this frame, scaled like the points; outward normal is it turned
        const tx = Math.cos(th[k]) * sx, ty = -Math.sin(th[k]) * sy;
        const l = Math.hypot(tx, ty) || 1;
        normals.push(-ty / l, tx / l);
    }
    shape = {points, normals, corner: [rx, ry]};
    if (shapeCache.size > 256)
        shapeCache.clear();
    shapeCache.set(key, shape);
    return shape;
}

const GlassMask = GObject.registerClass({GTypeName: tn('GlassMask')},
class GlassMask extends Clutter.ShaderEffect {
    _init() {
        super._init({name: 'sl-glass-mask'});
        this._size = [1, 1];
    }

    vfunc_get_static_snippet() {
        const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECL, null);
        s.set_replace(CODE);
        return s;
    }

    // The size of the texture is only known when it is painted: correct the mapping then (once per
    // change, so this does not keep asking for frames).
    vfunc_paint_target(node, paintContext) {
        const f = textureFrame(this, this.get_actor());
        if (f) {
            const scale = this._scale ?? 1;
            const key = `${f.x},${f.y},${f.w},${f.h}`;
            if (key !== this._texKey) {
                this._texKey = key;
                this.set_uniform_float('texorigin', 2, [f.x * scale, f.y * scale]);
                this.set_uniform_float('texsize', 2, [f.w * scale, f.h * scale]);
            }
        }
        super.vfunc_paint_target(node, paintContext);
    }

    setParams({width, height, radius, tint, sat, scale, liquid = null}) {
        // the offscreen texture is in device pixels: work there so the edge stays one pixel wide
        this.set_uniform_float('size', 2, [Math.max(1, width * scale), Math.max(1, height * scale)]);
        this._scale = scale;
        this._texKey = null;
        this.set_uniform_float('texorigin', 2, [0, 0]);
        this.set_uniform_float('texsize', 2, [Math.max(1, width * scale), Math.max(1, height * scale)]);
        const shape = cornerShape(width * scale, height * scale, radius * scale);
        for (let k = 0; k < PACKS; k++) {
            const at = (list, j) => list.slice(j, j + 4).concat([0, 0, 0, 0]).slice(0, 4);
            this.set_uniform_float(`cp${k}`, 4, at(shape.points, 4 * k));
            this.set_uniform_float(`cn${k}`, 4, at(shape.normals, 4 * k));
        }
        this.set_uniform_float('corner', 2, shape.corner);
        this.set_uniform_float('tint', 4, tint);
        this.set_uniform_float('sat', 1, [sat]);
        this.set_uniform_float('scale', 1, [scale]);
        this.set_uniform_float('band', 1, [(liquid?.band ?? 0) * scale]);
        this.set_uniform_float('refraction', 1, [(liquid?.refraction ?? 0) * scale]);
        this.set_uniform_float('dispersion', 1, [liquid?.dispersion ?? 0]);
        this.set_uniform_float('rim', 1, [liquid?.rim ?? 0]);
        this.set_uniform_float('glow', 1, [liquid?.glow ?? 0]);
        this.queue_repaint();
    }
});

// The size the actor is laid out at. Not actor.width/height: before a pending layout those report
// the preferred size, and the glass prefers the size of the whole screen it clones.
// ---- whole device pixels ---------------------------------------------------------------------------
// At a fractional scale (1.5) an odd logical length is a half device pixel: an edge there is
// smoothed differently from its opposite edge, and a shape looks lopsided. Glass boxes snap their
// edges to whole device pixels.

// The scale of the monitor showing `actor` (1 when unknown).
export function monitorScale(actor) {
    const index = actor ? Main.layoutManager.findIndexForActor(actor) : -1;
    return index >= 0 ? global.display.get_monitor_scale(index) || 1 : 1;
}

// `value` (logical pixels) moved to the nearest whole device pixel at `scale`.
export function onPixel(value, scale) {
    return scale > 0 ? Math.round(value * scale) / scale : value;
}

function allocatedSize(actor) {
    const box = actor.get_allocation_box();
    return [box.get_width(), box.get_height()];
}

// Round any actor's corners (preview images, live window thumbnails).
export function roundCorners(actor, radius) {
    const fx = new GlassMask();
    actor.add_effect(fx);
    const sync = () => {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [width, height] = allocatedSize(actor);
        fx.setParams({width, height, radius, tint: [0, 0, 0, 0], sat: 1, scale});
    };
    actor.connect('notify::allocation', sync);
    sync();
    return fx;
}

// ---- edge fade for scrolled content ---------------------------------------------------------------
// Content that runs past the top or bottom of a scroll view fades to nothing exactly at the edge
// where it is clipped (St's own fade stops short of it, leaving a faint cut). The top fades only
// once the view is scrolled down, the bottom only while there is more below, each easing in.

const FADE_DECL = `
uniform float height;
uniform float texy;
uniform float texh;
uniform float top;
uniform float bottom;
`;

const FADE_CODE = `
vec4 c = texture2D(cogl_sampler0, cogl_tex_coord_in[0].xy);
float y = texy + cogl_tex_coord_in[0].y * texh; // see textureFrame
float a = 1.0;
if (top > 0.0)
    a *= smoothstep(0.0, top, y);
if (bottom > 0.0)
    a *= smoothstep(0.0, bottom, height - y);
cogl_color_out = c * a * cogl_color_in.a;
`;

const EdgeFadeEffect = GObject.registerClass({GTypeName: tn('EdgeFade')},
class EdgeFadeEffect extends Clutter.ShaderEffect {
    vfunc_paint_target(node, paintContext) {
        const f = textureFrame(this, this.get_actor());
        if (f && `${f.y},${f.h}` !== this._texKey) {
            this._texKey = `${f.y},${f.h}`;
            this.set_uniform_float('texy', 1, [f.y]);
            this.set_uniform_float('texh', 1, [f.h]);
        }
        super.vfunc_paint_target(node, paintContext);
    }

    vfunc_get_static_snippet() {
        const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, FADE_DECL, null);
        s.set_replace(FADE_CODE);
        return s;
    }
});

export function edgeFade(scroll, length = 28) {
    // the effect draws what the actor reports it paints; a scroll view reports its whole content,
    // so clip it to its box, or the fade would be spread over the full content height
    scroll.clip_to_allocation = true;
    const fx = new EdgeFadeEffect({name: 'sl-edge-fade'});
    scroll.add_effect(fx);
    const adj = scroll.vadjustment;
    const sync = () => {
        const [, height] = allocatedSize(scroll);
        const above = adj.value - adj.lower;
        const below = adj.upper - adj.page_size - adj.value;
        const top = above > 0.5 ? length * Math.min(1, above / length) : 0;
        const bottom = below > 0.5 ? length * Math.min(1, below / length) : 0;
        fx.enabled = top > 0 || bottom > 0;
        fx.set_uniform_float('height', 1, [Math.max(1, height)]);
        if (!fx._texKey) {
            fx.set_uniform_float('texy', 1, [0]);
            fx.set_uniform_float('texh', 1, [Math.max(1, height)]);
        }
        fx.set_uniform_float('top', 1, [top]);
        fx.set_uniform_float('bottom', 1, [bottom]);
        fx.queue_repaint();
    };
    // The adjustment belongs to the scroll view and is freed with it, together with these
    // handlers; disconnecting by hand on destroy would touch it after it is gone.
    for (const prop of ['value', 'upper', 'page-size'])
        adj.connect(`notify::${prop}`, sync);
    scroll.connect('notify::allocation', sync);
    sync();
    return fx;
}

// Extra blurred surroundings on each side of the panel, in pixels.
const MARGIN = 48;

// Actors that capture the screen behind themselves and must not be painted twice.
function capturesBackdrop(actor) {
    return actor.name?.startsWith('bms-') ?? false;
}

// Clones of everything in global.window_group, in stacking order, inside one actor.
function backdrop() {
    const root = new Clutter.Actor({reactive: false});
    for (const child of global.window_group.get_children()) {
        if (!child.visible || capturesBackdrop(child))
            continue;
        const parts = child.get_children();
        if (!(child instanceof Meta.WindowActor) && !parts.some(capturesBackdrop)) {
            root.add_child(new Clutter.Clone({source: child, x: child.x, y: child.y, opacity: child.opacity}));
            continue;
        }
        for (const part of parts) {
            if (!part.visible || capturesBackdrop(part))
                continue;
            root.add_child(new Clutter.Clone({source: part, x: child.x + part.x, y: child.y + part.y, opacity: child.opacity}));
        }
    }
    return root;
}

export const Glass = GObject.registerClass({GTypeName: tn('Glass')},
class Glass extends St.Widget {
    _init() {
        super._init({style_class: 'sl-glass', x_expand: true, y_expand: true, clip_to_allocation: true});
        this._inner = null;
        this._clone = null;
        this._mask = null;
        this._blur = null;
        this._params = {radius: 28, tint: [0.11, 0.11, 0.12, 0.5], sat: 1.7, blur: 64, liquid: null};
        this._origin = [0, 0];
        this.connect('notify::allocation', () => this._sync());
    }

    build() {
        if (this._inner)
            return;
        this._inner = new St.Widget({clip_to_allocation: true});
        this._clone = backdrop();
        this._inner.add_child(this._clone);
        this.add_child(this._inner);
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: this._params.blur, brightness: 1.0});
        this._inner.add_effect_with_name('sl-blur', this._blur);
        this._mask = new GlassMask();
        this.add_effect(this._mask);
        this._place();
        this._sync();
    }

    // The glass fills whatever box the panel gives it; it asks for nothing (its clones are the size
    // of the screen and would otherwise be its preferred size).
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    // The blurred layer reaches MARGIN past every side, laid out here in the same pass. (A size
    // constraint bound to this actor kept it needing layout while it grew, and an actor waiting for
    // layout has no paint box: the mask's texture then no longer matched the glass, and the
    // rounded shape drifted sideways and was cut off.)
    vfunc_allocate(box) {
        this.set_allocation(box);
        if (!this._inner)
            return;
        const [w, h] = [box.get_width(), box.get_height()];
        this._inner.allocate(new Clutter.ActorBox({x1: -MARGIN, y1: -MARGIN, x2: w + MARGIN, y2: h + MARGIN}));
    }

    teardown() {
        if (this._mask) {
            this.remove_effect(this._mask);
            this._mask = null;
        }
        this._inner?.destroy();
        this._inner = this._clone = this._blur = null;
    }

    configure({radius, tint, sat, blur, liquid = null}) {
        Object.assign(this._params, {radius, tint, sat, blur, liquid});
        if (this._blur)
            this._blur.radius = blur;
        this._sync();
    }

    // stage position of this actor's top-left, so the clone lines up with the real screen
    setOrigin(x, y) {
        this._origin = [x, y];
        this._place();
    }

    _place() {
        this._clone?.set_position(MARGIN - this._origin[0], MARGIN - this._origin[1]);
    }

    _sync() {
        if (!this._mask)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [w, h] = allocatedSize(this);
        this._mask.setParams({width: w, height: h, radius: Math.min(this._params.radius, h / 2), tint: this._params.tint,
            sat: this._params.sat, scale, liquid: this._params.liquid});
    }
});
