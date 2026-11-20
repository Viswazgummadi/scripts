// SPDX-License-Identifier: GPL-3.0-or-later
// Icon actors for result specs: {gicon} | {name, fallback} | {file, mime, thumb} | {color}.
// Thumbnails come from the freedesktop cache (~/.cache/thumbnails) when present, else the
// texture cache decodes the image at icon size off the main thread.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const THUMB_DIRS = ['large', 'x-large', 'normal'].map(d => GLib.build_filenamev([GLib.get_user_cache_dir(), 'thumbnails', d]));
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff?|ico)$/i;

export function thumbnailFor(path) {
    if (!path)
        return null;
    const uri = Gio.File.new_for_path(path).get_uri();
    const md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, uri, -1);
    for (const d of THUMB_DIRS) {
        const p = GLib.build_filenamev([d, `${md5}.png`]);
        if (GLib.file_test(p, GLib.FileTest.EXISTS))
            return p;
    }
    return null;
}

export function isImage(path, mime) {
    return (mime && mime.startsWith('image/')) || IMG_EXT.test(path ?? '');
}

export function makeIcon(spec, size) {
    spec ??= {};
    if (spec.color) {
        return new St.Widget({
            style_class: 'sl-swatch',
            width: size, height: size,
            style: `background-color: ${spec.color}; border-radius: ${Math.round(size * 0.24)}px;`,
            y_align: 2,
        });
    }
    if (spec.file && (spec.thumb || isImage(spec.file, spec.mime)) && !spec.isDir) {
        const thumb = thumbnailFor(spec.file);
        const src = thumb ?? (GLib.file_test(spec.file, GLib.FileTest.EXISTS) ? spec.file : null);
        if (src) {
            // a rounded tile filled with the picture, not a square cut-out of it
            const url = Gio.File.new_for_path(src).get_uri().replace(/["\\]/g, '\\$&');
            return new St.Widget({
                style_class: 'sl-thumb',
                width: size, height: size,
                style: `background-image: url("${url}"); background-size: cover; background-position: center; border-radius: ${Math.max(4, Math.round(size * 0.2))}px;`,
                y_align: 2,
            });
        }
    }
    if (spec.gicon)
        return new St.Icon({gicon: spec.gicon, icon_size: size, fallback_icon_name: spec.fallback ?? 'application-x-executable'});
    if (spec.name)
        return new St.Icon({icon_name: spec.name, icon_size: size, fallback_icon_name: spec.fallback ?? 'application-x-executable-symbolic'});
    if (spec.file) {
        const ct = spec.isDir ? 'inode/directory' : (spec.mime || Gio.content_type_guess(spec.file, null)[0]);
        return new St.Icon({gicon: Gio.content_type_get_icon(ct), icon_size: size});
    }
    return new St.Icon({icon_name: 'system-search-symbolic', icon_size: size});
}
