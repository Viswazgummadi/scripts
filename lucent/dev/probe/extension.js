// SPDX-License-Identifier: GPL-3.0-or-later
// Lucent Probe: a development tool. This file is only a loader; the code is in src/main.js.
// The "reload" command copies src/ to a fresh folder and imports it again, because the shell
// caches every module by its path and Wayland sessions cannot restart the shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-probe']);

/**
 * Copy a folder and everything in it.
 *
 * @param {Gio.File} from
 * @param {Gio.File} to
 */
export function copyTree(from, to) {
    to.make_directory_with_parents(null);
    const children = from.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = children.next_file(null)) !== null) {
        const src = from.get_child(info.get_name()), dest = to.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            copyTree(src, dest);
        else
            src.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
    }
}

export default class ProbeExtension extends Extension {
    enable() {
        this._live = true;
        this._start(this._srcDir ?? GLib.build_filenamev([this.path, 'src']));
    }

    async _start(dir) {
        const token = this._token = (this._token ?? 0) + 1;
        try {
            const mod = await import(`file://${dir}/main.js`);
            if (!this._live || token !== this._token)
                return;
            this._impl = new mod.Probe(this);
            this._impl.enable();
        } catch (e) {
            console.error(`[lucent-probe] cannot start from ${dir}: ${e.message}\n${e.stack}`);
            this._impl = null;
        }
    }

    disable() {
        this._live = false;
        this._token = (this._token ?? 0) + 1;
        this._impl?.disable();
        this._impl = null;
    }

    reload() {
        const dest = GLib.build_filenamev([CACHE, `probe-${Date.now()}`]);
        copyTree(Gio.File.new_for_path(GLib.build_filenamev([this.path, 'src'])), Gio.File.new_for_path(dest));
        this.disable();
        this._srcDir = dest;
        this.enable();
    }
}
