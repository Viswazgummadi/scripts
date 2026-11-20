// SPDX-License-Identifier: GPL-3.0-or-later
// Lucent Probe: drive and inspect the running shell from a terminal, for development only.
//
// Write JSON lines to ~/.cache/lucent-probe/cmd (tools/probe does it and waits for the answer):
//
//   {"op":"id","id":"x"}                      name this batch; done-x.json is written when it ends
//   {"op":"wait","ms":500}
//   {"op":"trial","name":"corner","dir":"/abs/build/uuid"}   run a copy of an extension folder
//   {"op":"untrial","name":"corner"}
//   {"op":"cycle","name":"corner","n":5}      disable and enable a trial n times (what a screen lock does)
//   {"op":"install","uuid":"...","enable":true}   load a newly installed extension the way the shell does
//   {"op":"reload-ext","uuid":"..."}        unload and load an installed extension again (clears an error)
//   {"op":"prefs","uuid":"..."}               open an installed extension's preferences window
//   {"op":"surface","s":"overview|apps|quick|date|banner|osd|menu:<statusArea key>|none"}
//   {"op":"shot","name":"a.png"}              whole stage; or "rect":[x,y,w,h] in stage pixels
//   {"op":"pointer","x":10,"y":10}            move the pointer; "click":true presses the primary button
//   {"op":"pointer","restore":true}           put the pointer back where the first move found it
//   {"op":"css","file":"/abs/a.css"}          try a stylesheet; without "file" it is taken out again
//   {"op":"info","name":"info.json"}          panel layout, loaded stylesheets, extension states
//   {"op":"launcher","name":"launcher","do":"type","text":"fire"}   drive Lucent Launcher (see its debug())
//   {"op":"style","class":"calendar-day","limit":3}   colours St resolved for actors with that class
//   {"op":"tree","name":"dashtodockContainer","depth":6}   actor tree under a named actor -> tree.txt
//   {"op":"close-window","title":"..."}       close the first window whose title contains the text
//   {"op":"workspace","to":"empty|back"}      show the empty last workspace (bare wallpaper), then return
//   {"op":"switcher","show":true|false}       show the Alt+Tab popup (no grab, switches nothing) / remove it
//   {"op":"reload"}                           run a fresh copy of this tool's own code
//
// Files named in "name" land in ~/.cache/lucent-probe/. Nothing here ships in a Lucent release.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import {ExtensionType} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-probe']);
const decoder = new TextDecoder();

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function box(actor) {
    const [x, y] = actor.get_transformed_position();
    return [Math.round(x), Math.round(y), Math.round(actor.width), Math.round(actor.height)];
}

