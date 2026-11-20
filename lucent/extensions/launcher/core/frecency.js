// SPDX-License-Identifier: GPL-3.0-or-later
// Learns what you pick. Two signals, both tiny and on disk (~/.local/state/lucent-launcher/usage.json):
//  - per result: launch count + last use, decayed (half-life 14 days)
//  - per typed prefix (1..8 chars): which result you chose, so "s" → the thing you always open
// boost(id, folded query) -> 0..~600 added to the 0..1000 match score.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'lucent-launcher']);
const FILE = GLib.build_filenamev([DIR, 'usage.json']);
const HALF_LIFE_MS = 14 * 86400000;
const MAX_IDS = 600;
const MAX_PREFIX_IDS = 6;

export class Frecency {
    constructor() {
        this._d = {ids: {}, q: {}};
        this._dirty = 0;
        try {
            const [, bytes] = Gio.File.new_for_path(FILE).load_contents(null);
            const d = JSON.parse(new TextDecoder().decode(bytes));
            if (d && d.ids && d.q)
                this._d = d;
        } catch {
            // first run
        }
    }

    boost(id, q) {
        let b = 0;
        const e = this._d.ids[id];
        if (e) {
            const age = Date.now() - e.t;
            b += 110 * Math.log2(1 + e.n) * Math.pow(0.5, age / HALF_LIFE_MS);
        }
        if (q) {
            const key = q.slice(0, 8);
            const m = this._d.q[key];
            if (m && m[id]) {
                const total = Object.values(m).reduce((a, x) => a + x, 0);
                b += 420 * (m[id] / total) * Math.min(1, m[id] / 2);
            }
        }
        return b;
    }

    lastUsed(id) {
        return this._d.ids[id]?.t ?? null;
    }

    count(id) {
        return this._d.ids[id]?.n ?? 0;
    }

    record(id, q) {
        if (!id)
            return;
        const e = this._d.ids[id] ?? {n: 0, t: 0};
        e.n = Math.min(e.n + 1, 10000);
        e.t = Date.now();
        this._d.ids[id] = e;
        if (q) {
            for (let len = 1; len <= Math.min(8, q.length); len++) {
                const key = q.slice(0, len);
                const m = this._d.q[key] ?? {};
                m[id] = (m[id] ?? 0) + 1;
                // keep each prefix's map small: drop the weakest
                const entries = Object.entries(m);
                if (entries.length > MAX_PREFIX_IDS) {
                    entries.sort((a, b) => b[1] - a[1]);
                    this._d.q[key] = Object.fromEntries(entries.slice(0, MAX_PREFIX_IDS));
                } else {
                    this._d.q[key] = m;
                }
            }
        }
        this._prune();
        this._save();
    }

    forget(id) {
        delete this._d.ids[id];
        for (const m of Object.values(this._d.q))
            delete m[id];
        this._save();
    }

    _prune() {
        const ids = Object.entries(this._d.ids);
        if (ids.length <= MAX_IDS)
            return;
        ids.sort((a, b) => b[1].t - a[1].t);
        this._d.ids = Object.fromEntries(ids.slice(0, MAX_IDS));
    }

    _save() {
        if (this._dirty)
            return;
        this._dirty = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 2, () => {
            this._dirty = 0;
            this.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    flush() {
        try {
            GLib.mkdir_with_parents(DIR, 0o700);
            Gio.File.new_for_path(FILE).replace_contents(new TextEncoder().encode(JSON.stringify(this._d)), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`[lucent-launcher] usage save: ${e.message}`);
        }
    }

    destroy() {
        if (this._dirty) {
            GLib.source_remove(this._dirty);
            this._dirty = 0;
            this.flush();
        }
    }
}
