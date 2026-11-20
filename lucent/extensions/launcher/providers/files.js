// SPDX-License-Identifier: GPL-3.0-or-later
// Files, from two sources merged by URI:
//  - localsearch (live index of the XDG folders): names, full-text content with a snippet, kinds, dates
//  - plocate (daily whole-disk name index, ~6 ms): names everywhere under fileRoots, incl. git trees
// Empty query in the Files category (⌃2) lists recently used files (recently-used.xbel).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {fold, prepare, score} from '../core/fuzzy.js';
import {KINDS, kindOf} from '../core/query.js';
import {expandHome} from '../core/config.js';
import {HOME, capture, copyFiles, openUri, quickLook, reveal, tildify} from '../core/util.js';

let Tsparql = null;
try {
    Tsparql = (await import('gi://Tsparql?version=3.0')).default;
} catch {
    Tsparql = null;
}

const ATTRS = 'standard::type,standard::content-type,standard::size,standard::icon,time::modified,standard::is-hidden';
const NOISY = ['/build/', '/.local/', '/.config/', '/node_modules/', '/vendor/', '/third_party/', '/test/', '/tests/', '/out/', '/dist/', '/target/'];
const HINTS = [['↩', 'Open'], ['⌃↩', 'Show in Files'], ['⌃Y', 'Quick Look'], ['⌃C', 'Copy']];

function str(cur, i) {
    const v = cur.get_string(i);
    return Array.isArray(v) ? v[0] : v;
}

