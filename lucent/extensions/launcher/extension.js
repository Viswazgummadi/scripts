// SPDX-License-Identifier: GPL-3.0-or-later
// Lucent Launcher: a keyboard launcher for GNOME Shell.
// This file wires the parts together: settings, the search engine and its providers, the panel
// and the keyboard shortcut. The parts themselves are in core/, providers/ and ui/.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Config} from './core/config.js';
import {Engine} from './core/engine.js';
import {Frecency} from './core/frecency.js';
import {releaseVirtualKeyboard} from './core/util.js';
import {AnswersProvider} from './providers/answers.js';
import {AppsProvider, WindowsProvider} from './providers/apps.js';
import {ClipboardProvider} from './providers/clipboard.js';
import {CommandsProvider} from './providers/commands.js';
import {FilesProvider} from './providers/files.js';
import {MediaProvider} from './providers/media.js';
import {loadRemoteProviders} from './providers/remote.js';
import {SystemProvider, clearTimers} from './providers/system.js';
import {DictionaryProvider, SuggestProvider, WebProvider, abortHttp} from './providers/web.js';
import {LauncherPanel} from './ui/panel.js';

const DEFAULT_SHORTCUT = '<Super>space';
const WM_KEYS = 'org.gnome.desktop.wm.keybindings';
const INPUT_SOURCES = 'org.gnome.desktop.input-sources';
// Mutter applies a changed key binding a moment later; one retry covers it.
const BIND_RETRY_MS = 700;

export default class LucentLauncherExtension extends Extension {
    enable() {
        this._retryId = 0;
        this._action = 0;
        this._freedSuperSpace = null;

        this._config = new Config(() => this._onConfigChanged());
        this._frecency = new Frecency();
        this._engine = new Engine({
            config: this._config,
            frecency: this._frecency,
            onUpdate: view => this._panel?.onView(view),
        });
        const ctx = {config: this._config, engine: this._engine, openPreferences: () => this.openPreferences()};
        const providers = [
            new AnswersProvider(ctx),
            new CommandsProvider(ctx),
            new AppsProvider(ctx),
            new WindowsProvider(ctx),
            new SystemProvider(ctx),
            new FilesProvider(ctx),
            new ClipboardProvider(ctx),
            new MediaProvider(ctx),
            ...loadRemoteProviders(),
            new DictionaryProvider(ctx),
            new WebProvider(ctx),
            new SuggestProvider(ctx),
        ];
        for (const provider of providers)
            this._engine.add(provider);

        this._panel = new LauncherPanel({config: this._config, engine: this._engine});
        this._bind();
    }

    disable() {
        this._unbind();
        this._restoreSuperSpace();
        this._panel.destroy();
        this._panel = null;
        this._engine.destroy();
        this._engine = null;
        this._frecency.destroy();
        this._frecency = null;
        this._config.destroy();
        this._config = null;
        clearTimers();
        abortHttp();
        releaseVirtualKeyboard();
    }

    _onConfigChanged() {
        this._panel?.configChanged();
        if (this._shortcut() !== this._accelerator) {
            this._unbind();
            this._restoreSuperSpace();
            this._bind();
        }
    }

    _shortcut() {
        return this._config.v.shortcut || DEFAULT_SHORTCUT;
    }

    // ---- the shortcut -----------------------------------------------------------------------------
    // GNOME binds Super+Space to "switch input source". With a single keyboard layout that key
    // does nothing, so it is lent to the launcher while the extension is enabled and given back
    // in disable(). With several layouts it is left alone and the user is told.
    _freeSuperSpace() {
        const keys = new Gio.Settings({schema_id: WM_KEYS});
        const current = keys.get_strv('switch-input-source');
        if (!current.includes(DEFAULT_SHORTCUT))
            return;
        const sources = new Gio.Settings({schema_id: INPUT_SOURCES}).get_value('sources').n_children();
        if (sources > 1) {
            Main.notify('Lucent Launcher',
                'Super+Space switches between your keyboard layouts, so the launcher did not take it. Choose another shortcut in its preferences.');
            return;
        }
        this._freedSuperSpace = current;
        keys.set_strv('switch-input-source', current.filter(key => key !== DEFAULT_SHORTCUT));
    }

    _restoreSuperSpace() {
        if (!this._freedSuperSpace)
            return;
        const keys = new Gio.Settings({schema_id: WM_KEYS});
        const expected = this._freedSuperSpace.filter(key => key !== DEFAULT_SHORTCUT);
        // Give it back only if nobody changed the setting in the meantime.
        if (JSON.stringify(keys.get_strv('switch-input-source')) === JSON.stringify(expected))
            keys.set_strv('switch-input-source', this._freedSuperSpace);
        this._freedSuperSpace = null;
    }

    _bind(retry = true) {
        const accelerator = this._shortcut();
        this._accelerator = accelerator;
        if (accelerator === DEFAULT_SHORTCUT && this._config.v.freeSuperSpace !== false && !this._freedSuperSpace)
            this._freeSuperSpace();

        const action = global.display.grab_accelerator(accelerator, Meta.KeyBindingFlags.NONE);
        if (action === Meta.KeyBindingAction.NONE) {
            if (retry) {
                this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BIND_RETRY_MS, () => {
                    this._retryId = 0;
                    this._bind(false);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                Main.notifyError('Lucent Launcher',
                    `Could not use ${accelerator}: another shortcut owns it. Choose another one in the launcher's preferences.`);
            }
            return;
        }
        this._action = action;
        this._bindingName = Meta.external_binding_name_for_action(action);
        Main.wm.allowKeybinding(this._bindingName,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
        global.display.connectObject('accelerator-activated', (display, activated) => {
            if (activated === this._action)
                this._panel?.toggle();
        }, this);
    }

    _unbind() {
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
        global.display.disconnectObject(this);
        if (this._action) {
            Main.wm.allowKeybinding(this._bindingName, Shell.ActionMode.NONE);
            global.display.ungrab_accelerator(this._action);
        }
        this._action = 0;
        this._bindingName = null;
    }

    /**
     * For automated tests (the development probe): drive the panel the way a keyboard would.
     * It can type and move the selection; it never activates a result.
     *
     * @param {object} command - {do: 'type', text} | {do: 'key', key: 'down'|'up'|'tab'} |
     *     {do: 'mode', mode} | {do: 'close'} | {do: 'state'}
     * @returns {object} what the panel shows now, and its rectangle on the stage
     */
    debug(command) {
        const panel = this._panel;
        switch (command.do) {
        case 'type': panel.devType(command.text ?? ''); break;
        case 'key': panel.devKey(command.key); break;
        case 'mode': panel.devKey(`mode:${command.mode ?? ''}`); break;
        case 'close': panel.close(); break;
        }
        return {...panel.devState(), rect: panel.panelRect(command.margin ?? 40)};
    }
}
