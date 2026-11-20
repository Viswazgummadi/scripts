// SPDX-License-Identifier: GPL-3.0-or-later
// A tiny notification source helper (GNOME 51 MessageTray API).
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export class Notifier {
    constructor(title, iconName) {
        this._title = title;
        this._iconName = iconName;
        this._source = null;
    }

    _ensureSource() {
        if (this._source)
            return this._source;
        this._source = new MessageTray.Source({title: this._title, iconName: this._iconName});
        this._source.connect('destroy', () => (this._source = null));
        Main.messageTray.add(this._source);
        return this._source;
    }

    // quiet: true = straight into the notification list, no banner (Urgency.LOW).
    show({title, body, iconName = null, quiet = false}) {
        const source = this._ensureSource();
        const n = new MessageTray.Notification({
            source, title, body,
            urgency: quiet ? MessageTray.Urgency.LOW : MessageTray.Urgency.NORMAL,
        });
        if (iconName)
            n.iconName = iconName;
        source.addNotification(n);
        return n;
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
    }
}
