// SPDX-License-Identifier: GPL-3.0-or-later
// Live audio levels for the player's visualiser (One UI 9 style "moves with the music").
//
// Reads what the speakers are playing (the default sink's monitor) with `parec`: mono, 22.05 kHz,
// 16-bit, 44 KB/s, nothing stored, only while start()ed (popover open + something playing).
// Each 16 ms chunk is split into three bands with 2nd-order (RBJ biquad) filters, steep enough
// that the bands really move independently:
//   bass   < 150 Hz   (2 cascaded low-passes, 24 dB/oct): kick, bass line
//   mid    ~300 Hz–3 kHz (band-pass around 1 kHz): vocals, guitars
//   treble 5–11 kHz   (2 cascaded high-passes): hi-hats, cymbals, air
// Loudness is perceptual: band RMS in dB, mapped against a slowly falling per-band peak over a
// 24 dB window, so quiet passages still move and loud ones don't pin at the top.
// Beats: a jump in bass energy well above its recent average (spectral flux on the low band)
// stamps `beatAt` / `beatStrength`; the renderer turns that into a short decaying pulse.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const RATE = 22050;
const CHUNK = 704;          // bytes = 352 samples = 16 ms
const WINDOW_DB = 24;       // dynamic range shown (a 3x drop ≈ half as loud ≈ 0.6)
const PEAK_FALL_DB = 3;     // dB per second the reference peak sinks back
const FLOOR_DB = -62;       // below this a band counts as silent
const ATTACK_S = 0.012;     // VU rise time constant
const RELEASE_S = 0.140;    // VU fall time constant
const BEAT_GAP_US = 230000; // at most ~4 beats a second
const BEAT_RATIO = 1.45;    // bass energy vs its ~0.7 s average

// RBJ cookbook biquad, direct form 1.
function biquad(type, f0, q) {
    const w = 2 * Math.PI * f0 / RATE, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === 'lp') {
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
    } else if (type === 'hp') {
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
    } else { // band-pass, 0 dB peak gain
        b0 = al; b1 = 0; b2 = -al;
    }
    const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    const c = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return x => {
        const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
    };
}

export class Levels {
    constructor() {
        this.bass = 0;
        this.mid = 0;
        this.treble = 0;
        this.live = false;     // true while real audio data is flowing
        this.beatAt = 0;       // monotonic µs of the last detected beat
        this.beatStrength = 0; // 0..1
        this._proc = null;
        this._reset();
    }

    _reset() {
        const lp1 = biquad('lp', 150, 0.707), lp2 = biquad('lp', 150, 0.707);
        const bp = biquad('bp', 1000, 0.6);
        const hp1 = biquad('hp', 5000, 0.707), hp2 = biquad('hp', 5000, 0.707);
        this._bands = [x => lp2(lp1(x)), bp, x => hp2(hp1(x))];
        this._peakDb = [-30, -30, -30];
        this._bassAvg = 0;
    }

    start() {
        if (this._proc)
            return;
        try {
            this._proc = Gio.Subprocess.new(
                ['parec', '--device=@DEFAULT_MONITOR@', '--format=s16le', `--rate=${RATE}`,
                    '--channels=1', '--latency-msec=15'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            this._proc = null; // no parec: the wave falls back to synthetic motion
            return;
        }
        this._reset();
        this._cancel = new Gio.Cancellable();
        this._read(this._proc, this._proc.get_stdout_pipe());
    }

    stop() {
        this._cancel?.cancel();
        const proc = this._proc;
        this._proc = null;
        if (proc) {
            proc.force_exit();
            proc.wait_async(null, null); // reap it
        }
        this.live = false;
    }

    _read(proc, stream) {
        stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, this._cancel, (s, res) => {
            let bytes;
            try {
                bytes = s.read_bytes_finish(res);
            } catch {
                return; // cancelled / process gone
            }
            if (proc !== this._proc)
                return;
            if (!bytes || bytes.get_size() === 0) {
                this.live = false;
                return;
            }
            this._analyse(bytes.toArray());
            this._read(proc, stream);
        });
    }

    _analyse(u8) {
        const n = u8.length >> 1;
        if (!n)
            return;
        const dv = new DataView(u8.buffer, u8.byteOffset, n * 2);
        const [fB, fM, fT] = this._bands;
        let eB = 0, eM = 0, eT = 0;
        for (let i = 0; i < n; i++) {
            const x = dv.getInt16(i * 2, true) / 32768;
            const b = fB(x), m = fM(x), t = fT(x);
            eB += b * b;
            eM += m * m;
            eT += t * t;
        }
        const energy = [eB / n, eM / n, eT / n];
        const dt = n / RATE;

        // perceptual level: dB against a slowly sinking peak
        const out = energy.map((e, i) => {
            const db = 10 * Math.log10(e + 1e-12);
            this._peakDb[i] = Math.max(db, this._peakDb[i] - PEAK_FALL_DB * dt, FLOOR_DB + WINDOW_DB * 0.5);
            const v = (db - (this._peakDb[i] - WINDOW_DB)) / WINDOW_DB;
            return db < FLOOR_DB ? 0 : Math.max(0, Math.min(1, v));
        });

        // VU ballistics: fast attack, slower release
        const up = 1 - Math.exp(-dt / ATTACK_S), down = 1 - Math.exp(-dt / RELEASE_S);
        const vu = (cur, v) => cur + (v - cur) * (v > cur ? up : down);
        this.bass = vu(this.bass, out[0]);
        this.mid = vu(this.mid, out[1]);
        this.treble = vu(this.treble, out[2]);

        // beat: bass energy jumps well above its recent average
        const now = GLib.get_monotonic_time();
        const avg = this._bassAvg;
        this._bassAvg += (energy[0] - avg) * (1 - Math.exp(-dt / 0.7));
        if (avg > 1e-7 && energy[0] > avg * BEAT_RATIO && out[0] > 0.45 && now - this.beatAt > BEAT_GAP_US) {
            this.beatAt = now;
            this.beatStrength = Math.min(1, (energy[0] / avg - BEAT_RATIO) / 2 + 0.5);
        }
        this.live = true;
    }
}
