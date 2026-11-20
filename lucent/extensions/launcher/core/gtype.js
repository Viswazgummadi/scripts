// SPDX-License-Identifier: GPL-3.0-or-later
// GType names unique per loaded copy of the code: the dev hot-reload imports a fresh copy of
// every module, and GObject refuses to register the same type name twice.
import GLib from 'gi://GLib';

const SUFFIX = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, import.meta.url, -1).slice(0, 8);

export function tn(name) {
    return `LucentLauncher_${name}_${SUFFIX}`;
}
