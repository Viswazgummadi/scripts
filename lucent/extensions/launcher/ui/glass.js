// SPDX-License-Identifier: GPL-3.0-or-later
// The glass: a live clone of everything behind the panel (wallpaper + windows), blurred, then
// saturated, tinted and cut to a rounded rectangle by one small fragment shader.
//
//   outer (GlassMask: rounded alpha + saturation + tint)
//     └ inner (clip_to_allocation, Shell.BlurEffect in ACTOR mode)
//         └ Clutter.Clone(global.window_group), offset so it lines up with the screen
//
// Blur and mask sit on two nested actors so their order is fixed: blur first, then the mask.
// Nothing here exists while the panel is closed (build()/teardown() on open/close).
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {tn} from '../core/gtype.js';

const DECL = `
uniform vec2 size;
uniform float radius;
uniform vec4 tint;
uniform float sat;
uniform float scale;
float rbox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec4 c = texture2D(cogl_sampler0, uv);
vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb;
float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
rgb = clamp(mix(vec3(l), rgb, sat), 0.0, 1.0);
rgb = mix(rgb, tint.rgb, tint.a);
vec2 p = uv * size;
float d = rbox(p - size * 0.5, size * 0.5, radius);
float a = 1.0 - smoothstep(-0.7 * scale, 0.7 * scale, d);
cogl_color_out = vec4(rgb * c.a, c.a) * a * cogl_color_in.a;
`;

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

    setParams({width, height, radius, tint, sat, scale}) {
        // the offscreen texture is in device pixels: work there so the edge stays one pixel wide
        this.set_uniform_float('size', 2, [Math.max(1, width * scale), Math.max(1, height * scale)]);
        this.set_uniform_float('radius', 1, [radius * scale]);
        this.set_uniform_float('tint', 4, tint);
        this.set_uniform_float('sat', 1, [sat]);
        this.set_uniform_float('scale', 1, [scale]);
        this.queue_repaint();
    }
});

// Round any actor's corners (preview images, live window thumbnails).
export function roundCorners(actor, radius) {
    const fx = new GlassMask();
    actor.add_effect(fx);
    const sync = () => {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        fx.setParams({width: actor.width, height: actor.height, radius, tint: [0, 0, 0, 0], sat: 1, scale});
    };
    actor.connect('notify::allocation', sync);
    sync();
    return fx;
}

export const Glass = GObject.registerClass({GTypeName: tn('Glass')},
class Glass extends St.Widget {
    _init() {
        super._init({style_class: 'sl-glass', x_expand: true, y_expand: true, layout_manager: new Clutter.BinLayout()});
        this._inner = null;
        this._clone = null;
        this._mask = null;
        this._blur = null;
        this._params = {radius: 28, tint: [0.11, 0.11, 0.12, 0.5], sat: 1.7, blur: 64};
        this._origin = [0, 0];
        this.connect('notify::allocation', () => this._sync());
    }

    build() {
        if (this._inner)
            return;
        this._inner = new St.Widget({x_expand: true, y_expand: true, clip_to_allocation: true});
        this._clone = new Clutter.Clone({source: global.window_group, reactive: false});
        this._inner.add_child(this._clone);
        this.add_child(this._inner);
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: this._params.blur, brightness: 1.0});
        this._inner.add_effect_with_name('sl-blur', this._blur);
        this._mask = new GlassMask();
        this.add_effect(this._mask);
        this._place();
        this._sync();
    }

    teardown() {
        if (this._mask) {
            this.remove_effect(this._mask);
            this._mask = null;
        }
        this._inner?.destroy();
        this._inner = this._clone = this._blur = null;
    }

    configure({radius, tint, sat, blur}) {
        Object.assign(this._params, {radius, tint, sat, blur});
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
        this._clone?.set_position(-this._origin[0], -this._origin[1]);
    }

    _sync() {
        if (!this._mask)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [w, h] = [this.width, this.height];
        this._mask.setParams({width: w, height: h, radius: Math.min(this._params.radius, h / 2), tint: this._params.tint, sat: this._params.sat, scale});
    }
});
