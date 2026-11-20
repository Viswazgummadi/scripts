// SPDX-License-Identifier: GPL-3.0-or-later
// One UI 9 style "glass" audio visualiser, drawn with Cairo (pure function, no shell imports).
//
// Played part: three translucent colour masses (album palette), one per frequency band
// (bass, mid, treble), blended additively at moderate opacity (overlaps glow, without blowing
// out to flat white), each with
// a soft halo and a light rim; the mass rises gradually, peaks just before the thumb and falls
// into it. A beat pulse (0..1, decaying) swells the masses, the bass one most. Over it a bright
// progress line; a flat dim line for the rest; a glowing ring thumb in the album accent with a
// white core.
//
// Cost: each mass's outline is sampled once per frame (every STEP px, joined by Bézier curves),
// built as a path once and reused for the halo and the fill (~0.6 ms a frame at 2x, was 1.15).
//
// state: {w, h, value 0..1, thumb (px radius), height 0..1 (0 = flat), levels [b, m, t] 0..1,
//         t (seconds, drives the drift), colors [[r,g,b] ×3], accent [r,g,b], halo 0..1,
//         pulse 0..1}
import Cairo from 'cairo';
export const PAD = 10; // px inset at both ends (thumb fits inside)
const STEP = 6;        // px between outline samples (joined by smooth curves)
const HALO = 1.16;     // halo = the mass scaled up this much, drawn faint
const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const TAU = 2 * Math.PI;

const LAYERS = [
    {lam: 1.05, sp: 0.22, ph: 0.0, pulse: 0.45},  // bass: swells most on a beat
    {lam: 0.78, sp: -0.31, ph: 1.7, pulse: 0.18},
    {lam: 0.57, sp: 0.43, ph: 3.1, pulse: 0.12},
];

// A smooth curve through the points (Catmull-Rom as cubic Béziers), from i0 to i1 (either
// direction); the current point must already be at the first one. Far fewer Cairo calls than a
// polyline of the same smoothness: Cairo calls from JS, not pixels, are what cost here.
function curveThrough(cr, xs, ys, i0, i1) {
    const d = i1 >= i0 ? 1 : -1;
    const at = i => Math.max(Math.min(i0, i1), Math.min(Math.max(i0, i1), i));
    for (let i = i0; i !== i1; i += d) {
        const p = at(i - d), q = at(i + d), r = at(i + 2 * d);
        cr.curveTo(
            xs[i] + (xs[q] - xs[p]) / 6, ys[i] + (ys[q] - ys[p]) / 6,
            xs[q] - (xs[r] - xs[i]) / 6, ys[q] - (ys[r] - ys[i]) / 6,
            xs[q], ys[q]);
    }
}

