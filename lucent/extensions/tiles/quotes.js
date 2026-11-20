// SPDX-License-Identifier: GPL-3.0-or-later
// Picks a quote for "now" from a rules file (date, day, time, calendar event aware).
//
// The live rules file is ~/.config/lucent-tiles/quotes.json (copied from the bundled
// quotes.json on first run, then yours to edit; it is re-read on every pick, no restart needed).
// See the "_help" key in quotes.json for the rule syntax.
import GLib from 'gi://GLib';

const decoder = new TextDecoder();
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SPECIAL = 50; // rules at or above this priority take over; below it they blend with "general"

const pad = n => String(n).padStart(2, '0');
const asArray = v => (Array.isArray(v) ? v : [v]);

export function dateKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayOfYear(d) {
    const start = new Date(d.getFullYear(), 0, 1);
    return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 86400000) + 1;
}

function daysInYear(y) {
    return new Date(y, 1, 29).getMonth() === 1 ? 366 : 365;
}

function lastDayOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function md(d) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function weekdayIndex(name) {
    return WEEKDAYS.indexOf(String(name).slice(0, 3).toLowerCase());
}

// Each condition returns true/false; a rule matches when every condition in "when" holds.
const CONDITIONS = {
    date: (v, now) => asArray(v).some(s => s === md(now) || s === dateKey(now)),

    dateRange: ([from, to], now) => {
        const t = md(now);
        return from <= to ? t >= from && t <= to : t >= from || t <= to; // wraps over new year
    },

    weekday: (v, now) => asArray(v).some(w => weekdayIndex(w) === now.getDay()),

    month: (v, now) => asArray(v).some(m => Number(m) === now.getMonth() + 1),

    hours: ([from, to], now) => {
        const h = now.getHours();
        return from <= to ? h >= from && h < to : h >= from || h < to; // [22, 5] wraps midnight
    },

    monthDay: (v, now) => asArray(v).some(x => {
        if (x === 'first')
            return now.getDate() === 1;
        if (x === 'last')
            return now.getDate() === lastDayOfMonth(now);
        return Number(x) === now.getDate();
    }),

    // {"n": 2, "weekday": "tue", "month": 10}; n = -1 means the last one in the month.
    nthWeekday: (v, now) => asArray(v).some(({n, weekday, month}) => {
        if (month && Number(month) !== now.getMonth() + 1)
            return false;
        if (weekdayIndex(weekday) !== now.getDay())
            return false;
        const nth = Math.ceil(now.getDate() / 7);
        const fromEnd = Math.ceil((lastDayOfMonth(now) - now.getDate() + 1) / 7);
        return n > 0 ? nth === n : fromEnd === -n;
    }),

    // 256 = Programmers' Day; negative counts from the end of the year (-1 = Dec 31).
    dayOfYear: (v, now) => asArray(v).some(n => {
        const doy = dayOfYear(now);
        return n > 0 ? doy === n : daysInYear(now.getFullYear()) - doy + 1 === -n;
    }),

    // Substring match (case-insensitive) against today's calendar events.
    event: (v, now, ctx) => asArray(v).some(s => ctx.events.some(e => e.toLowerCase().includes(String(s).toLowerCase()))),

    anyEvent: (v, now, ctx) => (ctx.events.length > 0) === Boolean(v),
};

function matches(rule, now, ctx) {
    const when = rule.when ?? {};
    for (const [key, val] of Object.entries(when)) {
        const cond = CONDITIONS[key];
        if (!cond) {
            console.warn(`lucent-tiles: unknown condition "${key}"`);
            return false;
        }
        if (!cond(val, now, ctx))
            return false;
    }
    return true;
}

function normalize(q, rule) {
    if (typeof q === 'string')
        return {text: q, by: rule?.by ?? null, tag: rule?.tag ?? null};
    return {text: String(q.text ?? ''), by: q.by ?? rule?.by ?? null, tag: q.tag ?? rule?.tag ?? null};
}

