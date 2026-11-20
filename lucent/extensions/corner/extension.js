// SPDX-License-Identifier: GPL-3.0-or-later
// Lucent Corner: a hot corner for Quick Settings.
//
// A small invisible actor sits in the top corner of the primary monitor, on the side where the
// system menu is. Resting the pointer there opens Quick Settings; clicking toggles it. The actor
// is tracked chrome, so it is hidden while a fullscreen window covers that monitor.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// The pointer is clamped to the screen edge, so a few pixels are enough to catch it.
const HOTSPOT_SIZE = 2;

export default class LucentCornerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dwellId = 0;
        // One visit to the corner opens the menu once. The visit is used up when the dwell
        // fires and a new one starts when the pointer really leaves.
        this._armed = true;

        this._hotspot = new St.Widget({
            name: 'lucent-corner-hotspot',
            reactive: true,
            track_hover: true,
            width: HOTSPOT_SIZE,
            height: HOTSPOT_SIZE,
        });
        this._hotspot.connect('notify::hover', () => {
            if (this._hotspot.hover) {
                if (this._armed)
                    this._startDwell();
                return;
            }
            this._cancelDwell();
            // An open menu holds the pointer, which looks like the pointer leaving and, when the
            // menu closes, arriving again. Only a leave while the menu is closed is a real one;
            // otherwise the menu would reopen as soon as it is closed with the pointer resting here.
            if (!this._menu?.isOpen)
                this._armed = true;
        });
        // A click opens the menu too. (While the menu is open it takes the click and closes.)
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => {
            this._cancelDwell();
            this._menu?.toggle();
        });
        this._hotspot.add_action(click);

        Main.layoutManager.addTopChrome(this._hotspot, {trackFullscreen: true});
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
        this._place();
    }

    disable() {
        this._cancelDwell();
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.removeChrome(this._hotspot);
        this._hotspot.destroy();
        this._hotspot = null;
        this._settings = null;
    }

    get _menu() {
        return Main.panel.statusArea.quickSettings?.menu ?? null;
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        this._hotspot.set_position(rtl ? monitor.x : monitor.x + monitor.width - HOTSPOT_SIZE, monitor.y);
    }

    _startDwell() {
        this._cancelDwell();
        this._dwellId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._settings.get_int('dwell-time'), () => {
            this._dwellId = 0;
            this._armed = false;
            const menu = this._menu;
            const allowed = !Main.overview.visible || this._settings.get_boolean('open-in-overview');
            if (menu && !menu.isOpen && allowed)
                menu.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDwell() {
        if (this._dwellId)
            GLib.source_remove(this._dwellId);
        this._dwellId = 0;
    }
}
