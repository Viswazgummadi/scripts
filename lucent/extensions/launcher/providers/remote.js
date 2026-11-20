// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME's D-Bus search providers (Settings, Calendar, Contacts, Characters, Clocks, Weather,
// Software, Boxes, ...), loaded with the shell's own loader so the user's search settings
// (enabled/disabled/sort order) apply. Files and Calculator are skipped: we do both better.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as RemoteSearch from 'resource:///org/gnome/shell/ui/remoteSearch.js';
import {registerSection} from '../core/engine.js';

const SKIP = new Set(['org.gnome.Nautilus.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.Calculator']);
const TITLES = {
    'org.gnome.Settings.desktop': ['settings', 'System Settings', 30],
    'org.gnome.Calendar.desktop': ['events', 'Events', 0],
    'org.gnome.Contacts.desktop': ['contacts', 'Contacts', 0],
    'org.gnome.Characters.desktop': ['characters', 'Emoji & Symbols', -60],
    'org.gnome.clocks.desktop': ['clocks', 'World Clocks', -40],
    'org.gnome.Weather.desktop': ['weather', 'Weather', -20],
    'org.gnome.Software.desktop': ['software', 'App Store', -90],
    'org.gnome.Boxes.desktop': ['boxes', 'Virtual Machines', -60],
};

// A provider that does not answer in this time (an app whose D-Bus service hangs or never starts)
// is left out of the search, and then skipped for SLOW_BACKOFF_MS so it cannot hold up every query.
const ANSWER_MS = 1500;
const SLOW_BACKOFF_MS = 60000;

class TimedOut extends Error {}

// Resolve with `promise`, or reject with TimedOut after `ms`; the timer never outlives the race.
function within(promise, ms) {
    let id = 0;
    const timer = new Promise((_, reject) => {
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            id = 0;
            reject(new TimedOut());
            return GLib.SOURCE_REMOVE;
        });
    });
    return Promise.race([promise, timer]).finally(() => {
        if (id)
            GLib.source_remove(id);
    });
}

class OneRemote {
    constructor(rp) {
        this._rp = rp;
        const appId = rp.appInfo.get_id();
        const [key, title, bias] = TITLES[appId] ?? [`remote:${appId}`, rp.appInfo.get_name(), -50];
        this.section = key;
        if (key !== 'settings')
            registerSection(key, title, key === 'characters' ? 6 : 4, bias);
        this.id = `remote:${appId}`;
        this.configKey = 'remote';
        this.sync = false;
        this.minChars = 2;
        this.delay = 130;
        this.modes = key === 'settings' ? ['actions'] : [];
        this._skipUntil = 0;
    }

    async search(q, cancellable) {
        if (q.prefix || (q.hasFilters && !q.natural) || !q.text)
            return [];
        const now = GLib.get_monotonic_time() / 1000;
        if (now < this._skipUntil)
            return [];
        const terms = q.text.split(/\s+/).filter(Boolean);
        const rp = this._rp;
        let ids, metas;
        try {
            ids = await within(rp.getInitialResultSet(terms, cancellable), ANSWER_MS);
            ids = rp.filterResults(ids, 6);
            if (!ids.length)
                return [];
            metas = await within(rp.getResultMetas(ids, cancellable), ANSWER_MS);
        } catch (e) {
            if (!(e instanceof TimedOut))
                throw e;
            this._skipUntil = GLib.get_monotonic_time() / 1000 + SLOW_BACKOFF_MS;
            return [];
        }
        if (!this._rp)
            return [];
        const appName = rp.appInfo.get_name();
        return metas.map((m, i) => {
            let gicon = null;
            try {
                gicon = m.createIcon(48)?.gicon ?? null;
            } catch {
                gicon = null;
            }
            return {
                id: `${this.id}:${m.id}`,
                section: this.section,
                title: m.name,
                subtitle: m.description || appName,
                kind: appName,
                icon: {gicon: gicon ?? rp.appInfo.get_icon()},
                score: 720 - i * 25,
                completion: m.name,
                activate: () => rp.activateResult(m.id, terms),
                secondary: rp.canLaunchSearch ? () => rp.launchSearch(terms) : null,
                copy: m.clipboardText ? () => ({text: m.clipboardText}) : () => ({text: m.name}),
                preview: {type: 'generic', gicon: gicon ?? rp.appInfo.get_icon(), title: m.name, body: m.description ?? '', lines: [['From', appName]]},
                hints: rp.canLaunchSearch ? [['↩', 'Open'], ['⌃↩', `Search in ${appName}`]] : [['↩', 'Open']],
            };
        });
    }

    destroy() {
        this._rp = null;
    }
}

export function loadRemoteProviders() {
    let list = [];
    try {
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
        list = RemoteSearch.loadRemoteSearchProviders(settings);
    } catch (e) {
        console.warn(`[lucent-launcher] remote providers: ${e.message}`);
    }
    return list.filter(rp => !SKIP.has(rp.appInfo.get_id())).map(rp => new OneRemote(rp));
}
