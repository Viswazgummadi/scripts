// SPDX-License-Identifier: GPL-3.0-or-later
// The search engine: runs providers, merges, ranks, groups. UI-agnostic.
//
// Result (what providers return):
//   {id, section, title, subtitle?, kind?, icon: {gicon|name|color|app}, score (0..1000+),
//    completion?, big?, activate(mods), secondary?(), copy?(), quickLook?(), reveal?(), remove?(),
//    preview?: {type, ...}, hints?: [[keys, label]], noTopHit?, noLearn?}
// Providers: {id, sync, delay?, modes?, minChars?, search(q, cancellable, mode), open?(), close?(), destroy()}
//
// View model handed to the UI on every change:
//   {query, mode, top: Result|null, sections: [{key, title, items: Result[], more: n}], pending, empty}
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {parse} from './query.js';

export const SECTIONS = {
    answer: {title: 'Answer', max: 4, bias: 0},
    quick: {title: 'Quick Keys', max: 3, bias: 0},
    apps: {title: 'Applications', max: 5, bias: 60},
    windows: {title: 'Open Windows', max: 4, bias: -10},
    actions: {title: 'Actions', max: 5, bias: 0},
    settings: {title: 'System Settings', max: 4, bias: 10},
    media: {title: 'Now Playing', max: 3, bias: -20},
    commands: {title: 'Commands', max: 4, bias: -30},
    folder: {title: 'Folders', max: 4, bias: -10},
    document: {title: 'Documents', max: 5, bias: -20},
    pdf: {title: 'PDF Documents', max: 5, bias: -20},
    presentation: {title: 'Presentations', max: 5, bias: -20},
    spreadsheet: {title: 'Spreadsheets', max: 5, bias: -20},
    image: {title: 'Images', max: 5, bias: -30},
    code: {title: 'Developer', max: 5, bias: -40},
    audio: {title: 'Music', max: 4, bias: -40},
    video: {title: 'Movies', max: 4, bias: -40},
    archive: {title: 'Archives', max: 3, bias: -50},
    other: {title: 'Files', max: 5, bias: -50},
    content: {title: 'Mentions', max: 4, bias: -80},
    clipboard: {title: 'Clipboard', max: 4, bias: -60},
    definition: {title: 'Definition', max: 1, bias: -100},
    web: {title: 'Search the Web', max: 4, bias: -2000},
    suggestions: {title: 'Suggestions', max: 4, bias: -2100},
};
// remote providers add their own sections at runtime (registerSection)
export function registerSection(key, title, max = 4, bias = -40) {
    if (!SECTIONS[key])
        SECTIONS[key] = {title, max, bias};
}

const LOCK_TOP_MS = 260;  // after this, a slower provider can't steal the top hit any more
const MODE_MAX = 60;      // per-section cap while a category (⌃1..4) is chosen

export class Engine {
    constructor({config, frecency, onUpdate}) {
        this.config = config;
        this.frecency = frecency;
        this._onUpdate = onUpdate;
        this.providers = [];
        this._gen = 0;
        this._results = new Map();
        this._pending = new Set();
        this._timers = new Set();
        this._cancellable = null;
        this._q = parse('');
        this._mode = null;
        this._started = 0;
        this._lockedTop = null;
        this._emitLater = 0;
        this._expanded = new Set();
    }

    // "Show More" on a section header: lift its cap for the current query
    expand(key) {
        this._expanded.add(key);
        this._emit();
    }

    add(provider) {
        this.providers.push(provider);
    }

    open() {
        for (const p of this.providers)
            p.open?.();
    }

    close() {
        this._cancel();
        for (const p of this.providers)
            p.close?.();
    }

