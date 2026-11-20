// SPDX-License-Identifier: GPL-3.0-or-later
// Matching and scoring. Pure JS (no GI), unit-tested under plain gjs.
//
// score(query, text) -> 0..1000. Tiers, best first:
//   exact 1000 · prefix of the whole text 900 · every query word starts a text word 820
//   · initials ("vsc" -> Visual Studio Code) 760 · substring 620 · in-order subsequence 260..480
// Shorter texts win ties inside a tier, so "Files" beats "Files and Folders" for "fil".

const MARKS = /[̀-ͯ]/g;

export function fold(s) {
    return String(s ?? '').normalize('NFD').replace(MARKS, '').toLowerCase();
}

export function words(s) {
    // split on separators and camelCase/digit boundaries: "VISHWA-GP_SoftwareStack2" -> vishwa gp software stack 2
    return fold(String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2'))
        .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// Pre-folded record so per-keystroke scoring does no string work on the haystack.
export function prepare(text) {
    const f = fold(text);
    const w = words(text);
    return {f, w, initials: w.map(x => x[0]).join('')};
}

function subsequence(q, f) {
    // in-order subsequence with a gap penalty; returns 0..1 quality or -1
    let i = 0, gaps = 0, last = -1, firstAt = -1;
    for (let j = 0; j < f.length && i < q.length; j++) {
        if (f[j] === q[i]) {
            if (firstAt < 0)
                firstAt = j;
            if (last >= 0 && j !== last + 1)
                gaps++;
            last = j;
            i++;
        }
    }
    if (i < q.length)
        return -1;
    const spread = (last - firstAt + 1) / q.length; // 1 = contiguous
    return Math.max(0, 1 - 0.18 * gaps - 0.05 * (spread - 1) - 0.01 * firstAt);
}

// q: folded query string (non-empty). p: prepare()d record or a raw string.
export function score(q, p) {
    if (!q)
        return 0;
    if (typeof p === 'string')
        p = prepare(p);
    const {f, w} = p;
    if (!f)
        return 0;
    const lenPenalty = Math.min(60, Math.max(0, f.length - q.length));
    if (f === q)
        return 1000;
    if (f.startsWith(q))
        return 900 - lenPenalty;

    const qw = q.split(/\s+/).filter(Boolean);
    if (qw.length > 1) {
        // every query word must start some text word, in any order
        let all = true;
        for (const x of qw) {
            if (!w.some(y => y.startsWith(x))) {
                all = false;
                break;
            }
        }
        if (all)
            return 820 - lenPenalty;
        // or match the space-less join (e.g. "visual studio" vs "VisualStudio")
        const joined = qw.join('');
        if (f.replace(/[^\p{L}\p{N}]+/gu, '').includes(joined))
            return 600 - lenPenalty;
        return 0;
    }

    for (let k = 0; k < w.length; k++) {
        if (w[k].startsWith(q))
            return 840 - lenPenalty - k * 4;
    }
    if (q.length >= 2 && p.initials.startsWith(q))
        return 760 - lenPenalty;
    const at = f.indexOf(q);
    if (at >= 0)
        return 620 - lenPenalty - Math.min(40, at);
    if (q.length >= 2) {
        const s = subsequence(q, f);
        if (s >= 0)
            return Math.round(260 + 220 * s) - Math.round(lenPenalty / 2);
    }
    return 0;
}

// Best score over several fields with weights: [[prepared, weight], ...]
export function best(q, fields) {
    let top = 0;
    for (const [p, wgt] of fields) {
        if (!p)
            continue;
        const s = score(q, p) * wgt;
        if (s > top)
            top = s;
    }
    return top;
}

// Text completion for the ghost suffix: returns the rest of `text` if the raw query is a
// case-insensitive prefix of it, else ''.
export function completion(query, text) {
    if (!query || !text || text.length <= query.length)
        return '';
    return fold(text).startsWith(fold(query)) ? text.slice(query.length) : '';
}