export function drawGlass(cr, s) {
    const x0 = PAD, x1 = s.w - PAD, cy = s.h * 0.62;
    const hx = x0 + (x1 - x0) * s.value;
    const end = hx - s.thumb - 3, L = Math.max(1, end - x0);
    const H = 18 * s.height; // max px above the line
    const pulse = s.pulse ?? 0;
    cr.setLineCap(Cairo.LineCap.ROUND);
    // remaining track
    cr.setSourceRGBA(1, 1, 1, 0.25); cr.setLineWidth(2.5);
    cr.moveTo(hx + s.thumb + 3, cy); cr.lineTo(x1, cy); cr.stroke();

    if (end > x0 + 2 && H > 0.2) {
        // shared sample positions and envelope (rise over 72 %, fall into the thumb)
        const n = Math.max(2, Math.ceil(L / STEP) + 1);
        const xs = new Float64Array(n), env = new Float64Array(n), us = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const x = i === n - 1 ? end : x0 + i * STEP;
            xs[i] = x;
            us[i] = (x - x0) / L;
            env[i] = smooth((x - x0) / (0.72 * L)) ** 1.3 * smooth((end - x) / (0.12 * L + 8));
        }
                const ty = new Float64Array(n), by = new Float64Array(n);
        cr.save();
        cr.setOperator(Cairo.Operator.ADD); // overlaps glow (SCREEN looks alike but has no fast path: +50 % cost)
        LAYERS.forEach((ly, li) => {
            const v = s.levels[li];
            // soft limit: tall waves (beat + drag swell) round off below the canvas top instead of
            // being cut flat; the halo is the tallest thing drawn
            const room = Math.max(1, (cy - 1.5) / HALO);
            const raw = H * (0.35 + 0.65 * v) * (1 + ly.pulse * pulse);
            const amp = room * Math.tanh(raw / room);
            const p1 = ly.ph + s.t * ly.sp * TAU, p2 = -ly.ph * 0.7 - s.t * ly.sp * 3.1;
            const k1 = TAU / ly.lam, k2 = TAU / (ly.lam * 0.53);
            let top = 0;
            for (let i = 0; i < n; i++) {
                const sh = Math.max(0, 0.55 * Math.sin(k1 * us[i] + p1) + 0.25 * Math.sin(k2 * us[i] + p2) + 0.55);
                const a = amp * env[i] * sh;
                ty[i] = cy - a;
                by[i] = cy + a * 0.32;
                if (a > top)
                    top = a;
            }
            // the outline, built once: top edge left→right, bottom edge back
            cr.newPath();
            cr.moveTo(xs[0], ty[0]);
            curveThrough(cr, xs, ty, 0, n - 1);
            cr.lineTo(xs[n - 1], by[n - 1]);
            curveThrough(cr, xs, by, n - 1, 0);
            cr.closePath();
            const outline = cr.copyPath();
            cr.newPath();
            const [r, g, b] = s.colors[li];
            // soft halo: the same mass a little taller, faint (brighter on a beat)
            cr.save();
            cr.translate(0, cy);
            cr.scale(1, HALO);
            cr.translate(0, -cy);
            cr.appendPath(outline);
            cr.restore();
            cr.setSourceRGBA(r, g, b, 0.13 + 0.10 * pulse * ly.pulse * 2);
            cr.fill();
            // the mass: vertical glass gradient
            cr.appendPath(outline);
            const grad = new Cairo.LinearGradient(0, cy - Math.max(1, top), 0, cy + Math.max(1, top) * 0.32);
            grad.addColorStopRGBA(0, r, g, b, 0.68);
            grad.addColorStopRGBA(0.72, r, g, b, 0.28);
            grad.addColorStopRGBA(1, r, g, b, 0.05);
            cr.setSource(grad);
            cr.fill();
            // glassy rim along the top edge
            cr.newPath();
            cr.moveTo(xs[0], ty[0]);
            curveThrough(cr, xs, ty, 0, n - 1);
            cr.setSourceRGBA(Math.min(1, r + 0.25), Math.min(1, g + 0.25), Math.min(1, b + 0.25), 0.55);
            cr.setLineWidth(1);
            cr.stroke();
        });
        cr.restore();
    }
    // progress line
    const pg = new Cairo.LinearGradient(x0, 0, hx, 0);
    pg.addColorStopRGBA(0, 1, 1, 1, 0.55); pg.addColorStopRGBA(1, 1, 1, 1, 1);
    cr.setSource(pg); cr.setLineWidth(3); cr.moveTo(x0, cy); cr.lineTo(Math.max(x0, hx - s.thumb - 1), cy); cr.stroke();
    // thumb: glow (stronger while dragging) + ring + white core
    const [ar, ag, ab] = s.accent;
    const gr = s.thumb + 9 + 5 * (s.halo ?? 0);
    const glow = new Cairo.RadialGradient(hx, cy, 0, hx, cy, gr);
    glow.addColorStopRGBA(0, ar, ag, ab, 0.55 + 0.25 * (s.halo ?? 0)); glow.addColorStopRGBA(1, ar, ag, ab, 0);
    cr.setSource(glow); cr.arc(hx, cy, gr, 0, TAU); cr.fill();
    cr.setSourceRGBA(ar, ag, ab, 1); cr.arc(hx, cy, s.thumb, 0, TAU); cr.fill();
    cr.setSourceRGBA(1, 1, 1, 1); cr.arc(hx, cy, s.thumb - 2.6, 0, TAU); cr.fill();
}