    _cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const t of this._timers)
            GLib.source_remove(t);
        this._timers.clear();
        this._pending.clear();
        if (this._emitLater) {
            GLib.source_remove(this._emitLater);
            this._emitLater = 0;
        }
    }

    get query() {
        return this._q;
    }

    get mode() {
        return this._mode;
    }

    search(text, mode = null) {
        this._cancel();
        const gen = ++this._gen;
        this._q = parse(text);
        this._q.mode = mode;
        this._mode = mode;
        this._results = new Map();
        this._started = GLib.get_monotonic_time() / 1000;
        this._lockedTop = null;
        this._expanded = new Set();
        const q = this._q;
        const empty = !q.raw.trim() && !q.hasFilters;
        if (empty && !mode) {
            this._emit();
            return;
        }
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        for (const p of this.providers) {
            if (!this.config.enabled(p.configKey ?? p.id))
                continue;
            if (mode && !(p.modes ?? []).includes(mode))
                continue;
            if (!mode && empty)
                continue;
            if (p.minChars && q.raw.trim().length < p.minChars && !(mode && empty))
                continue;
            if (p.sync) {
                try {
                    this._results.set(p.id, p.search(q, null, mode) ?? []);
                } catch (e) {
                    console.error(`[lucent-launcher] ${p.id}: ${e.message}\n${e.stack}`);
                }
                continue;
            }
            this._pending.add(p.id);
            const run = () => {
                Promise.resolve(p.search(q, cancellable, mode)).then(res => {
                    if (gen !== this._gen)
                        return;
                    this._pending.delete(p.id);
                    this._results.set(p.id, res ?? []);
                    this._queueEmit();
                }).catch(e => {
                    if (gen !== this._gen)
                        return;
                    this._pending.delete(p.id);
                    if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`[lucent-launcher] ${p.id}: ${e?.message}\n${e?.stack}`);
                    this._queueEmit();
                });
            };
            const delay = typeof p.delay === 'function' ? p.delay(q) : (p.delay ?? 0);
            if (delay > 0) {
                const t = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    this._timers.delete(t);
                    if (gen === this._gen)
                        run();
                    return GLib.SOURCE_REMOVE;
                });
                this._timers.add(t);
            } else {
                run();
            }
        }
        this._emit();
    }

    // A provider learned something new for the current query (rates arrived, a definition loaded...)
    refresh(providerId) {
        const p = this.providers.find(x => x.id === providerId);
        if (!p || !p.sync)
            return;
        try {
            this._results.set(p.id, p.search(this._q, null, this._mode) ?? []);
        } catch (e) {
            console.error(`[lucent-launcher] ${p.id}: ${e.message}`);
        }
        this._queueEmit();
    }

    // coalesce bursts of async completions into one UI update per frame
    _queueEmit() {
        if (this._emitLater)
            return;
        this._emitLater = GLib.timeout_add(GLib.PRIORITY_HIGH_IDLE, 8, () => {
            this._emitLater = 0;
            this._emit();
            return GLib.SOURCE_REMOVE;
        });
    }

    finalScore(r) {
        const sec = SECTIONS[r.section] ?? {bias: -40};
        return (r.score ?? 0) + sec.bias + (r.noLearn ? 0 : this.frecency.boost(r.id, this._q.folded));
    }

    _emit() {
        const q = this._q;
        const mode = this._mode;
        const all = [];
        const seen = new Set();
        for (const list of this._results.values()) {
            for (const r of list) {
                if (!r || seen.has(r.id))
                    continue;
                seen.add(r.id);
                r._final = this.finalScore(r);
                all.push(r);
            }
        }

        // top hit: the best result that may be one; stays put once the user had time to see it
        let top = null;
        if (!mode) {
            for (const r of all) {
                if (r.noTopHit || r._final < 360)
                    continue;
                if (!top || r._final > top._final)
                    top = r;
            }
            const now = GLib.get_monotonic_time() / 1000;
            if (this._lockedTop && all.includes(this._lockedTop))
                top = this._lockedTop;
            else if (top && now - this._started > LOCK_TOP_MS)
                this._lockedTop = top;
            // the web fallback is only a top hit when nothing else matched
            if (top && top.section === 'web' && all.some(r => r.section !== 'web' && r.section !== 'suggestions'))
                top = null;
        }

        const groups = new Map();
        for (const r of all) {
            if (r === top)
                continue;
            let g = groups.get(r.section);
            if (!g) {
                g = [];
                groups.set(r.section, g);
            }
            g.push(r);
        }
        const sections = [];
        for (const [key, items] of groups) {
            items.sort((a, b) => b._final - a._final || (a.title ?? '').localeCompare(b.title ?? ''));
            const def = SECTIONS[key] ?? {title: key, max: 4};
            const max = mode || this._expanded.has(key) ? MODE_MAX : def.max;
            sections.push({key, title: def.title, items: items.slice(0, max), more: Math.max(0, items.length - max), best: items[0]._final});
        }
        const pinned = k => (k === 'answer' ? -2 : k === 'quick' ? -1 : k === 'web' ? 2 : k === 'suggestions' ? 3 : 0);
        const order = Object.keys(SECTIONS);
        sections.sort((a, b) => pinned(a.key) - pinned(b.key) || b.best - a.best || order.indexOf(a.key) - order.indexOf(b.key));

        this._onUpdate?.({
            query: q,
            mode,
            top,
            sections,
            pending: this._pending.size > 0,
            empty: !top && sections.length === 0,
        });
    }

    learn(r) {
        if (r && !r.noLearn)
            this.frecency.record(r.id, this._q.folded);
    }

    destroy() {
        this._cancel();
        for (const p of this.providers) {
            try {
                p.destroy?.();
            } catch (e) {
                console.error(`[lucent-launcher] destroy ${p.id}: ${e.message}`);
            }
        }
        this.providers = [];
        this._onUpdate = null;
    }
}
