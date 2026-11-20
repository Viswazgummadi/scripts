// SPDX-License-Identifier: GPL-3.0-or-later
// "Search the Web for …" (always offered last, ⌃B from anywhere), optional live suggestions
// (DuckDuckGo, off by default), and the dictionary (offline word check with `look`, the
// definition is fetched only when you select the row).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import {capture, copyText, openUri} from '../core/util.js';

let session = null;
function getJson(url, cancellable) {
    session ??= new Soup.Session({timeout: 6, user_agent: 'lucent-launcher'});
    const msg = Soup.Message.new('GET', url);
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== 200)
                    throw new Error(`HTTP ${msg.get_status()}`);
                resolve(JSON.parse(new TextDecoder().decode(bytes.toArray())));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function abortHttp() {
    session?.abort();
    session = null;
}

function browserIcon() {
    try {
        return Gio.AppInfo.get_default_for_uri_scheme('https')?.get_icon() ?? null;
    } catch {
        return null;
    }
}

export function webSearchUrl(config, text) {
    return (config.v.searchEngine ?? 'https://www.google.com/search?q=%s').replace('%s', encodeURIComponent(text));
}

export class WebProvider {
    constructor(ctx) {
        this.id = 'web';
        this.sync = true;
        this._ctx = ctx;
    }

    search(q) {
        const text = q.prefix === '?' ? q.text : q.raw.trim();
        // a kind guessed from plain words ("pdf stitcher") still offers the web; "kind:pdf" does not
        if (!text || q.prefix === '>' || (q.kind && !q.natural))
            return [];
        const url = webSearchUrl(this._ctx.config, text);
        const engine = /https?:\/\/(?:www\.)?([^./]+)/.exec(url)?.[1] ?? 'the web';
        return [{
            id: 'web:search', section: 'web', noLearn: true,
            title: `Search the Web for “${text}”`, subtitle: engine.charAt(0).toUpperCase() + engine.slice(1),
            kind: 'Web Search', icon: {gicon: browserIcon(), name: 'web-browser'},
            score: q.prefix === '?' ? 5000 : 0,
            activate: () => openUri(url), copy: () => ({text: url}),
            preview: {type: 'web', url, title: `Search for “${text}”`},
            hints: [['↩', 'Search'], ['⌃B', 'Search the Web']],
        }];
    }

    destroy() {}
}

export class SuggestProvider {
    constructor(ctx) {
        this.id = 'suggest';
        this.configKey = 'web';
        this.sync = false;
        this.delay = 220;
        this.minChars = 3;
        this._ctx = ctx;
    }

    async search(q, cancellable) {
        if (!this._ctx.config.v.webSuggestions || q.prefix === '>' || q.kind || !q.text)
            return [];
        const data = await getJson(`https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q.text)}`, cancellable).catch(() => null);
        const list = Array.isArray(data) ? data[1] ?? [] : [];
        return list.filter(s => s.toLowerCase() !== q.text.toLowerCase()).slice(0, 4).map((s, i) => {
            const url = webSearchUrl(this._ctx.config, s);
            return {
                id: `suggest:${s}`, section: 'suggestions', noLearn: true, noTopHit: true,
                title: s, subtitle: 'Suggestion', kind: 'Web Search', icon: {name: 'system-search-symbolic'}, score: 100 - i,
                activate: () => openUri(url), copy: () => ({text: s}),
                preview: {type: 'web', url, title: s},
                hints: [['↩', 'Search']],
            };
        });
    }

    destroy() {}
}

// ---- dictionary ---------------------------------------------------------------------------------
const defCache = new Map(); // word -> {phonetic, meanings:[{pos, defs:[...]}]} | false

export async function define(word, cancellable = null) {
    if (defCache.has(word))
        return defCache.get(word);
    try {
        const data = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, cancellable);
        const e = data[0];
        const meanings = [];
        for (const d of data) {
            for (const m of d.meanings ?? []) {
                let g = meanings.find(x => x.pos === m.partOfSpeech);
                if (!g) {
                    g = {pos: m.partOfSpeech, defs: []};
                    meanings.push(g);
                }
                for (const x of m.definitions ?? []) {
                    if (g.defs.length < 4)
                        g.defs.push(x.definition);
                }
            }
        }
        const r = {word: e.word, phonetic: e.phonetic ?? e.phonetics?.find(p => p.text)?.text ?? '', meanings};
        defCache.set(word, r);
        if (defCache.size > 64)
            defCache.delete(defCache.keys().next().value);
        return r;
    } catch (e) {
        if (!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            defCache.set(word, false);
        return false;
    }
}

export class DictionaryProvider {
    constructor(ctx) {
        this.id = 'dictionary';
        this.sync = false;
        this.delay = 160;
        this.minChars = 3;
        this._ctx = ctx;
    }

    async search(q, cancellable) {
        // "serendipity", or asked outright: "define x", "definition of x", "meaning of x", "x meaning"
        const raw = q.raw.trim().toLowerCase();
        const asked = /^(?:define|definition of|meaning of|what does)\s+(\S+?)(?:\s+mean)?\??$/.exec(raw) ??
            /^(\S+)\s+(?:meaning|definition)$/.exec(raw);
        const w = asked ? asked[1] : raw;
        if (q.prefix || q.kind || !/^[a-z][a-z'-]{2,30}$/.test(w))
            return [];
        const hit = (await capture(['look', '-f', w], cancellable)).split('\n').some(x => x.toLowerCase() === w);
        if (!hit)
            return [];
        const cached = defCache.get(w);
        const first = cached ? `${cached.meanings[0]?.pos ?? ''} · ${cached.meanings[0]?.defs[0] ?? ''}` : 'Definition';
        const online = this._ctx.config.v.onlineDefinitions !== false;
        return [{
            id: `def:${w}`, section: 'definition', noLearn: true,
            title: w, subtitle: first, kind: 'Dictionary',
            icon: {name: 'accessories-dictionary', fallback: 'accessories-dictionary-symbolic'}, score: asked ? 2400 : 300,
            activate: () => openUri(`https://en.wiktionary.org/wiki/${encodeURIComponent(w)}`),
            copy: () => {
                const d = defCache.get(w);
                return {text: d ? d.meanings.map(m => `${m.pos}: ${m.defs[0]}`).join('\n') : w};
            },
            preview: {type: 'definition', word: w, online},
            hints: [['↩', 'Open in Wiktionary'], ['⌃C', 'Copy Definition']],
        }];
    }

    destroy() {}
}

export {copyText};
