// SPDX-License-Identifier: GPL-3.0-or-later
// The preview pane (Quick Look in place): a big visual, the title, Finder-style info rows,
// content (text, snippet, definition...) and the keyboard hints for the selected result.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {makeIcon, isImage, thumbnailFor} from './icons.js';
import {roundCorners} from './glass.js';
import {tn} from '../core/gtype.js';
import {fullDate, humanSize, readText, relTime, tildify} from '../core/util.js';
import {define} from '../providers/web.js';

const VIS_W = 300;
const VIS_H = 190;
const TEXTISH = /^(text\/|application\/(json|xml|javascript|x-shellscript|x-yaml|toml|x-desktop))/;

function label(text, cls, {wrap = false, lines = 0, markup = false, center = false} = {}) {
    const l = new St.Label({style_class: cls, x_expand: true});
    if (markup)
        l.clutter_text.set_markup(text);
    else
        l.text = text ?? '';
    if (center)
        l.x_align = Clutter.ActorAlign.CENTER;
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = lines ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE;
        if (center)
            l.clutter_text.line_alignment = Pango.Alignment.CENTER;
    } else {
        l.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
    }
    return l;
}

export const Preview = GObject.registerClass({GTypeName: tn('Preview')},
class Preview extends St.BoxLayout {
    _init() {
        super._init({style_class: 'sl-preview', orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true});
        this._scroll = new St.ScrollView({hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true, y_expand: true, style_class: 'sl-preview-scroll'});
        this._content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'sl-preview-content'});
        this._scroll.set_child(this._content);
        this._hints = new St.BoxLayout({style_class: 'sl-hints', x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._scroll);
        this.add_child(this._hints);
        this._token = 0;
        this._cancellable = null;
        this._current = null;
    }

    show(r) {
        if (r === this._current)
            return;
        this._current = r;
        this._token++;
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        this._content.destroy_all_children();
        this._hints.destroy_all_children();
        this._scroll.vadjustment.value = 0;
        if (!r)
            return;
        const p = r.preview ?? {type: 'generic'};
        try {
            switch (p.type) {
            case 'app': this._app(r, p); break;
            case 'file': this._file(r, p); break;
            case 'image': this._imageItem(r, p); break;
            case 'text': this._textItem(r, p); break;
            case 'answer': this._answer(r, p); break;
            case 'window': this._window(r, p); break;
            case 'media': this._media(r, p); break;
            case 'command': this._command(r, p); break;
            case 'web': this._web(r, p); break;
            case 'definition': this._definition(r, p); break;
            default: this._generic(r, p);
            }
        } catch (e) {
            console.error(`[lucent-launcher] preview: ${e.message}\n${e.stack}`);
            this._generic(r, {});
        }
        for (const [keys, what] of r.hints ?? [['↩', 'Open']]) {
            const h = new St.BoxLayout({style_class: 'sl-hint'});
            h.add_child(new St.Label({text: keys, style_class: 'sl-hint-key', y_align: Clutter.ActorAlign.CENTER}));
            h.add_child(new St.Label({text: what, style_class: 'sl-hint-label', y_align: Clutter.ActorAlign.CENTER}));
            this._hints.add_child(h);
        }
    }

    // ---- building blocks -----------------------------------------------------------------------
    _visual(actor) {
        const bin = new St.Bin({style_class: 'sl-pv-visual', child: actor, x_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._content.add_child(bin);
        return bin;
    }

    _icon(spec, size = 96) {
        this._visual(makeIcon(spec, size));
    }

    _image(path, {w = VIS_W, h = VIS_H} = {}) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const actor = St.TextureCache.get_default().load_file_async(Gio.File.new_for_path(path), w, h, scale, 1);
        const holder = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        holder.add_child(actor);
        roundCorners(actor, 10);
        this._visual(holder);
    }

    _title(text, sub) {
        this._content.add_child(label(text, 'sl-pv-title', {wrap: true, lines: 3, center: true}));
        if (sub)
            this._content.add_child(label(sub, 'sl-pv-kind', {center: true}));
    }

    _info(rows) {
        rows = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
        if (!rows.length)
            return;
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'sl-pv-info'});
        for (const [k, v] of rows) {
            const line = new St.BoxLayout({style_class: 'sl-pv-row'});
            line.add_child(new St.Label({text: k, style_class: 'sl-pv-key'}));
            const val = label(String(v), 'sl-pv-val', {wrap: true});
            line.add_child(val);
            box.add_child(line);
        }
        this._content.add_child(box);
    }

    _block(text, cls = 'sl-pv-text', markup = false) {
        const l = new St.Label({style_class: cls, x_expand: true});
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        if (markup)
            l.clutter_text.set_markup(text);
        else
            l.text = text;
        const bin = new St.Bin({style_class: `${cls}-box`, child: l, x_expand: true});
        this._content.add_child(bin);
        return l;
    }

    _windowClone(win, w = VIS_W, h = VIS_H) {
        const wa = win?.get_compositor_private();
        if (!wa)
            return false;
        const [ww, wh] = [Math.max(1, wa.width), Math.max(1, wa.height)];
        const s = Math.min(w / ww, h / wh, 1);
        const clone = new Clutter.Clone({source: wa, width: Math.round(ww * s), height: Math.round(wh * s)});
        roundCorners(clone, 8);
        const bin = this._visual(clone);
        bin.add_style_class_name('sl-pv-window');
        return true;
    }

    // ---- per type ------------------------------------------------------------------------------
    _app(r, p) {
        const {app, info} = p;
        const wins = app.get_windows?.() ?? [];
        this._icon({gicon: app.get_icon()}, 96);
        this._title(app.get_name(), 'Application');
        const desc = info?.get_description?.();
        if (desc)
            this._content.add_child(label(desc, 'sl-pv-desc', {wrap: true, center: true}));
        const used = r._ctxLastUsed ?? null;
        this._info([
            ['Status', app.get_state() === Shell.AppState.RUNNING ? `Running${wins.length ? ` · ${wins.length} window${wins.length > 1 ? 's' : ''}` : ''}` : 'Not running'],
            ['Category', (info?.get_categories?.() ?? '').split(';').filter(c => c && !/^X-|GTK|GNOME|Qt|KDE/.test(c)).slice(0, 3).join(', ')],
            ['Last opened', used ? relTime(used) : null],
            ['Location', info?.get_filename?.() ? tildify(info.get_filename()) : null],
        ]);
        if (wins.length)
            this._windowClone(wins[0], VIS_W, 150);
    }

    _file(r, p) {
        const path = p.path;
        if (!p.isDir && isImage(path, p.mime)) {
            this._image(thumbnailFor(path) && (p.size ?? 0) > 4e6 ? thumbnailFor(path) : path);
        } else {
            const thumb = !p.isDir ? thumbnailFor(path) : null;
            if (thumb)
                this._image(thumb);
            else
                this._icon({gicon: p.gicon ?? null, file: path, mime: p.mime, isDir: p.isDir}, 112);
        }
        this._title(p.name, p.kindLabel ?? (p.isDir ? 'Folder' : 'Document'));
        let created = null;
        try {
            const info = Gio.File.new_for_path(path).query_info('time::created', 0, null);
            created = info.get_creation_date_time()?.to_unix() * 1000 || null;
        } catch {
            created = null;
        }
        let items = null;
        if (p.isDir) {
            try {
                const en = Gio.File.new_for_path(path).enumerate_children('standard::name', 0, null);
                let n = 0;
                while (en.next_file(null) && n < 10000)
                    n++;
                en.close(null);
                items = `${n} item${n === 1 ? '' : 's'}`;
            } catch {
                items = null;
            }
        }
        this._info([
            ['Size', p.isDir ? items : humanSize(p.size)],
            ['Created', created ? fullDate(created) : null],
            ['Modified', p.mtime ? fullDate(p.mtime) : null],
            ['Where', tildify(GLib.path_get_dirname(path))],
        ]);
        if (p.snippet) {
            const esc = GLib.markup_escape_text(p.snippet, -1).replace(/\u0001/g, '<b>').replace(/\u0002/g, '</b>');
            this._block(esc, 'sl-pv-snippet', true);
        } else if (!p.isDir && (TEXTISH.test(p.mime ?? '') || /\.(md|txt|c|cc|cpp|h|hpp|py|js|ts|rs|go|sh|json|toml|yaml|yml|ll|td|cu|cl|cmake|mk)$/i.test(p.name)) && (p.size ?? 0) < 4e6) {
            const text = readText(path, 6000);
            if (text !== null) {
                const lines = text.split('\n').slice(0, 18).map(l => (l.length > 90 ? `${l.slice(0, 90)}…` : l)).join('\n');
                if (lines.trim())
                    this._block(lines, 'sl-pv-code');
            }
        }
    }

    _imageItem(r, p) {
        this._image(p.path);
        this._title(p.title ?? 'Image');
        this._info(p.lines ?? []);
    }

    _textItem(r, p) {
        this._title(p.title ?? 'Text');
        this._info(p.lines ?? []);
        this._block(p.text.length > 3000 ? `${p.text.slice(0, 3000)}…` : p.text, 'sl-pv-code');
    }

    _answer(r, p) {
        if (p.swatch) {
            this._visual(new St.Widget({style_class: 'sl-pv-swatch', style: `background-color: ${p.swatch};`}));
        } else if (p.iconName) {
            this._icon({name: p.iconName, fallback: 'accessories-calculator-symbolic'}, 64);
        }
        if (p.small)
            this._content.add_child(label(p.small, 'sl-pv-expr', {wrap: true, center: true}));
        this._content.add_child(label(p.big ?? r.title, 'sl-pv-big', {wrap: true, center: true}));
        this._info(p.lines ?? []);
        if (p.foot)
            this._content.add_child(label(p.foot, 'sl-pv-foot', {wrap: true, center: true}));
    }

    _window(r, p) {
        if (!this._windowClone(p.win))
            this._icon({gicon: p.app?.get_icon() ?? null, name: 'focus-windows-symbolic'}, 96);
        this._title(p.win.get_title() ?? '', p.app?.get_name() ?? 'Window');
        const ws = p.win.get_workspace?.();
        this._info([
            ['Workspace', ws ? `${ws.index() + 1}` : null],
            ['State', p.win.minimized ? 'Minimized' : p.win.has_focus() ? 'Focused' : 'Open'],
        ]);
    }

    _media(r, p) {
        const path = p.art?.startsWith('file://') ? Gio.File.new_for_uri(p.art).get_path() : null;
        if (path && GLib.file_test(path, GLib.FileTest.EXISTS))
            this._image(path, {w: 200, h: 200});
        else
            this._icon({name: 'audio-x-generic'}, 96);
        this._title(p.title, p.artist);
        this._info([['Player', p.player], ['Status', p.status]]);
    }

    _command(r, p) {
        this._icon({name: 'utilities-terminal', fallback: 'utilities-terminal-symbolic'}, 72);
        this._title(r.title, 'Command');
        this._block(`$ ${p.cmd}`, 'sl-pv-code');
        this._info([['Runs in', p.cwd]]);
    }

    _web(r, p) {
        this._icon(r.icon ?? {name: 'web-browser'}, 80);
        this._title(p.title ?? r.title, 'Web');
        this._content.add_child(label(p.url, 'sl-pv-desc', {wrap: true, center: true}));
    }

    _definition(r, p) {
        this._icon({name: 'accessories-dictionary', fallback: 'accessories-dictionary-symbolic'}, 64);
        this._title(p.word, 'Dictionary');
        if (!p.online) {
            this._content.add_child(label('Online definitions are turned off (onlineDefinitions in the config).', 'sl-pv-desc', {wrap: true, center: true}));
            return;
        }
        const token = this._token;
        const status = label('Looking up…', 'sl-pv-desc', {center: true});
        this._content.add_child(status);
        define(p.word, this._cancellable).then(d => {
            if (token !== this._token)
                return;
            status.destroy();
            if (!d) {
                this._content.add_child(label('No definition found.', 'sl-pv-desc', {center: true}));
                return;
            }
            if (d.phonetic)
                this._content.add_child(label(d.phonetic, 'sl-pv-kind', {center: true}));
            for (const m of d.meanings.slice(0, 3)) {
                const esc = s => GLib.markup_escape_text(s, -1);
                const body = `<i>${esc(m.pos)}</i>\n${m.defs.map((x, i) => `${i + 1}. ${esc(x)}`).join('\n')}`;
                this._block(body, 'sl-pv-def', true);
            }
        });
    }

    _generic(r, p) {
        if (p.gicon)
            this._icon({gicon: p.gicon}, 80);
        else if (p.iconName)
            this._icon({name: p.iconName}, 80);
        else
            this._icon(r.icon, 80);
        this._title(p.title ?? r.title, r.kind ?? '');
        if (p.body)
            this._content.add_child(label(p.body, 'sl-pv-desc', {wrap: true, center: true}));
        else if (r.subtitle && r.subtitle !== r.kind)
            this._content.add_child(label(r.subtitle, 'sl-pv-desc', {wrap: true, center: true}));
        this._info(p.lines ?? []);
    }

    destroy() {
        this._cancellable?.cancel();
        super.destroy();
    }
});