export class Probe {
    static copyTree(from, to) {
        to.make_directory_with_parents(null);
        const children = from.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = children.next_file(null)) !== null) {
            const src = from.get_child(info.get_name()), dest = to.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                Probe.copyTree(src, dest);
            else
                src.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
        }
    }

    constructor(ext) {
        this._ext = ext;
    }

    enable() {
        GLib.mkdir_with_parents(CACHE, 0o700);
        this._trials = new Map();
        this._queue = Promise.resolve();
        this._monitor = Gio.File.new_for_path(CACHE).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (m, file, other, event) => {
            if (file.get_basename() !== 'cmd' || event !== Gio.FileMonitorEvent.CHANGES_DONE_HINT)
                return;
            let text;
            try {
                text = decoder.decode(file.load_contents(null)[1]);
                file.delete(null);
            } catch {
                return;
            }
            const lines = text.split('\n').filter(l => l.trim());
            this._queue = this._queue.then(() => this._run(lines));
        });
    }

    disable() {
        this._monitor?.cancel();
        this._monitor = null;
        for (const name of [...this._trials.keys()])
            this._untrial(name);
        this._css(null);
        this._pointerDevice?.run_dispose();
        this._pointerDevice = null;
    }

    _write(name, data) {
        GLib.file_set_contents(GLib.build_filenamev([CACHE, name]),
            typeof data === 'string' ? data : JSON.stringify(data, null, 1));
    }

    async _run(lines) {
        let id = 'last';
        const errors = [];
        const results = {};
        for (const line of lines) {
            let c;
            try {
                c = JSON.parse(line);
            } catch (e) {
                errors.push(`not JSON: ${line}`);
                continue;
            }
            try {
                switch (c.op) {
                case 'id': id = String(c.id); break;
                case 'wait': await sleep(c.ms ?? 300); break;
                case 'trial': results[`trial:${c.name}`] = await this._trial(c.name, c.dir); break;
                case 'untrial': this._untrial(c.name); break;
                case 'cycle': results[`cycle:${c.name}`] = await this._cycle(c.name, c.n ?? 3); break;
                case 'install': results[`install:${c.uuid}`] = await this._install(c.uuid, c.enable !== false); break;
                case 'reload-ext': {
                    const ext = Main.extensionManager.lookup(c.uuid);
                    if (!ext)
                        throw new Error(`no extension ${c.uuid}`);
                    await Main.extensionManager.reloadExtension(ext);
                    await sleep(600);
                    const now = Main.extensionManager.lookup(c.uuid);
                    results[`reload:${c.uuid}`] = {state: now?.state ?? null, error: now?.error || null};
                    break;
                }
                case 'prefs': Main.extensionManager.openExtensionPrefs(c.uuid, '', {}); break;
                case 'surface': this._surface(c.s); break;
                case 'shot': await this._shot(c); break;
                case 'pointer': await this._pointer(c); break;
                case 'css': this._css(c.file); break;
                case 'info': this._write(c.name ?? 'info.json', this._info()); break;
                case 'launcher': results.launcher = this._launcher(c); break;
                case 'style': this._write(c.name ?? 'style.json', this._style(c.class, c.limit ?? 3)); break;
                case 'tree': this._write(c.file ?? 'tree.txt', this._tree(c.name, c.depth ?? 6)); break;
                case 'close-window': results['close-window'] = this._closeWindow(c.title); break;
                case 'workspace': results.workspace = this._workspace(c.to); break;
                case 'switcher': results.switcher = this._switcher(c.show !== false); break;
                case 'reload':
                    this._write(`done-${id}.json`, {id, errors, results, reloaded: true});
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._ext.reload();
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                default: errors.push(`unknown op: ${c.op}`);
                }
            } catch (e) {
                errors.push(`${c.op}: ${e.message}\n${e.stack}`);
            }
        }
        this._write(`done-${id}.json`, {id, errors, results});
    }

    // ---- extensions ------------------------------------------------------------------------------
    // A trial runs a private copy of an extension folder. The copy has a new path, so the shell
    // imports the code afresh; that is the only way to see a code change without logging out.
    async _trial(name, dir) {
        this._untrial(name);
        const copy = Gio.File.new_for_path(GLib.build_filenamev([CACHE, 'trial', `${name}-${Date.now()}`]));
        Probe.copyTree(Gio.File.new_for_path(dir), copy);
        const metadata = JSON.parse(decoder.decode(copy.get_child('metadata.json').load_contents(null)[1]));
        const mod = await import(`${copy.get_uri()}/extension.js`);
        const obj = new mod.default({...metadata, dir: copy, path: copy.get_path()});
        const trial = {obj, dir: copy, css: null, enabled: false};
        this._trials.set(name, trial);
        this._trialEnable(trial);
        return {uuid: metadata.uuid, enabled: trial.enabled, stylesheet: trial.css?.get_basename() ?? null};
    }

    _trialEnable(trial) {
        const variant = Main.getStyleVariant();
        for (const file of [`stylesheet-${variant}.css`, 'stylesheet.css']) {
            const css = trial.dir.get_child(file);
            if (css.query_exists(null)) {
                St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(css);
                trial.css = css;
                break;
            }
        }
        trial.obj.enable();
        trial.enabled = true;
    }

    _trialDisable(trial) {
        if (trial.enabled)
            trial.obj.disable();
        trial.enabled = false;
        if (trial.css)
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(trial.css);
        trial.css = null;
    }

    _untrial(name) {
        const trial = this._trials.get(name);
        if (!trial)
            return;
        this._trials.delete(name);
        this._trialDisable(trial);
    }

    async _cycle(name, n) {
        const trial = this._trials.get(name);
        if (!trial)
            throw new Error(`no trial named ${name}`);
        const before = this._census();
        const typesBefore = this._censusByType();
        for (let i = 0; i < n; i++) {
            this._trialDisable(trial);
            await sleep(120);
            this._trialEnable(trial);
            await sleep(120);
        }
        const after = this._census();
        const typesAfter = this._censusByType();
        const grew = {};
        for (const [type, count] of Object.entries(typesAfter)) {
            if (count !== (typesBefore[type] ?? 0))
                grew[type] = count - (typesBefore[type] ?? 0);
        }
        for (const type of Object.keys(typesBefore)) {
            if (!(type in typesAfter))
                grew[type] = -typesBefore[type];
        }
        return {cycles: n, actorsBefore: before, actorsAfter: after, leaked: after - before, byType: grew};
    }

    // Actors on the stage per "Type.style-class#name", to see what a leak consists of.
    _censusByType() {
        const counts = {};
        const walk = actor => {
            const key = `${actor.constructor.name}${actor.get_style_class_name?.() ? `.${actor.get_style_class_name()}` : ''}` +
                `${actor.name ? `#${actor.name}` : ''} < ${actor.get_parent()?.constructor.name ?? '-'}` +
                `${actor.get_parent()?.get_parent() ? ` < ${actor.get_parent().get_parent().constructor.name}` : ''}` +
                ` [${actor.get_first_child()?.constructor.name ?? 'empty'}]`;
            counts[key] = (counts[key] ?? 0) + 1;
            for (const child of actor.get_children())
                walk(child);
        };
        walk(global.stage);
        return counts;
    }

    // Number of actors on the stage: grows if an extension leaves widgets behind on disable.
    _census() {
        let count = 0;
        const walk = actor => {
            count++;
            for (const child of actor.get_children())
                walk(child);
        };
        walk(global.stage);
        return count;
    }

    async _install(uuid, enable) {
        const manager = Main.extensionManager;
        if (!manager.lookup(uuid)) {
            const dir = Gio.File.new_for_path(GLib.build_filenamev(
                [GLib.get_user_data_dir(), 'gnome-shell', 'extensions', uuid]));
            await manager.loadExtension(manager.createExtensionObject(uuid, dir, ExtensionType.PER_USER));
        }
        if (enable)
            manager.enableExtension(uuid);
        await sleep(600);
        const ext = manager.lookup(uuid);
        return {state: ext?.state ?? null, error: ext?.error ?? null};
    }

    // ---- looking -----------------------------------------------------------------------------------
    _surface(s) {
        const menuOf = key => Main.panel.statusArea[key]?.menu;
        switch (s) {
        case 'overview': Main.overview.show(); break;
        case 'apps': Main.overview.showApps(); break;
        case 'quick': menuOf('quickSettings')?.open(); break;
        case 'date': menuOf('dateMenu')?.open(); break;
        case 'banner': Main.notify('Lucent Probe', 'A sample notification banner, to check its look.'); break;
        case 'osd': Main.osdWindowManager.showAll(Gio.ThemedIcon.new('audio-volume-medium-symbolic'), 'Lucent Probe', 0.5, 1); break;
        case 'none':
            for (const key in Main.panel.statusArea)
                menuOf(key)?.close?.();
            if (Main.overview.visible)
                Main.overview.hide();
            break;
        default:
            if (s?.startsWith('menu:'))
                menuOf(s.slice(5))?.open?.();
            else
                throw new Error(`unknown surface: ${s}`);
        }
    }

    _shot(c) {
        const rect = c.rect ?? [0, 0, global.stage.width, global.stage.height];
        const file = Gio.File.new_for_path(GLib.build_filenamev([CACHE, c.name ?? 'shot.png']));
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        return new Promise((resolve, reject) => {
            new Shell.Screenshot().screenshot_area(...rect, stream, (shooter, result) => {
                try {
                    shooter.screenshot_area_finish(result);
                    stream.close(null);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _pointer(c) {
        this._pointerDevice ??= global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const device = this._pointerDevice;
        if (c.restore) {
            if (this._pointerHome)
                device.notify_absolute_motion(GLib.get_monotonic_time(), ...this._pointerHome);
            this._pointerHome = null;
            return;
        }
        this._pointerHome ??= global.get_pointer().slice(0, 2);
        device.notify_absolute_motion(GLib.get_monotonic_time(), c.x, c.y);
        if (c.click) {
            await sleep(60);
            device.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await sleep(60);
            device.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        }
    }

    _css(path) {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (this._previewCss)
            theme.unload_stylesheet(this._previewCss);
        this._previewCss = path ? Gio.File.new_for_path(path) : null;
        if (this._previewCss)
            theme.load_stylesheet(this._previewCss);
    }

    // The colours St resolved for the first few mapped actors that carry a style class, and the
    // chain of classes above them: shows which rule won without guessing.
    _style(styleClass, limit) {
        const found = [];
        const rgba = c => `rgba(${c.red}, ${c.green}, ${c.blue}, ${(c.alpha / 255).toFixed(2)})`;
        const walk = actor => {
            if (found.length >= limit)
                return;
            if (actor instanceof St.Widget && actor.mapped && actor.has_style_class_name(styleClass)) {
                const node = actor.get_theme_node();
                const chain = [];
                for (let a = actor; a && chain.length < 8; a = a.get_parent()) {
                    chain.push(`${a.constructor.name}${a.name ? `#${a.name}` : ''}` +
                        `${a.get_style_class_name?.() ? `.${a.get_style_class_name().trim().split(/\s+/).join('.')}` : ''}` +
                        `${a.get_style_pseudo_class?.() ? `:${a.get_style_pseudo_class()}` : ''}`);
                }
                found.push({color: rgba(node.get_foreground_color()), background: rgba(node.get_background_color()), box: box(actor), chain});
            }
            for (const child of actor.get_children())
                walk(child);
        };
        walk(global.stage);
        return found;
    }

    // Drive an extension that offers debug() (Lucent Launcher): a trial by name, or an installed uuid.
    _launcher(c) {
        const obj = c.name ? this._trials.get(c.name)?.obj : Main.extensionManager.lookup(c.uuid)?.stateObj;
        if (!obj?.debug)
            throw new Error('no such extension, or it has no debug()');
        return obj.debug(c);
    }

    // The actor tree under the first actor with this name, as indented text.
    _tree(name, depth) {
        const find = a => {
            if (a.name === name)
                return a;
            for (const child of a.get_children()) {
                const hit = find(child);
                if (hit)
                    return hit;
            }
            return null;
        };
        const root = find(global.stage);
        if (!root)
            return `no actor named ${name}\n`;
        const lines = [];
        const walk = (a, level) => {
            const [x, y] = a.get_transformed_position();
            lines.push(`${'  '.repeat(level)}${a.constructor.name}${a.name ? `#${a.name}` : ''}` +
                `${a.get_style_class_name?.() ? `.${a.get_style_class_name().trim().split(/\s+/).join('.')}` : ''}` +
                ` [${Math.round(x)},${Math.round(y)} ${Math.round(a.width)}x${Math.round(a.height)}]${a.visible ? '' : ' hidden'}` +
                `${a.clip_to_allocation ? ' CLIP-ALLOC' : ''}${a.has_clip ? ' HAS-CLIP' : ''}${a.reactive ? ' reactive' : ''}` +
                `${a.get_effects().length ? ` effects=${a.get_effects().map(e => `${e.constructor.name}${e.enabled ? '' : '(off)'}`).join('+')}` : ''}` +
                `${a instanceof St.Viewport ? ` clip_to_view=${a.clip_to_view}` : ''}`);
            if (level < depth)
                a.get_children().forEach(child => walk(child, level + 1));
        };
        walk(root, 0);
        return `${lines.join('\n')}\n`;
    }

    // "empty": go to the last workspace (GNOME keeps it empty) to see the bare wallpaper;
    // "back": return to the workspace that was active before.
    _workspace(to) {
        const wm = global.workspace_manager;
        const time = global.get_current_time();
        if (to === 'empty') {
            this._wsBack ??= wm.get_active_workspace_index();
            const last = wm.get_workspace_by_index(wm.get_n_workspaces() - 1);
            if (last.list_windows().length)
                return {error: 'last workspace is not empty'};
            last.activate(time);
        } else if (to === 'back' && this._wsBack !== undefined && this._wsBack !== null) {
            wm.get_workspace_by_index(this._wsBack)?.activate(time);
            this._wsBack = null;
        }
        return {active: wm.get_active_workspace_index(), count: wm.get_n_workspaces()};
    }

    // Show the Alt+Tab popup without show(): no grab, no modifier watch, so nothing gets switched.
    _switcher(show) {
        this._switcherPopup?.destroy();
        this._switcherPopup = null;
        if (!show)
            return {shown: false};
        const popup = new AltTab.AppSwitcherPopup();
        if (!popup._items.length) {
            popup.destroy();
            return {shown: false, error: 'no apps running'};
        }
        // what show() does, minus the grab and the "modifier released" check that would switch
        popup.add_child(popup._switcherList);
        popup.opacity = 255;
        popup.visible = true;
        popup.get_allocation_box();
        popup._select(Math.min(1, popup._items.length - 1));
        this._switcherPopup = popup;
        popup.connect('destroy', () => {
            if (this._switcherPopup === popup)
                this._switcherPopup = null;
        });
        return {shown: true, items: popup._items.length};
    }

    _closeWindow(title) {
        const win = global.get_window_actors().map(a => a.meta_window)
            .find(w => w.get_title()?.includes(title));
        win?.delete(global.get_current_time());
        return win?.get_title() ?? null;
    }

    _info() {
        const context = St.ThemeContext.get_for_stage(global.stage);
        const sheets = {};
        for (const file of context.get_theme().get_custom_stylesheets()) {
            const path = file?.get_path() ?? 'NO FILE (stale copy)';
            sheets[path] = (sheets[path] ?? 0) + 1;
        }
        return {
            stage: [global.stage.width, global.stage.height],
            scale: context.scale_factor,
            styleVariant: Main.getStyleVariant(),
            pointer: global.get_pointer().slice(0, 2),
            monitors: Main.layoutManager.monitors.map(m => ({x: m.x, y: m.y, w: m.width, h: m.height})),
            panel: box(Main.panel),
            statusArea: Object.fromEntries(Object.entries(Main.panel.statusArea).map(([key, item]) =>
                [key, {box: box(item), visible: item.visible}])),
            panelBoxes: Object.fromEntries(['_leftBox', '_centerBox', '_rightBox'].map(box => [box,
                Main.panel[box].get_children().map(c => `${c.constructor.name}${c.get_style_class_name?.() ? `.${c.get_style_class_name()}` : ''}` +
                    `[${c.get_first_child() ? `${c.get_first_child().constructor.name}${c.get_first_child().accessible_name ? `:${c.get_first_child().accessible_name}` : ''}` : 'empty'}]${c.visible ? '' : ' (hidden)'}`)])),
            uiGroupClasses: Main.uiGroup.get_style_class_name(),
            panelClasses: Main.panel.get_style_class_name(),
            openMenus: Object.keys(Main.panel.statusArea).filter(key => Main.panel.statusArea[key].menu?.isOpen),
            overview: Main.overview.visible,
            shellTheme: context.get_theme().application_stylesheet?.get_path() ?? null,
            stylesheets: sheets,
            actors: this._census(),
            trials: Object.fromEntries([...this._trials].map(([name, t]) => [name, {uuid: t.obj.uuid, enabled: t.enabled}])),
            windows: global.get_window_actors().map(a => ({title: a.meta_window.get_title(), box: box(a)})),
            extensions: Object.fromEntries(Main.extensionManager.getUuids().map(uuid => {
                const e = Main.extensionManager.lookup(uuid);
                return [uuid, {state: e.state, error: e.error || null}];
            })),
        };
    }
}
