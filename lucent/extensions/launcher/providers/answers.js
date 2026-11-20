// SPDX-License-Identifier: GPL-3.0-or-later
// Instant answers, all synchronous: calculator, unit/currency conversion, time zones, date maths,
// colours, typed URLs and web shortcuts ("yt lofi"). Currency rates come from the ECB daily file,
// fetched only when a currency query is typed, cached 12 h in ~/.cache/lucent-launcher/rates.json.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {evaluate} from '../core/calc.js';
import {convert} from '../core/units.js';
import {dateMath, timeQuery} from '../core/query.js';
import {copyText, openUri, spawn} from '../core/util.js';

const RATES_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-launcher', 'rates.json']);
const RATES_TTL_MS = 12 * 3600 * 1000;
const COPY_HINTS = [['↩', 'Copy'], ['⌃↩', 'Open Calculator']];

const URL_RE = /^(?:(https?|ftp|file):\/\/\S+|(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/\S*)?|(?:[\w-]+\.)+(?:com|org|net|io|dev|app|ai|in|co|edu|gov|me|info|xyz|tech|ly|gg|tv|uk|de|fr|jp|ru|cn|us|ca|au|ch|nl|se|no|fi|it|es|br|mx|kr|sg|id|ac\.in|github\.io)(?::\d+)?(?:\/\S*)?)$/i;

function calcIcon() {
    return {name: 'accessories-calculator', fallback: 'accessories-calculator-symbolic'};
}

