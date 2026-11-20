// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard history (macOS Tahoe's ⌘4). Memory-only by default; entries older than
// retentionHours are trimmed. Images are kept as files in ~/.cache/lucent-launcher/clip (max 24).
// Password managers that mark their copies (x-kde-passwordManagerHint) are never recorded.
// ↩ puts the entry back and pastes it into the focused app; ⌃↩ only copies.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import {fold} from '../core/fuzzy.js';
import {copyImage, copyText, pasteSoon, relTime} from '../core/util.js';

const IMG_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-launcher', 'clip']);
const STATE = GLib.build_filenamev([GLib.get_user_state_dir(), 'lucent-launcher', 'clipboard.json']);
const MAX_TEXT = 100000;
const MAX_IMAGES = 24;
const SECRET_HINTS = ['x-kde-passwordManagerHint', 'application/x-kde-passwordManagerHint'];

export class ClipboardProvider {
    constructor(ctx) {
        this.id = 'clipboard';
        this.sync = true;
        this.modes = ['clipboard'];
        this._ctx = ctx;
        this._items = []; // newest first: {text?|image?, t, f (folded text)}
        this._clip = St.Clipboard.get_default();
        const cfg = ctx.config.v.clipboard ?? {};
        if (cfg.persist)
            this._load();
        this._sel = global.display.get_selection();
        this._sel.connectObject('owner-changed', (sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD && this._ctx.config.v.clipboard?.enabled !== false)
                this._capture();
        }, this);
    }

    _capture() {
        const mimes = this._clip.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        if (mimes.some(m => SECRET_HINTS.includes(m)))
            return;
        const hasText = mimes.some(m => m.startsWith('text/plain') || m === 'UTF8_STRING' || m === 'STRING');
        if (!hasText && mimes.includes('image/png')) {
            this._clip.get_content(St.ClipboardType.CLIPBOARD, 'image/png', (c, bytes) => {
                if (!bytes || bytes.get_size() === 0 || bytes.get_size() > 12 * 1024 * 1024)
                    return;
                const data = bytes.toArray();
                const sum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes);
                const path = GLib.build_filenamev([IMG_DIR, `${sum}.png`]);
                try {
                    GLib.mkdir_with_parents(IMG_DIR, 0o700);
                    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                        GLib.file_set_contents(path, data);
                } catch (e) {
                    console.warn(`[lucent-launcher] clipboard image: ${e.message}`);
                    return;
                }
                this._push({image: path, t: Date.now(), f: 'image picture screenshot'});
            });
            return;
        }
        if (!hasText)
            return;
        this._clip.get_text(St.ClipboardType.CLIPBOARD, (c, text) => {
            if (!text || !text.trim())
                return;
            if (text.length > MAX_TEXT)
                text = text.slice(0, MAX_TEXT);
            this._push({text, t: Date.now(), f: fold(text.slice(0, 4000))});
        });
    }

    _push(item) {
        this._items = this._items.filter(x => (item.text ? x.text !== item.text : x.image !== item.image));
        this._items.unshift(item);
        this._trim();
        if (this._ctx.config.v.clipboard?.persist)
            this._save();
    }

    _trim() {
        const cfg = this._ctx.config.v.clipboard ?? {};
        const max = cfg.max ?? 120;
        const keepMs = (cfg.retentionHours ?? 8) * 3600 * 1000;
        const now = Date.now();
        const dropped = [];
        let images = 0;
        this._items = this._items.filter((x, i) => {
            const keep = i < max && now - x.t < keepMs && (!x.image || ++images <= MAX_IMAGES);
            if (!keep && x.image)
                dropped.push(x.image);
            return keep;
        });
        for (const p of dropped) {
            if (!this._items.some(x => x.image === p))
                GLib.unlink(p);
        }
    }

    _load() {
        try {
            const [, b] = Gio.File.new_for_path(STATE).load_contents(null);
            this._items = JSON.parse(new TextDecoder().decode(b)).filter(x => x.text).map(x => ({...x, f: fold(x.text.slice(0, 4000))}));
            this._trim();
        } catch {
            this._items = [];
        }
    }

    _save() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE), 0o700);
            const data = this._items.filter(x => x.text).map(x => ({text: x.text, t: x.t}));
            Gio.File.new_for_path(STATE).replace_contents(new TextEncoder().encode(JSON.stringify(data)), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`[lucent-launcher] clipboard save: ${e.message}`);
        }
    }

    _result(x, i, score) {
        const one = x.text ? x.text.replace(/\s+/g, ' ').trim() : 'Image';
        const lines = x.text ? x.text.split('\n').length : 0;
        const put = () => (x.image ? copyImage(x.image) : copyText(x.text));
        return {
            id: `clip:${x.t}`,
            section: 'clipboard',
            title: one.length > 90 ? `${one.slice(0, 90)}…` : one,
            subtitle: `${relTime(x.t)}${x.text ? ` · ${x.text.length} characters${lines > 1 ? `, ${lines} lines` : ''}` : ''}`,
            kind: 'Clipboard',
            icon: x.image ? {file: x.image, mime: 'image/png', thumb: true} : {name: /^https?:\/\//.test(one) ? 'web-browser-symbolic' : 'edit-paste-symbolic'},
            score: score - i,
            noLearn: true,
            activate: () => {
                put();
                pasteSoon();
            },
            secondary: put,
            copy: () => (x.image ? {imagePath: x.image} : {text: x.text}),
            remove: () => {
                this._items = this._items.filter(y => y !== x);
                if (x.image && !this._items.some(y => y.image === x.image))
                    GLib.unlink(x.image);
                if (this._ctx.config.v.clipboard?.persist)
                    this._save();
            },
            preview: x.image ? {type: 'image', path: x.image, title: 'Image', lines: [['Copied', relTime(x.t)]]}
                : {type: 'text', text: x.text, title: 'Text', lines: [['Copied', relTime(x.t)], ['Length', `${x.text.length} characters`]]},
            hints: [['↩', 'Paste'], ['⌃↩', 'Copy'], ['⇧⌦', 'Remove']],
        };
    }

    search(q, _c, mode) {
        this._trim();
        if (q.prefix || q.kind)
            return [];
        if (!q.folded)
            return mode === 'clipboard' ? this._items.map((x, i) => this._result(x, i, 1000)) : [];
        if (mode !== 'clipboard' && q.folded.length < 3)
            return [];
        const out = [];
        this._items.forEach((x, i) => {
            const at = x.f.indexOf(q.folded);
            if (at >= 0)
                out.push(this._result(x, i, mode === 'clipboard' ? 1000 : 380 - Math.min(80, at)));
        });
        return out;
    }

    destroy() {
        this._sel?.disconnectObject(this);
        this._sel = null;
        if (this._ctx.config.v.clipboard?.persist)
            this._save();
        this._items = [];
    }
}
