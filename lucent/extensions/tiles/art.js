// SPDX-License-Identifier: GPL-3.0-or-later
// Cover art: file:// URLs are used directly; http(s) art (Spotify, browsers) is downloaded once
// into ~/.cache/lucent-tiles/art/<sha256> and reused.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';

const DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-tiles', 'art']);
let session = null;
const pending = new Map(); // url -> Promise<path|null>

// Resolves to a local file path (or null).
export function artPath(url, cancellable = null) {
    if (!url)
        return Promise.resolve(null);
    if (url.startsWith('file://')) {
        const p = Gio.File.new_for_uri(url).get_path();
        return Promise.resolve(p && GLib.file_test(p, GLib.FileTest.EXISTS) ? p : null);
    }
    if (!/^https?:\/\//.test(url))
        return Promise.resolve(null);
    const path = GLib.build_filenamev([DIR, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1)]);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return Promise.resolve(path);
    if (pending.has(url))
        return pending.get(url);
    const p = new Promise(resolve => {
        const msg = Soup.Message.new('GET', url);
        if (!msg) {
            resolve(null);
            return;
        }
        session ??= new Soup.Session({timeout: 10});
        session.send_and_read_async(msg, GLib.PRIORITY_LOW, cancellable, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) {
                    resolve(null);
                    return;
                }
                GLib.mkdir_with_parents(DIR, 0o755);
                GLib.file_set_contents(path, bytes.toArray());
                resolve(path);
            } catch {
                resolve(null);
            }
        });
    }).finally(() => pending.delete(url));
    pending.set(url, p);
    return p;
}

export function artStyle(path) {
    const uri = Gio.File.new_for_path(path).get_uri().replace(/"/g, '%22');
    return `background-image: url("${uri}");`;
}

// A tiny (14 px) copy of the art: shown with background-size: cover, GNOME's smooth upscaling
// turns it into a soft, zoomed, blurred backdrop. Cached in our own art dir (never next to the
// source, which may belong to another app).
export function blurredPath(path) {
    if (!path)
        return null;
    const out = GLib.build_filenamev([DIR,
        `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, path, -1)}.blur.png`]);
    if (GLib.file_test(out, GLib.FileTest.EXISTS))
        return out;
    try {
        GLib.mkdir_with_parents(DIR, 0o755);
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 14, 14, true);
        pb.savev(out, 'png', [], []);
        return out;
    } catch {
        return null;
    }
}

// A square, centre-cropped copy of the art at exactly `px` device pixels (high-quality
// downscale), so the card's thumbnail is drawn 1:1: no shimmering from a GPU downscale of a
// 640 px cover, no blur from an upscale. Cached per (path, px) in our own art dir.
export function thumbPath(path, px) {
    if (!path || !(px > 0))
        return null;
    const out = GLib.build_filenamev([DIR,
        `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, path, -1)}.thumb${px}.png`]);
    if (GLib.file_test(out, GLib.FileTest.EXISTS))
        return out;
    try {
        GLib.mkdir_with_parents(DIR, 0o755);
        const src = GdkPixbuf.Pixbuf.new_from_file(path);
        const w = src.get_width(), h = src.get_height();
        const s = px / Math.min(w, h);
        const sw = Math.max(px, Math.round(w * s)), sh = Math.max(px, Math.round(h * s));
        const scaledPb = src.scale_simple(sw, sh, GdkPixbuf.InterpType.HYPER);
        const crop = scaledPb.new_subpixbuf(Math.floor((sw - px) / 2), Math.floor((sh - px) / 2), px, px);
        crop.savev(out, 'png', [], []);
        return out;
    } catch {
        return null;
    }
}

// The art's accent colour, One UI / Material style: the most vibrant hue in the picture
// (pixels weighted by saturation × mid-brightness), then lightened until it reads clearly on a
// dark card. Returns [r, g, b] in 0..1, or null. Cached per image path.
const accents = new Map();

function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min)
        return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)
        h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g)
        h = (b - r) / d + 2;
    else
        h = (r - g) / d + 4;
    return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
    if (s === 0)
        return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => {
        t = (t + 1) % 1;
        if (t < 1 / 6)
            return p + (q - p) * 6 * t;
        if (t < 1 / 2)
            return q;
        if (t < 2 / 3)
            return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

export function accentColor(path) {
    if (!path)
        return null;
    if (accents.has(path))
        return accents.get(path);
    let result = null;
    try {
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 32, 32, false);
        const px = pb.get_pixels(), n = pb.get_n_channels(), stride = pb.get_rowstride();
        // 24 hue buckets, weighted
        const buckets = Array.from({length: 24}, () => ({w: 0, s: 0, l: 0}));
        for (let y = 0; y < pb.get_height(); y++) {
            for (let x = 0; x < pb.get_width(); x++) {
                const i = y * stride + x * n;
                const [h, s, l] = rgbToHsl(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
                const w = s * s * (1 - Math.abs(l - 0.5) * 1.6);
                if (w <= 0.02)
                    continue;
                const b = buckets[Math.floor(h * 24) % 24];
                b.w += w;
                b.s += s * w;
                b.l += l * w;
                b.h = (b.h ?? 0) + h * w;
            }
        }
        const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
        if (best.w > 0.5) {
            const h = best.h / best.w;
            const s = Math.min(0.85, Math.max(0.45, best.s / best.w));
            const l = Math.max(0.68, Math.min(0.80, best.l / best.w + 0.25)); // readable on dark
            result = hslToRgb(h, s, l);
        }
    } catch {}
    accents.set(path, result);
    return result;
}

// Three vivid colours for the visualiser (One UI 9: the wave takes its palette from the album):
// the three strongest hues at least 45° apart; if the art has fewer, neighbouring hues of the
// strongest one fill in. Each is saturated and lightened to glow on a dark card. Cached.
const palettes = new Map();

export function paletteColors(path) {
    const key = path ?? '';
    if (palettes.has(key))
        return palettes.get(key);
    let hues = [];
    try {
        if (path) {
            const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 32, 32, false);
            const px = pb.get_pixels(), n = pb.get_n_channels(), stride = pb.get_rowstride();
            const w = new Array(24).fill(0), hs = new Array(24).fill(0);
            for (let y = 0; y < pb.get_height(); y++) {
                for (let x = 0; x < pb.get_width(); x++) {
                    const i = y * stride + x * n;
                    const [h, s, l] = rgbToHsl(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
                    const weight = s * s * (1 - Math.abs(l - 0.5) * 1.6);
                    if (weight <= 0.02)
                        continue;
                    const b = Math.floor(h * 24) % 24;
                    w[b] += weight;
                    hs[b] += h * weight;
                }
            }
            const order = w.map((v, i) => i).filter(i => w[i] > 0.3).sort((a, b) => w[b] - w[a]);
            for (const b of order) {
                const dist = o => Math.min(Math.abs(b - o), 24 - Math.abs(b - o));
                if (hues.every(o => dist(o.b) >= 3))
                    hues.push({b, h: hs[b] / w[b]});
                if (hues.length === 3)
                    break;
            }
        }
    } catch {}
    let list = hues.map(x => x.h);
    if (!list.length)
        list = [0.62]; // no colour in the art: the blue/violet/pink One UI default
    while (list.length < 3)
        list.push((list[0] + (list.length === 1 ? 0.11 : -0.11) + 1) % 1);
    const result = list.map(h => hslToRgb(h, 0.85, 0.64));
    palettes.set(key, result);
    return result;
}
