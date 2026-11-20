// SPDX-License-Identifier: GPL-3.0-or-later
// System block: just "CPU 12%  MEM 18%", updated in place. Click opens Mission Center
// (System Monitor if Mission Center is missing).
// When something hits its limit, the block dissolves into that reading (highlighted) and
// dissolves back once it calms down.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {crossMist} from './dissolve.js';
import {Stats} from './stats.js';
import {Tile} from './tile.js';

const SAMPLE_SEC = 2;
const LIMITS = [ // first hit wins
    {key: 'temp', test: s => s.temp !== null && s.temp >= 90, text: s => `TEMP ${s.temp}°`},
    {key: 'mem', test: s => s.mem !== null && s.mem >= 90, text: s => `MEM ${s.mem}%`},
    {key: 'cpu', test: s => s.cpu !== null && s.cpu >= 95, text: s => `CPU ${s.cpu}%`},
];

function pair(tag, value) {
    const box = new St.BoxLayout({style_class: 'lt-pair', y_align: Clutter.ActorAlign.CENTER});
    box.add_child(new St.Label({text: tag, style_class: 'lt-tag', y_align: Clutter.ActorAlign.CENTER, opacity: 165}));
    const v = new St.Label({style_class: 'lt-value', y_align: Clutter.ActorAlign.CENTER});
    box.add_child(v);
    return [box, v];
}

export const SysBlock = GObject.registerClass(
class SysBlock extends Tile {
    _init() {
        super._init('System Stats');
        this._box = new St.BoxLayout({style_class: 'lt-block', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._box);

        // normal face: CPU + MEM
        this._normal = new St.BoxLayout({style_class: 'lt-face', y_align: Clutter.ActorAlign.CENTER});
        const [cpuBox, cpu] = pair('CPU', '');
        const [memBox, mem] = pair('MEM', '');
        this._normal.add_child(cpuBox);
        this._normal.add_child(memBox);
        this._cpu = cpu;
        this._mem = mem;

        // alert face: the reading that hit its limit
        this._alert = new St.BoxLayout({style_class: 'lt-face lt-alarm', y_align: Clutter.ActorAlign.CENTER});
        this._alertLabel = new St.Label({style_class: 'lt-value', y_align: Clutter.ActorAlign.CENTER});
        this._alert.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', style_class: 'lt-alarm-icon'}));
        this._alert.add_child(this._alertLabel);

        this._box.add_child(this._normal);
        this._showing = this._normal;
        this._busy = false;
        this._dead = false;

        this._addClick();
        this._stats = new Stats();
        this._tick();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SAMPLE_SEC, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this.connect('destroy', () => {
            this._dead = true;
            GLib.source_remove(this._timer);
            for (const a of [this._normal, this._alert]) {
                if (!a.get_parent())
                    a.destroy();
            }
        });
    }

    // GNOME 51 panel buttons use gestures (no vfunc_event to chain up to): add our own click.
    _addClick() {
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => {
            const apps = Shell.AppSystem.get_default();
            (apps.lookup_app('io.missioncenter.MissionCenter.desktop') ??
             apps.lookup_app('org.gnome.SystemMonitor.desktop'))?.activate();
        });
        this.add_action(click);
    }

    _tick() {
        const s = this._stats.sample();
        this._cpu.text = s.cpu === null ? '–' : `${s.cpu}%`;
        this._mem.text = s.mem === null ? '–' : `${s.mem}%`;
        const hit = LIMITS.find(l => l.test(s));
        if (hit)
            this._alertLabel.text = hit.text(s);
        this._switchTo(hit ? this._alert : this._normal);
    }

    async _switchTo(face) {
        if (this._busy || face === this._showing)
            return;
        this._busy = true;
        const from = this._showing;
        this._showing = face;
        try {
            await crossMist(this._box, from, face, () => {
                this._box.remove_child(from);
                from.opacity = 255;
                this._box.add_child(face);
            }, {alive: () => !this._dead, settle: false});
        } catch (e) {
            console.error(`lucent-tiles: ${e.message}`);
        }
        this._busy = false;
    }
});
