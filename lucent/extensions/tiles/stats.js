// SPDX-License-Identifier: GPL-3.0-or-later
// Live system numbers from /proc and /sys (cheap, synchronous, no subprocesses).
import GLib from 'gi://GLib';

const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

function findTempInput(hwmonName, preferLabel) {
    let dir;
    try {
        dir = GLib.Dir.open('/sys/class/hwmon', 0);
    } catch {
        return null;
    }
    let found = null;
    for (let e = dir.read_name(); e !== null && !found; e = dir.read_name()) {
        const p = `/sys/class/hwmon/${e}`;
        if (readText(`${p}/name`)?.trim() !== hwmonName)
            continue;
        for (let i = 1; i <= 64 && !found; i++) {
            if (readText(`${p}/temp${i}_label`)?.trim() === preferLabel)
                found = `${p}/temp${i}_input`;
        }
        found ??= GLib.file_test(`${p}/temp1_input`, GLib.FileTest.EXISTS) ? `${p}/temp1_input` : null;
    }
    dir.close();
    return found;
}

export class Stats {
    constructor() {
        this._tempPath = findTempInput('coretemp', 'Package id 0') ?? findTempInput('k10temp', 'Tctl');
        this._prevCpu = null;
        this._prevNet = null;
        this.sample();
    }

    _cpu() {
        const line = readText('/proc/stat')?.split('\n', 1)[0];
        if (!line?.startsWith('cpu '))
            return null;
        const v = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = v[3] + (v[4] ?? 0), total = v.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        if (!prev || total === prev.total)
            return null;
        return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
    }

    _mem() {
        const t = readText('/proc/meminfo');
        const get = k => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t ?? '')?.[1] ?? NaN);
        const total = get('MemTotal'), avail = get('MemAvailable');
        return Number.isFinite(total) && Number.isFinite(avail) && total > 0
            ? Math.round(100 * (total - avail) / total) : null;
    }

    _temp() {
        const t = this._tempPath ? readText(this._tempPath) : null;
        return t ? Math.round(parseInt(t, 10) / 1000) : null;
    }

    // Bytes/s down and up, summed over all interfaces except loopback.
    _net() {
        const t = readText('/proc/net/dev');
        if (!t)
            return null;
        let rx = 0, tx = 0;
        for (const line of t.split('\n').slice(2)) {
            const [name, rest] = line.split(':');
            if (!rest || name.trim() === 'lo')
                continue;
            const f = rest.trim().split(/\s+/).map(Number);
            rx += f[0];
            tx += f[8];
        }
        const now = GLib.get_monotonic_time() / 1e6;
        const prev = this._prevNet;
        this._prevNet = {rx, tx, now};
        if (!prev || now <= prev.now)
            return null;
        const dt = now - prev.now;
        return {down: Math.max(0, (rx - prev.rx) / dt), up: Math.max(0, (tx - prev.tx) / dt)};
    }

    sample() {
        return {cpu: this._cpu(), mem: this._mem(), temp: this._temp(), net: this._net()};
    }
}

export function fmtRate(bps) {
    if (bps < 1000)
        return `${Math.round(bps)} B`;
    if (bps < 1e6)
        return `${Math.round(bps / 1e3)} K`;
    return `${(bps / 1e6).toFixed(bps < 1e7 ? 1 : 0)} M`;
}
