// SPDX-License-Identifier: GPL-3.0-or-later
// The settings of Lucent Tiles and their defaults. They live in ~/.config/lucent-tiles/layout.json,
// which the extension re-reads whenever it is saved. Plain data: imported by the extension and by
// the preferences window alike.
import GLib from 'gi://GLib';

export const DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'lucent-tiles']);
export const FILE = GLib.build_filenamev([DIR, 'layout.json']);

export const DEFAULTS = {
    _help: [
        'Saved changes apply immediately.',
        'style: "tile" (tight spacing below; highlights come from the shell theme) or "plain" (theme spacing too).',
        'gap: px between tiles. hpadding: px of padding inside every top-bar button (GNOME uses 12).',
        'trayHpadding: px around each tray-drawer icon (default: same as hpadding). activityWidth: px of text in the',
        '  activity tile (longer text scrolls). resizeMs / revealMs: how long resizing / showing take.',
        'playerBackground: the player card behind its controls: "art" (album art, darkened),',
        '  "blur" (album art zoomed + blurred) or "none".',
        'playerOpen: how the player popover opens: "both" (hover or click), "hover" or "click".',
        '  hoverDelayMs: how long the pointer rests on the tile before a hover opens it.',
        'Each tile goes either next to another panel item: {"after": "clock"} / {"before": "clock"}',
        '  (items: clock, quickSettings, activities, keyboard, a11y, or another tile: system, activity),',
        '  or into a panel box: {"box": "left" | "center" | "right", "index": 0} (negative index = from the end).',
        'drawer: which panel items hide behind the tray arrow ("include", * wildcards; role names such as',
        '  "appindicator-*" for tray icons, "clipboardIndicator"), which stay on the bar ("pinned"),',
        '  and after how many idle seconds it closes by itself ("autoCloseSec", 0 = never).',
    ],
    style: 'tile',
    gap: 2,
    hpadding: 8,
    activityWidth: 130,
    playerBackground: 'art',
    playerOpen: 'both',
    hoverDelayMs: 150,
    resizeMs: 280,
    revealMs: 320,
    tiles: {
        system: {box: 'right', index: 0},
        activity: {box: 'left', index: -1},
        drawer: {before: 'quickSettings'},
    },
    drawer: {
        include: ['appindicator-*', 'clipboardIndicator'],
        pinned: [],
        autoCloseSec: 6,
    },
};