function fill(template, now, ctx) {
    const toWeekend = (6 - now.getDay() + 7) % 7; // days to Saturday
    const vars = {
        name: ctx.name,
        event: ctx.events[0] ?? '',
        weekday: now.toLocaleDateString(undefined, {weekday: 'long'}),
        date: now.toLocaleDateString(undefined, {day: 'numeric', month: 'long'}),
        time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
        year: String(now.getFullYear()),
        dayOfYear: String(dayOfYear(now)),
        daysLeft: String(daysInYear(now.getFullYear()) - dayOfYear(now)),
        daysToWeekend: String(toWeekend),
    };
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function firstName() {
    const real = GLib.get_real_name();
    const raw = real && real !== 'Unknown' ? real.split(/\s+/)[0] : GLib.get_user_name();
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export class QuoteBook {
    constructor(extensionPath, configName = 'lucent-tiles') {
        this._bundled = GLib.build_filenamev([extensionPath, 'quotes.json']);
        this._userDir = GLib.build_filenamev([GLib.get_user_config_dir(), configName]);
        this.userFile = GLib.build_filenamev([this._userDir, 'quotes.json']);
        this._last = null;
        this._ensureUserFile();
    }

    _ensureUserFile() {
        if (GLib.file_test(this.userFile, GLib.FileTest.EXISTS))
            return;
        try {
            GLib.mkdir_with_parents(this._userDir, 0o755);
            const [, bytes] = GLib.file_get_contents(this._bundled);
            GLib.file_set_contents(this.userFile, bytes);
        } catch (e) {
            console.warn(`lucent-tiles: could not create ${this.userFile}: ${e.message}`);
        }
    }

    _load() {
        for (const path of [this.userFile, this._bundled]) {
            try {
                const [ok, bytes] = GLib.file_get_contents(path);
                if (ok)
                    return JSON.parse(decoder.decode(bytes));
            } catch (e) {
                console.warn(`lucent-tiles: ${path}: ${e.message}`);
            }
        }
        return {rules: [], general: []};
    }

    // Returns {text, by, tag, why} where "why" names the rule that won (handy when testing).
    pick(now = new Date(), events = []) {
        const book = this._load();
        const ctx = {events, name: firstName()};

        const hits = (book.rules ?? []).filter(r => matches(r, now, ctx));
        const top = Math.max(-Infinity, ...hits.map(r => r.priority ?? 10));

        let pool;
        if (top >= SPECIAL) {
            // A special day: only the highest-priority matching rules count.
            pool = hits.filter(r => (r.priority ?? 10) === top)
                .flatMap(r => asArray(r.quotes ?? []).map(q => ({...normalize(q, r), why: r.name ?? 'rule'})));
        } else {
            // An ordinary day: weekday/time-of-day lines blend with the general pool;
            // "weight" repeats a rule's quotes to make them more likely.
            pool = hits.flatMap(r => {
                const qs = asArray(r.quotes ?? []).map(q => ({...normalize(q, r), why: r.name ?? 'rule'}));
                return Array.from({length: Math.max(1, r.weight ?? 1)}, () => qs).flat();
            });
            pool.push(...asArray(book.general ?? []).map(q => ({...normalize(q), why: 'general'})));
        }
        pool = pool.filter(q => q.text);
        if (pool.length === 0)
            return null;

        let choice;
        for (let tries = 0; tries < 5; tries++) {
            choice = pool[Math.floor(Math.random() * pool.length)];
            if (pool.length === 1 || choice.text !== this._last)
                break;
        }
        this._last = choice.text;
        return {...choice, text: fill(choice.text, now, ctx), by: choice.by ? fill(choice.by, now, ctx) : null};
    }

    // Like pick(), but tries to find one that fits in maxChars (text + author), e.g. for the top bar.
    pickFitting(maxChars, now = new Date(), events = []) {
        const len = q => q.text.length + (q.by ? q.by.length + 3 : 0);
        let best = null;
        for (let i = 0; i < 16; i++) {
            const q = this.pick(now, events);
            if (!q)
                return null;
            if (len(q) <= maxChars)
                return q;
            if (!best || len(q) < len(best))
                best = q;
        }
        return best;
    }
}
