// SPDX-License-Identifier: GPL-3.0-or-later
// Shell-side helpers: open, reveal, Quick Look, copy, paste, run.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const HOME = GLib.get_home_dir();

export function tildify(path) {
    return path && path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}

export function launchContext() {
    return global.create_app_launch_context(0, -1);
}

export function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri_async(uri, launchContext(), null, (_, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res);
        } catch (e) {
            Main.notifyError('Lucent Launcher could not open this', e.message);
        }
    });
}

export function openFile(path) {
    openUri(Gio.File.new_for_path(path).get_uri());
}

function dbusCall(name, path, iface, method, params) {
    Gio.DBus.session.call(name, path, iface, method, params, null, Gio.DBusCallFlags.NONE, 3000, null, (c, res) => {
        try {
            c.call_finish(res);
        } catch (e) {
            console.warn(`[lucent-launcher] ${iface}.${method}: ${e.message}`);
        }
    });
}

// Show the file selected in Files (like Finder's "Show in Enclosing Folder").
export function reveal(uri) {
    dbusCall('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1',
        'ShowItems', new GLib.Variant('(ass)', [[uri], '']));
}

// Full-size Quick Look through GNOME's previewer (sushi).
export function quickLook(uri) {
    dbusCall('org.gnome.NautilusPreviewer', '/org/gnome/NautilusPreviewer', 'org.gnome.NautilusPreviewer',
        'ShowFile', new GLib.Variant('(sib)', [uri, 0, true]));
}

export function copyText(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, String(text));
}

// Copy files so they paste into Files (and as paths into text fields that read uri-lists).
export function copyFiles(uris) {
    const data = new TextEncoder().encode(`${uris.join('\r\n')}\r\n`);
    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'text/uri-list', new GLib.Bytes(data));
}

export function copyImage(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(bytes));
    } catch (e) {
        console.warn(`[lucent-launcher] copy image: ${e.message}`);
    }
}

// Send Ctrl+V to whatever has focus once our grab is gone.
let _vkbd = null;
let _pasteId = 0;
export function pasteSoon(delayMs = 120) {
    if (_pasteId)
        GLib.source_remove(_pasteId);
    _pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
        _pasteId = 0;
        try {
            if (!_vkbd) {
                const seat = global.stage.context.get_backend().get_default_seat();
                _vkbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            const t = GLib.get_monotonic_time();
            _vkbd.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            _vkbd.notify_keyval(t + 10, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            _vkbd.notify_keyval(t + 20, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            _vkbd.notify_keyval(t + 30, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        } catch (e) {
            console.warn(`[lucent-launcher] paste: ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    });
}

export function releaseVirtualKeyboard() {
    if (_pasteId)
        GLib.source_remove(_pasteId);
    _pasteId = 0;
    _vkbd?.run_dispose();
    _vkbd = null;
}

export function spawn(argv, cwd = null) {
    try {
        const l = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        if (cwd)
            l.set_cwd(cwd);
        l.spawnv(argv);
        return true;
    } catch (e) {
        Main.notifyError('Lucent Launcher could not start it', e.message);
        return false;
    }
}

// Terminals tried, in order, when the settings name none. A list ending in '--' takes the command
// as separate arguments; the others take it as one string.
const TERMINALS = [
    ['ptyxis', '--new-window', '-x'],
    ['kgx', '-e'],
    ['gnome-terminal', '--'],
    ['xterm', '-e'],
];

/**
 * The terminal command to use: the configured one, or the first known terminal that is installed.
 *
 * @param {string[]} [configured]
 * @returns {string[]|null}
 */
export function findTerminal(configured) {
    if (configured?.length)
        return configured;
    return TERMINALS.find(t => GLib.find_program_in_path(t[0])) ?? null;
}

// Run in a new terminal window and keep the shell open afterwards.
export function runInTerminal(cmd, {cwd = null, terminal = null} = {}) {
    const found = findTerminal(terminal);
    if (!found) {
        Main.notifyError('Lucent Launcher', 'No terminal found. Name one in the launcher\'s preferences.');
        return false;
    }
    const shell = GLib.getenv('SHELL') || '/bin/bash';
    const inner = `${cmd}; exec ${shell}`;
    const args = [...found];
    if (cwd && args[0] === 'ptyxis')
        args.splice(1, 0, '-d', cwd);
    if (args.at(-1) === '--')
        args.push(shell, '-ic', inner);
    else
        args.push(`${shell} -ic ${GLib.shell_quote(inner)}`);
    return spawn(args, cwd);
}

// Run silently; a notification reports how it ended.
export function runInBackground(cmd, {cwd = null} = {}) {
    try {
        const l = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE});
        if (cwd)
            l.set_cwd(cwd);
        const shell = GLib.getenv('SHELL') || '/bin/bash';
        const p = l.spawnv([shell, '-lc', cmd]);
        const started = Date.now();
        p.communicate_utf8_async(null, null, (proc, res) => {
            let out = '';
            try {
                [, out] = proc.communicate_utf8_finish(res);
            } catch {
                // ignore
            }
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            const ok = proc.get_successful();
            const tail = (out ?? '').trim().split('\n').slice(-3).join('\n');
            Main.notify(ok ? `Done: ${cmd}` : `Failed (exit ${proc.get_exit_status()}): ${cmd}`, `${secs} s${tail ? `\n${tail}` : ''}`);
        });
        return true;
    } catch (e) {
        Main.notifyError('Lucent Launcher could not run it', e.message);
        return false;
    }
}

// Read a subprocess's stdout as text (cancellable). Resolves '' on failure.
export function capture(argv, cancellable = null) {
    return new Promise(resolve => {
        let p;
        try {
            p = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            resolve('');
            return;
        }
        p.communicate_utf8_async(null, cancellable, (proc, res) => {
            try {
                const [, out] = proc.communicate_utf8_finish(res);
                resolve(out ?? '');
            } catch {
                resolve('');
            }
        });
    });
}

export function readText(path, maxBytes = 65536) {
    try {
        const f = Gio.File.new_for_path(path);
        const s = f.read(null);
        const bytes = s.read_bytes(maxBytes, null);
        s.close(null);
        return new TextDecoder('utf-8', {fatal: false}).decode(bytes.toArray());
    } catch {
        return null;
    }
}

export function relTime(ms) {
    if (!ms)
        return '';
    const d = (Date.now() - ms) / 1000;
    if (d < 60)
        return 'just now';
    if (d < 3600)
        return `${Math.floor(d / 60)} min ago`;
    if (d < 86400)
        return `${Math.floor(d / 3600)} h ago`;
    const dt = new Date(ms);
    const days = Math.floor(d / 86400);
    if (days === 1)
        return `yesterday, ${dt.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}`;
    if (days < 7)
        return dt.toLocaleDateString('en-GB', {weekday: 'long'});
    return dt.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
}

export function fullDate(ms) {
    if (!ms)
        return '';
    return new Date(ms).toLocaleString('en-GB', {day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'});
}

export function humanSize(n) {
    if (n === null || n === undefined)
        return '';
    return GLib.format_size(n);
}