function nextRow(cur, cancellable) {
    return new Promise((resolve, reject) => {
        cur.next_async(cancellable, (c, res) => {
            try {
                resolve(c.next_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function queryInfo(file, cancellable) {
    return new Promise(resolve => {
        file.query_info_async(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
            try {
                resolve(f.query_info_finish(res));
            } catch {
                resolve(null);
            }
        });
    });
}

function escapeLiteral(s) {
    return Tsparql?.sparql_escape_string ? Tsparql.sparql_escape_string(s) : s.replace(/["\\]/g, '\\$&');
}

function iso(ms) {
    return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

export class FilesProvider {
    constructor(ctx) {
        this.id = 'files';
        this.sync = false;
        this.modes = ['files'];
        this._ctx = ctx;
        this._conn = null;
        this._connTried = false;
        this.delay = q => (q.folded.length <= 2 ? 140 : 60);
    }

    _connection() {
        if (!this._connTried) {
            this._connTried = true;
            try {
                if (Tsparql)
                    this._conn = Tsparql.SparqlConnection.bus_new('org.freedesktop.LocalSearch3', null, null);
            } catch (e) {
                console.warn(`[lucent-launcher] localsearch unavailable: ${e.message}`);
            }
        }
        return this._conn;
    }

    async _sparql(sparql, cancellable, cols) {
        const conn = this._connection();
        if (!conn)
            return [];
        const cur = await new Promise((resolve, reject) => {
            conn.query_async(sparql, cancellable, (c, res) => {
                try {
                    resolve(c.query_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        const rows = [];
        try {
            while (rows.length < 80 && await nextRow(cur, cancellable)) {
                const row = {};
                cols.forEach((c, i) => {
                    row[c] = str(cur, i);
                });
                rows.push(row);
            }
        } finally {
            cur.close();
        }
        return rows;
    }

    _ftsTerms(q) {
        const ws = q.folded.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 1);
        return ws.length ? ws.map(w => `${w}*`).join(' ') : null;
    }

    _dateFilter(q, v = '?mod') {
        const parts = [];
        if (q.after !== null)
            parts.push(`${v} >= "${iso(q.after)}"^^xsd:dateTime`);
        if (q.before !== null)
            parts.push(`${v} < "${iso(q.before)}"^^xsd:dateTime`);
        return parts.length ? `FILTER(${parts.join(' && ')})` : '';
    }

    async _localsearch(q, cancellable) {
        const out = [];
        const fts = this._ftsTerms(q);
        const date = this._dateFilter(q);
        if (fts) {
            const m = escapeLiteral(fts);
            const byName = this._sparql(`SELECT DISTINCT ?url ?mod ?mime WHERE {
                ?f a nfo:FileDataObject ; fts:match "${m}" ; nie:url ?url ; nfo:fileLastModified ?mod .
                OPTIONAL { ?ie nie:isStoredAs ?f ; nie:mimeType ?mime } ${date} } LIMIT 60`, cancellable, ['url', 'mod', 'mime']);
            const byContent = q.folded.length >= 3 ? this._sparql(`SELECT DISTINCT ?url ?mod ?mime (fts:snippet(?ie, "\u0001", "\u0002", "…", 9) AS ?snip) WHERE {
                ?ie fts:match "${m}" ; nie:isStoredAs ?f ; nie:mimeType ?mime . ?f nie:url ?url ; nfo:fileLastModified ?mod . ${date}
                } ORDER BY DESC(fts:rank(?ie)) LIMIT 30`, cancellable, ['url', 'mod', 'mime', 'snip']) : Promise.resolve([]);
            const [a, b] = await Promise.all([byName.catch(() => []), byContent.catch(() => [])]);
            for (const r of a)
                out.push({...r, via: 'name'});
            for (const r of b)
                out.push({...r, via: 'content'});
        }
        if (!fts || q.kindHint) {
            if (!q.hasFilters && !q.kindHint)
                return out;
            const kind = q.kind ?? q.kindHint;
            const mimes = kind ? (KINDS[kind]?.mime ?? []) : [];
            const mf = mimes.length ? `FILTER(${mimes.map(m => `STRSTARTS(?mime, "${m}")`).join(' || ')})` : '';
            // "screenshots today", "pdfs from last week", "pdfs": filters only, newest first
            const rows = await this._sparql(`SELECT DISTINCT ?url ?mod ?mime WHERE {
                ?f a nfo:FileDataObject ; nie:url ?url ; nfo:fileLastModified ?mod . ?ie nie:isStoredAs ?f ; nie:mimeType ?mime . ${date} ${mf}
                } ORDER BY DESC(?mod) LIMIT ${q.kindHint ? 30 : 80}`, cancellable, ['url', 'mod', 'mime']).catch(() => []);
            for (const r of rows)
                out.push({...r, via: q.kindHint && !q.kind ? 'kindhint' : 'filter'});
        }
        return out;
    }

    async _plocate(q, cancellable) {
        // Only filters ("kind:pdf", "ext:md"): look the extensions up by name, so files the indexer
        // does not cover (outside its folders, inside source trees) are found too.
        // A lone kind word ("pdfs", "screenshots") is the same request as "kind:pdf".
        const kindOnly = byKindOnly(q);
        const exts = kindOnly ? KINDS[q.kindHint]?.ext ?? [] : !q.folded ? (q.ext ? [q.ext] : KINDS[q.kind]?.ext ?? []) : [];
        if (exts.length) {
            const roots = (this._ctx.config.v.fileRoots ?? ['~']).map(r => expandHome(r).replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            const re = `^(${roots.join('|')})/.*\\.(${exts.map(e => e.replace(/[^a-z0-9]/gi, '')).join('|')})$`;
            const text = await capture(['plocate', '-i', '-l', '3000', '--regex', re], cancellable);
            return this._located(text, []).slice(0, 300).map(r => ({...r, via: kindOnly ? 'kindhint' : r.via}));
        }
        if (!q.folded || q.folded.length < 2)
            return [];
        const terms = q.folded.split(/\s+/).filter(Boolean);
        const needle = [...terms].sort((a, b) => b.length - a.length)[0];
        const text = await capture(['plocate', '-i', '-b', '-l', '3000', '--', needle], cancellable);
        return this._located(text, terms);
    }

    // plocate's lines, kept to the configured roots and out of excluded paths, whose names hold every term
    _located(text, terms) {
        if (!text)
            return [];
        const roots = (this._ctx.config.v.fileRoots ?? ['~']).map(r => expandHome(r).replace(/\/$/, ''));
        const excl = this._ctx.config.v.excludePaths ?? [];
        const out = [];
        for (const path of text.split('\n')) {
            if (!path || !roots.some(r => path === r || path.startsWith(`${r}/`)))
                continue;
            if (excl.some(x => path.includes(x)))
                continue;
            const base = fold(GLib.path_get_basename(path));
            if (!terms.every(t => base.includes(t)))
                continue;
            out.push({path, via: 'locate'});
            if (out.length >= 400)
                break;
        }
        return out;
    }

    _recent() {
        const out = [];
        try {
            const bf = new GLib.BookmarkFile();
            bf.load_from_file(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
            const uris = bf.get_uris();
            const rows = [];
            for (const uri of uris) {
                if (!uri.startsWith('file://'))
                    continue;
                let t = 0;
                try {
                    t = bf.get_visited_date_time(uri).to_unix() * 1000;
                } catch {
                    try {
                        t = bf.get_modified_date_time(uri).to_unix() * 1000;
                    } catch {
                        t = 0;
                    }
                }
                rows.push({uri, t});
            }
            rows.sort((a, b) => b.t - a.t);
            for (const r of rows.slice(0, 60))
                out.push({url: r.uri, via: 'recent', used: r.t});
        } catch {
            // no history yet
        }
        return out;
    }

    async search(q, cancellable, mode) {
        if (q.prefix)
            return [];
        if (!q.folded && !q.hasFilters && mode !== 'files')
            return [];

        let rows;
        if (!q.folded && !q.hasFilters) {
            rows = this._recent();
        } else {
            const [a, b] = await Promise.all([this._localsearch(q, cancellable), this._plocate(q, cancellable)]);
            rows = [...a, ...b];
        }

        // merge by uri, keep the richest record
        const byUri = new Map();
        for (const r of rows) {
            const uri = r.url ?? Gio.File.new_for_path(r.path).get_uri();
            const prev = byUri.get(uri);
            if (prev) {
                prev.snip ??= r.snip;
                prev.mime ??= r.mime;
                prev.via = prev.via === 'content' && r.via !== 'content' ? r.via : prev.via;
                continue;
            }
            byUri.set(uri, {...r, uri});
        }

        // pre-score on the name so only the best candidates get a stat()
        const cands = [];
        for (const r of byUri.values()) {
            const file = Gio.File.new_for_uri(r.uri);
            const path = file.get_path();
            if (!path)
                continue;
            const name = GLib.path_get_basename(path);
            let s;
            if (r.via === 'recent')
                s = 700;
            else if (r.via === 'filter' && !q.folded)
                s = 600;
            else if (r.via === 'kindhint')
                s = 640;
            else
                s = q.folded ? score(q.folded, prepare(name)) : 500;
            if (r.via === 'content' && s < 420)
                s = 420;
            if (s <= 0)
                continue;
            const rel = path.startsWith(HOME) ? path.slice(HOME.length) : path;
            const depth = rel.split('/').length;
            s -= Math.min(90, depth * 6);
            if (/\/\.[^/]+\//.test(rel) || name.startsWith('.'))
                s -= 160;
            if (NOISY.some(n => rel.includes(n)))
                s -= 120;
            cands.push({...r, file, path, name, s});
        }
        cands.sort((a, b) => b.s - a.s);
        // a search by filters alone ranks by date, which needs a stat() of every candidate
        const byDate = (!q.folded && q.hasFilters) || byKindOnly(q);
        const top = cands.slice(0, byDate ? 200 : mode === 'files' ? 80 : 40);

        const infos = await Promise.all(top.map(c => queryInfo(c.file, cancellable)));
        const now = Date.now();
        const out = [];
        top.forEach((c, i) => {
            const info = infos[i];
            if (!info)
                return; // gone since indexing
            const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
            const mime = isDir ? 'inode/directory' : (info.get_content_type() ?? c.mime ?? '');
            const mtime = (info.get_modification_date_time()?.to_unix() ?? 0) * 1000;
            const kind = kindOf(c.name, mime);
            if (q.kind && kind !== q.kind)
                return;
            if (c.via === 'kindhint' && kind !== q.kindHint)
                return;
            if (q.ext && !c.name.toLowerCase().endsWith(`.${q.ext}`))
                return;
            if (q.inDir && !fold(c.path).includes(fold(q.inDir)))
                return;
            if (q.after !== null && (mtime < q.after || (q.before !== null && mtime >= q.before)))
                return;
            let s = c.s;
            if (now - mtime < 7 * 86400000)
                s += 30;
            if (byDate) // filters alone: newest first
                s += Math.max(0, 80 - Math.floor((now - mtime) / 86400000));
            if (c.via === 'recent')
                s += 200 - i * 3;
            const section = c.via === 'content' && score(q.folded, prepare(c.name)) === 0 ? 'content' : (kind === 'other' ? 'other' : kind);
            const parent = GLib.path_get_dirname(c.path);
            const kindLabel = isDir ? 'Folder' : (Gio.content_type_get_description(mime) || 'Document');
            out.push({
                id: `file:${c.uri}`,
                section,
                title: c.name,
                subtitle: c.snip ? c.snip.replace(/[\u0001\u0002]/g, '') : tildify(parent),
                snippet: c.snip ?? null,
                kind: kindLabel,
                icon: {file: c.path, gicon: info.get_icon(), mime, isDir},
                score: s,
                completion: c.name,
                activate: () => openUri(c.uri),
                secondary: () => reveal(c.uri),
                quickLook: () => quickLook(c.uri),
                reveal: c.uri,
                copy: () => ({uris: [c.uri], text: c.path}),
                copyPath: () => ({text: c.path}),
                preview: {type: 'file', uri: c.uri, path: c.path, name: c.name, mime, kindLabel, isDir,
                    size: isDir ? null : info.get_size(), mtime, snippet: c.snip ?? null, gicon: info.get_icon()},
                hints: HINTS,
            });
        });
        return out;
    }

    destroy() {
        this._conn?.close?.();
        this._conn = null;
    }
}

// The whole query is one word that names a kind of file: "pdfs", "screenshots", "videos".
function byKindOnly(q) {
    return Boolean(q.kindHint) && !q.kind && !/\s/.test(q.folded ?? '') && (q.folded ?? '').length > 0;
}

export {KINDS, copyFiles};