function hexToRgb(h) {
    let x = h.replace('#', '');
    if (x.length === 3)
        x = x.split('').map(c => c + c).join('');
    const n = parseInt(x, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

export class AnswersProvider {
    constructor(ctx) {
        this.id = 'answers';
        this.configKey = 'calculator';
        this.sync = true;
        this._ctx = ctx;
        this._rates = null;
        this._fetching = false;
        this._session = null;
        this._loadRates();
    }

    _loadRates() {
        try {
            const [, b] = Gio.File.new_for_path(CACHE).load_contents(null);
            this._rates = JSON.parse(new TextDecoder().decode(b));
        } catch {
            this._rates = null;
        }
    }

    _fetchRates() {
        if (this._fetching)
            return;
        this._fetching = true;
        this._session ??= new Soup.Session({timeout: 8});
        const msg = Soup.Message.new('GET', RATES_URL);
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            this._fetching = false;
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== 200)
                    throw new Error(`HTTP ${msg.get_status()}`);
                const xml = new TextDecoder().decode(bytes.toArray());
                const rates = {};
                for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g))
                    rates[m[1]] = Number(m[2]);
                const date = /time=['"]([\d-]+)['"]/.exec(xml)?.[1] ?? '';
                if (!Object.keys(rates).length)
                    throw new Error('no rates in response');
                this._rates = {base: 'EUR', rates, date, fetched: Date.now()};
                GLib.mkdir_with_parents(GLib.path_get_dirname(CACHE), 0o755);
                Gio.File.new_for_path(CACHE).replace_contents(new TextEncoder().encode(JSON.stringify(this._rates)), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._ctx.engine?.refresh(this.id);
            } catch (e) {
                console.warn(`[lucent-launcher] currency rates: ${e.message}`);
            }
        });
    }

    _answer(o) {
        return {section: 'answer', noLearn: true, kind: 'Answer', ...o};
    }

    search(q) {
        const out = [];
        const raw = q.raw.trim();
        if (!raw || q.kind)
            return out;
        const cfg = this._ctx.config;

        // calculator
        if (cfg.enabled('calculator') && q.prefix !== '>' && q.prefix !== '?') {
            const c = evaluate(q.prefix === '=' ? `=${q.text}` : raw);
            if (c) {
                const plain = String(Number(c.value.toPrecision(12)));
                const lines = [];
                if (c.hex)
                    lines.push(['Hex', c.hex], ['Binary', c.bin]);
                out.push(this._answer({
                    id: 'calc', title: c.display, subtitle: `${c.expr} =`, big: true, kind: 'Calculator',
                    icon: calcIcon(), score: 3000,
                    activate: () => copyText(plain),
                    secondary: () => spawn(['gnome-calculator', '-e', c.expr]),
                    copy: () => ({text: plain}),
                    preview: {type: 'answer', big: c.display, small: `${c.expr} =`, lines, gicon: null, iconName: 'accessories-calculator'},
                    hints: COPY_HINTS,
                }));
                return out;
            }
        }

        // conversions
        if (cfg.enabled('conversions') && !q.prefix) {
            const stale = !this._rates || Date.now() - (this._rates.fetched ?? 0) > RATES_TTL_MS;
            const r = convert(raw, {rates: this._rates, home: cfg.v.currency ?? ['INR', 'USD', 'EUR']});
            if (r) {
                if (r.category === 'currency' && stale)
                    this._fetchRates();
                if (r.pendingRates) {
                    out.push(this._answer({
                        id: 'conv:pending', title: 'Fetching exchange rates…', subtitle: r.input, kind: 'Currency',
                        icon: {name: 'emblem-synchronizing-symbolic'}, score: 2000, activate: () => {},
                    }));
                } else {
                    const all = r.results.map(x => [x.unit, x.display]);
                    r.results.forEach((x, i) => {
                        const plain = String(Number(x.value.toPrecision(10)));
                        out.push(this._answer({
                            id: `conv:${x.unit}`, title: x.display, subtitle: `${r.input} =`, big: i === 0, kind: r.category === 'currency' ? 'Currency' : 'Conversion',
                            icon: {name: r.category === 'currency' ? 'accessories-calculator' : 'accessories-calculator'},
                            score: (r.explicit || r.category === 'currency' ? 2600 : 1500) - i * 10,
                            activate: () => copyText(plain),
                            copy: () => ({text: plain}),
                            preview: {type: 'answer', big: x.display, small: `${r.input} =`, lines: all.filter(a => a[1] !== x.display),
                                foot: r.category === 'currency' && r.ratesDate ? `ECB reference rate of ${r.ratesDate}` : null, iconName: 'accessories-calculator'},
                            hints: [['↩', 'Copy']],
                        }));
                    });
                }
                return out;
            }
        }

        // time zones
        const t = timeQuery(raw);
        if (t) {
            const now = new Date();
            const time = now.toLocaleTimeString('en-GB', {timeZone: t.zone, hour: '2-digit', minute: '2-digit'});
            const day = now.toLocaleDateString('en-GB', {timeZone: t.zone, weekday: 'long', day: 'numeric', month: 'long'});
            const tz = GLib.TimeZone.new_identifier(t.zone) ?? GLib.TimeZone.new_utc();
            const there = GLib.DateTime.new_now(tz).get_utc_offset() / 1e6 / 60;
            const here = GLib.DateTime.new_now_local().get_utc_offset() / 1e6 / 60;
            const d = there - here;
            const off = d === 0 ? 'same time as here' : `${d > 0 ? '+' : '−'}${Math.floor(Math.abs(d) / 60)}:${String(Math.abs(d) % 60).padStart(2, '0')} from here`;
            out.push(this._answer({
                id: `tz:${t.zone}`, title: time, subtitle: `${t.place} · ${day}`, big: true, kind: 'World Clock',
                icon: {name: 'org.gnome.clocks', fallback: 'preferences-system-time-symbolic'}, score: 2800,
                activate: () => copyText(time), copy: () => ({text: time}),
                preview: {type: 'answer', big: time, small: t.place, lines: [['Date', day], ['Offset', off], ['Zone', t.zone]], iconName: 'org.gnome.clocks'},
                hints: [['↩', 'Copy']],
            }));
            return out;
        }

        // date maths
        const dm = dateMath(raw);
        if (dm) {
            out.push(this._answer({
                id: 'date', title: dm.title, subtitle: dm.subtitle, big: true, kind: 'Date',
                icon: {name: 'x-office-calendar', fallback: 'x-office-calendar-symbolic'}, score: 2800,
                activate: () => copyText(dm.copy), copy: () => ({text: dm.copy}),
                preview: {type: 'answer', big: dm.title, small: dm.subtitle, lines: [], iconName: 'x-office-calendar'},
                hints: [['↩', 'Copy']],
            }));
            return out;
        }

        // colours: #2190a4, #fff, rgb(33,144,164)
        let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
        let rgb = m ? hexToRgb(m[1]) : null;
        if (!rgb && (m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(raw)))
            rgb = [Number(m[1]), Number(m[2]), Number(m[3])].map(v => Math.min(255, v));
        if (rgb) {
            const hex = `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
            const [h, s, l] = rgbToHsl(...rgb);
            const rgbs = `rgb(${rgb.join(', ')})`;
            const hsl = `hsl(${h}, ${s}%, ${l}%)`;
            for (const [i, val] of [hex, rgbs, hsl].entries()) {
                if (val.toLowerCase() === raw.toLowerCase())
                    continue;
                out.push(this._answer({
                    id: `color:${i}`, title: val, subtitle: 'Colour', big: out.length === 0, kind: 'Colour',
                    icon: {color: hex}, score: 2700 - i,
                    activate: () => copyText(val), copy: () => ({text: val}),
                    preview: {type: 'answer', swatch: hex, big: hex, small: `${rgbs} · ${hsl}`, lines: [['Hex', hex], ['RGB', rgbs], ['HSL', hsl]]},
                    hints: [['↩', 'Copy']],
                }));
            }
            return out;
        }

        // typed URL
        if (!/\s/.test(raw) && URL_RE.test(raw)) {
            const url = /^[a-z]+:\/\//i.test(raw) ? raw : `${/^(localhost|\d)/.test(raw) ? 'http' : 'https'}://${raw}`;
            out.push(this._answer({
                id: `url:${url}`, title: raw, subtitle: 'Open in browser', kind: 'Website',
                icon: {gicon: this._browserIcon()}, score: 2400, noLearn: false,
                activate: () => openUri(url), copy: () => ({text: url}),
                preview: {type: 'web', url, title: raw},
                hints: [['↩', 'Open']],
            }));
        }

        // web shortcuts: "yt lofi", "gh llvm", "w riscv"
        const sm = /^(\S+)\s+(.+)$/.exec(raw);
        const shortcuts = cfg.v.webShortcuts ?? {};
        if (sm && shortcuts[sm[1].toLowerCase()]) {
            const key = sm[1].toLowerCase();
            const url = shortcuts[key].replace('%s', encodeURIComponent(sm[2]));
            const site = (/^https?:\/\/(?:www\.)?([^/]+)/.exec(url)?.[1] ?? key).replace(/\.(com|org)$/, '');
            const pretty = {youtube: 'YouTube', github: 'GitHub', 'en.wikipedia': 'Wikipedia', duckduckgo: 'DuckDuckGo'}[site] ?? site;
            out.push(this._answer({
                id: `ws:${key}`, title: `Search ${pretty} for “${sm[2]}”`, subtitle: url, kind: 'Web Search',
                icon: {gicon: this._browserIcon()}, score: 2500, noLearn: true,
                activate: () => openUri(url), copy: () => ({text: url}),
                preview: {type: 'web', url, title: `Search ${pretty}`},
                hints: [['↩', 'Search']],
            }));
        }
        return out;
    }

    _browserIcon() {
        try {
            return Gio.AppInfo.get_default_for_uri_scheme('https')?.get_icon() ?? null;
        } catch {
            return null;
        }
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}
