// SPDX-License-Identifier: GPL-3.0-or-later
// What a player really supports. Some players expose Shuffle/LoopStatus but silently ignore
// changes (Spotify on Linux does). We learn that the first time a change has no effect and
// remember it in ~/.cache/lucent-tiles/caps.json, so the button stops being shown.
import GLib from 'gi://GLib';

const FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-tiles', 'caps.json']);
const KNOWN = {Spotify: {shuffle: false, loop: false}}; // measured 2026-11-13: Set is a no-op
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let caps = null;

function load() {
    if (caps)
        return caps;
    caps = {};
    try {
        const [ok, bytes] = GLib.file_get_contents(FILE);
        if (ok)
            caps = JSON.parse(decoder.decode(bytes)) ?? {};
    } catch {}
    return caps;
}

// false = known not to work; undefined = unknown (assume it works)
export function supports(identity, feature) {
    const c = load()[identity]?.[feature];
    return c ?? KNOWN[identity]?.[feature];
}

export function markUnsupported(identity, feature) {
    const c = load();
    c[identity] = {...c[identity], [feature]: false};
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(FILE), 0o755);
        GLib.file_set_contents(FILE, encoder.encode(JSON.stringify(c, null, 2)));
    } catch {}
}
