// SPDX-License-Identifier: GPL-3.0-or-later
// ~/.config/lucent-launcher/config.json: user settings over DEFAULTS, live-reloaded on save.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DEFAULTS = {
    _help: [
        'Lucent Launcher settings. Saved changes apply immediately. The preferences window edits this file;',
        'the tables (webShortcuts, quickKeys, projects, excludePaths) are edited here by hand.',
        'shortcut: a GTK accelerator, e.g. "<Super>space" or "<Control>space".',
        'theme: "auto" follows the system dark/light style; or "dark" / "light".',
        'width / top: panel width in px and its distance from the top as a fraction of the screen.',
        'glass: blur radius, tint opacity (0..1) and colour saturation boost behind the panel.',
        'searchEngine: %s is replaced by the query. webShortcuts: "yt lofi" searches YouTube, etc.',
        'webSuggestions: send what you type to DuckDuckGo for suggestions (off = nothing typed leaves the machine',
        '  except when you pick a web search, a definition lookup or a currency rate refresh).',
        'quickKeys: exact text -> target (an app id, a path, a URL or a "> command"), always the top hit.',
        'clipboard: history kept in memory only unless persist is true; retentionHours trims old entries.',
        'fileRoots: where name search (plocate) looks; excludePaths: path fragments never shown.',
        'projects: Makefile targets offered as "make <target>" actions, run in the terminal.',
        'providers: set any to false to turn it off (apps, windows, files, calculator, conversions, dictionary,',
        '  system, clipboard, media, commands, web, remote).',
    ],
    shortcut: '<Super>space',
    freeSuperSpace: true,
    theme: 'auto',
    width: 760,
    top: 0.2,
    glass: {blur: 64, tint: 0.5, saturation: 1.7},
    animations: true,
    searchEngine: 'https://www.google.com/search?q=%s',
    webShortcuts: {
        yt: 'https://www.youtube.com/results?search_query=%s',
        gh: 'https://github.com/search?q=%s',
        w: 'https://en.wikipedia.org/wiki/Special:Search?search=%s',
        maps: 'https://www.google.com/maps/search/%s',
        ddg: 'https://duckduckgo.com/?q=%s',
    },
    webSuggestions: false,
    onlineDefinitions: true,
    currency: ['USD', 'EUR', 'GBP'],
    quickKeys: {},
    clipboard: {enabled: true, max: 120, retentionHours: 8, persist: false},
    fileRoots: ['~'],
    excludePaths: ['/.cache/', '/.local/share/Trash/', '/.git/', '/node_modules/', '/__pycache__/', '/.var/app/', '/.local/share/containers/', '/.mozilla/', '/.zen/', '/.npm/', '/.cargo/registry/', '/.local/share/icons/', '/.icons/', '/.themes/'],
    projects: [],
    terminal: [],
    providers: {},
    rememberQuerySeconds: 600,
};

export const DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'lucent-launcher']);
const FILE = GLib.build_filenamev([DIR, 'config.json']);

export function expandHome(p) {
    return typeof p === 'string' ? p.replace(/^~(?=\/|$)/, GLib.get_home_dir()) : p;
}

function merge(base, over) {
    const out = {...base};
    for (const [k, v] of Object.entries(over ?? {})) {
        if (k === '_help')
            continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
            out[k] = {...base[k], ...v};
        else
            out[k] = v;
    }
    return out;
}

export class Config {
    constructor(onChange) {
        this._onChange = onChange;
        this.v = DEFAULTS;
        this._load(true);
        try {
            this._monitor = Gio.File.new_for_path(DIR).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', (m, f) => {
                if (f.get_basename() !== 'config.json')
                    return;
                if (this._timer)
                    GLib.source_remove(this._timer);
                this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    this._timer = 0;
                    this._load(false);
                    this._onChange?.(this.v);
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            console.warn(`[lucent-launcher] config monitor: ${e.message}`);
        }
    }

    _load(first) {
        GLib.mkdir_with_parents(DIR, 0o755);
        const f = Gio.File.new_for_path(FILE);
        if (!f.query_exists(null)) {
            if (first) {
                try {
                    const text = JSON.stringify(DEFAULTS, null, 2);
                    f.replace_contents(new TextEncoder().encode(`${text}\n`), null, false, Gio.FileCreateFlags.NONE, null);
                } catch (e) {
                    console.warn(`[lucent-launcher] config write: ${e.message}`);
                }
            }
            this.v = DEFAULTS;
            return;
        }
        try {
            const [, bytes] = f.load_contents(null);
            this.v = merge(DEFAULTS, JSON.parse(new TextDecoder().decode(bytes)));
        } catch (e) {
            console.warn(`[lucent-launcher] config.json ignored (${e.message}); using the previous settings`);
        }
    }

    enabled(provider) {
        return this.v.providers?.[provider] !== false;
    }

    destroy() {
        this._monitor?.cancel();
        if (this._timer)
            GLib.source_remove(this._timer);
        this._onChange = null;
    }
}
