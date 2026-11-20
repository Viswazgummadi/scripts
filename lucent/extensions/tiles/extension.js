// SPDX-License-Identifier: GPL-3.0-or-later
// Lucent Tiles: live tiles in the top bar that change with a mist dissolve.
//   - system tile: CPU and memory; dissolves into whatever hits its limit
//   - clock: GNOME's clock; at login, unlock and wake from suspend it turns into a quote for a few
//     seconds, then dissolves back
//   - activity tile: what is going on now (build, download, long command, player); hover or click
//     for every player's controls; hidden when idle
//   - tray drawer: tray icons behind one arrow; they slide out in the bar on click
// Tiles resize, appear and move fluidly (tile.js). Placement and look are in the preferences
// (stored in ~/.config/lucent-tiles/layout.json).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ActivityBlock} from './activityblock.js';
import {ClockQuote} from './clockquote.js';
import {DrawerTile} from './drawer.js';
import {clearAll} from './dissolve.js';
import {EventCache} from './events.js';
import {Layout} from './layout.js';
import {QuoteBook} from './quotes.js';
import {SysBlock} from './sysblock.js';

export default class LucentTilesExtension extends Extension {
    enable() {
        this._timeouts = new Set();
        this._quotes = new QuoteBook(this.path);
        this._events = new EventCache();

        this._sys = new SysBlock();
        this._activity = new ActivityBlock(() => this._layout?.activityWidth ?? 130,
            () => this._layout?.playerBackground ?? 'art',
            () => this._layout?.playerOpen ?? {mode: 'both', delay: 150});
        this._drawer = new DrawerTile(() => this._layout?.drawerConfig);
        this._layout = new Layout({system: this._sys, activity: this._activity, drawer: this._drawer});
        this._activity.container.hide();

        this._clockQuote = new ClockQuote(this._quotes, this._events);

        // Triggers. GNOME disables this extension on lock and enables it again on unlock,
        // so "enabled outside of startup" = unlocked (or turned on by hand).
        if (Main.layoutManager._startingUp) {
            this._startupId = Main.layoutManager.connect('startup-complete', () => this._playIn(1800));
        } else {
            this._playIn(1200);
        }
        this._sleepSub = Gio.DBus.system.signal_subscribe('org.freedesktop.login1',
            'org.freedesktop.login1.Manager', 'PrepareForSleep', '/org/freedesktop/login1', null,
            Gio.DBusSignalFlags.NONE, (c, s, p, i, sig, params) => {
                if (!params.deepUnpack()[0]) // false = just woke up
                    this._playIn(2500);
            });

        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-tiles']);
        GLib.mkdir_with_parents(dir, 0o755);
        this._replayMonitor = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._replayMonitor.connect('changed', (m, file, other, type) => {
            if (file.get_basename() === 'replay' &&
                (type === Gio.FileMonitorEvent.CHANGES_DONE_HINT || type === Gio.FileMonitorEvent.CREATED))
                this._playIn(300);
        });
    }

    _playIn(msec) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, msec, () => {
            this._timeouts.delete(id);
            this._clockQuote?.play();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    disable() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts = null;
        if (this._startupId)
            Main.layoutManager.disconnect(this._startupId);
        this._startupId = 0;
        if (this._sleepSub)
            Gio.DBus.system.signal_unsubscribe(this._sleepSub);
        this._sleepSub = 0;
        this._replayMonitor?.cancel();
        this._replayMonitor = null;

        this._layout?.destroy();
        this._layout = null;
        this._clockQuote?.destroy();
        this._clockQuote = null;
        clearAll();
        this._sys?.destroy();
        this._sys = null;
        this._activity?.destroy();
        this._activity = null;
        this._drawer?.destroy(); // gives every tray icon back
        this._drawer = null;
        this._events?.destroy();
        this._events = null;
        this._quotes = null;
    }
}
