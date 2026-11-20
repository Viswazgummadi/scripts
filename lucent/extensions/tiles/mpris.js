// SPDX-License-Identifier: GPL-3.0-or-later
// MPRIS client: tracks every org.mpris.MediaPlayer2.* player on the session bus.
// Plain D-Bus calls + signal subscriptions so destroy() really cleans everything up.
//
// Player state: {name, owner, identity, desktopEntry, status, title, artists, album, artUrl,
//   trackId, length (µs), position (µs) + positionAt, canNext, canPrev, canSeek, canPlay,
//   canControl, shuffle (bool|null), loop ('None'|'Track'|'Playlist'|null), volume (0..1|null),
//   usedAt (last time it played or changed)}
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const ROOT = 'org.mpris.MediaPlayer2';
const PROPS = 'org.freedesktop.DBus.Properties';
const SKIP = new Set(['org.mpris.MediaPlayer2.playerctld']); // mirrors another player

const now = () => GLib.get_monotonic_time();
const SEEK_HOLD_US = 1500000; // how long our own seek outranks a stale reported position

export class MprisWatcher {
    constructor(onChange) {
        this._bus = Gio.DBus.session;
        this._onChange = onChange;
        this._players = new Map();
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();

        this._subs = [
            this._bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
                'NameOwnerChanged', '/org/freedesktop/DBus', ROOT,
                Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
                (c, s, p, i, sig, params) => {
                    const [name, , newOwner] = params.deepUnpack();
                    this._players.delete(name);
                    if (newOwner)
                        this._add(name, newOwner);
                    this._emit();
                }),
            this._bus.signal_subscribe(null, PROPS, 'PropertiesChanged', PATH, null,
                Gio.DBusSignalFlags.NONE, (c, sender, p, i, sig, params) => {
                    const st = this._byOwner(sender);
                    if (!st)
                        return;
                    const [iface] = params.deepUnpack();
                    if (iface === PLAYER)
                        this._refresh(st);
                    else if (iface === ROOT)
                        this._refreshRoot(st);
                }),
            this._bus.signal_subscribe(null, PLAYER, 'Seeked', PATH, null,
                Gio.DBusSignalFlags.NONE, (c, sender, p, i, sig, params) => {
                    const st = this._byOwner(sender);
                    if (st) {
                        st.position = Number(params.deepUnpack()[0]);
                        st.positionAt = now();
                        st.seekHold = null;
                        this._emit();
                    }
                }),
        ];

        this._call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, reply => {
                for (const name of reply.deepUnpack()[0]) {
                    if (name.startsWith(PREFIX)) {
                        this._call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                            'GetNameOwner', new GLib.Variant('(s)', [name]),
                            r => this._add(name, r.deepUnpack()[0]));
                    }
                }
            });
    }

    _call(dest, path, iface, method, params, onReply) {
        this._bus.call(dest, path, iface, method, params, null, Gio.DBusCallFlags.NONE, 2000,
            this._cancellable, (conn, res) => {
                let reply;
                try {
                    reply = conn.call_finish(res);
                } catch {
                    return; // gone / unsupported / cancelled
                }
                if (!this._destroyed)
                    onReply?.(reply);
            });
    }

    _byOwner(owner) {
        for (const st of this._players.values()) {
            if (st.owner === owner)
                return st;
        }
        return null;
    }

    _add(name, owner) {
        if (SKIP.has(name) || this._players.has(name))
            return;
        const st = {
            name, owner, identity: name.slice(PREFIX.length).split('.')[0], desktopEntry: null,
            status: 'Stopped', title: '', artists: [], album: '', artUrl: '', trackId: null,
            length: 0, position: 0, positionAt: now(), canNext: false, canPrev: false, canSeek: false,
            canPlay: false, canControl: false, shuffle: null, loop: null, volume: null, usedAt: 0,
        };
        this._players.set(name, st);
        this._refreshRoot(st);
        this._refresh(st);
    }

    _refreshRoot(st) {
        this._call(st.name, PATH, PROPS, 'GetAll', new GLib.Variant('(s)', [ROOT]), r => {
            const p = r.recursiveUnpack()[0];
            st.identity = p.Identity || st.identity;
            st.desktopEntry = p.DesktopEntry || null;
            st.canRaise = Boolean(p.CanRaise);
            this._emit();
        });
    }

    _refresh(st) {
        this._call(st.name, PATH, PROPS, 'GetAll', new GLib.Variant('(s)', [PLAYER]), r => {
            if (this._players.get(st.name) !== st)
                return;
            const p = r.recursiveUnpack()[0];
            const m = p.Metadata ?? {};
            const before = `${st.status}|${st.title}`;
            st.status = p.PlaybackStatus ?? 'Stopped';
            st.title = typeof m['xesam:title'] === 'string' ? m['xesam:title'] : '';
            st.artists = Array.isArray(m['xesam:artist']) ? m['xesam:artist'].filter(a => typeof a === 'string') : [];
            st.album = typeof m['xesam:album'] === 'string' ? m['xesam:album'] : '';
            st.artUrl = typeof m['mpris:artUrl'] === 'string' ? m['mpris:artUrl'] : '';
            const prevTrack = st.trackId;
            st.trackId = typeof m['mpris:trackid'] === 'string' ? m['mpris:trackid'] : null;
            st.length = Number(m['mpris:length'] ?? 0) || 0;
            // Right after our own seek the player may still report the old spot: trust our
            // optimistic position until it agrees (or a Seeked signal / the hold runs out), so the
            // ring never snaps back and forth.
            const hold = st.seekHold && now() < st.seekHold.until ? st.seekHold : null;
            const trackChanged = st.trackId !== null && st.trackId !== prevTrack;
            if (p.Position !== undefined) {
                const reported = Number(p.Position) || 0;
                if (!hold || trackChanged || Math.abs(reported - this.positionOf(st)) < 1.5e6) {
                    st.position = reported;
                    st.positionAt = now();
                    st.seekHold = null;
                }
            }
            st.canNext = Boolean(p.CanGoNext);
            st.canPrev = Boolean(p.CanGoPrevious);
            st.canSeek = Boolean(p.CanSeek) && st.length > 0;
            st.canPlay = p.CanPlay !== false;
            st.canControl = p.CanControl !== false;
            st.shuffle = typeof p.Shuffle === 'boolean' ? p.Shuffle : null;
            st.loop = typeof p.LoopStatus === 'string' ? p.LoopStatus : null;
            st.volume = typeof p.Volume === 'number' ? Math.max(0, Math.min(1, p.Volume)) : null;
            if (before !== `${st.status}|${st.title}` || st.status === 'Playing')
                st.usedAt = now();
            this._emit();
        });
    }

    // Players worth showing (have a track, playing or paused), most relevant first.
    get players() {
        const rank = s => ({Playing: 2, Paused: 1}[s.status] ?? 0);
        return [...this._players.values()]
            .filter(s => s.title && rank(s) > 0)
            .sort((a, b) => rank(b) - rank(a) || b.usedAt - a.usedAt);
    }

    get current() {
        return this.players[0] ?? null;
    }

    get(name) {
        return this._players.get(name) ?? null;
    }

    positionOf(st) {
        let pos = st.position;
        if (st.status === 'Playing')
            pos += now() - st.positionAt;
        return st.length > 0 ? Math.max(0, Math.min(pos, st.length)) : pos;
    }

    // Re-read Position (most players don't signal it).
    syncPosition(st) {
        if (!st)
            return;
        this._call(st.name, PATH, PROPS, 'Get', new GLib.Variant('(ss)', [PLAYER, 'Position']), r => {
            const v = Number(r.recursiveUnpack()[0]);
            if (Number.isFinite(v)) {
                st.position = v;
                st.positionAt = now();
            }
        });
    }

    _cmd(st, method, params = null) {
        if (st)
            this._call(st.name, PATH, PLAYER, method, params, () => this._refresh(st));
    }

    playPause(st = this.current) {
        this._cmd(st, 'PlayPause');
    }

    next(st = this.current) {
        this._cmd(st, 'Next');
    }

    previous(st = this.current) {
        this._cmd(st, 'Previous');
    }

    // offset in µs (relative)
    seekBy(st, offset) {
        if (!st?.canSeek)
            return;
        this._cmd(st, 'Seek', new GLib.Variant('(x)', [Math.round(offset)]));
        st.position = this.positionOf(st) + offset;
        st.positionAt = now();
        st.seekHold = {pos: st.position, until: now() + SEEK_HOLD_US};
    }

    // absolute position in µs
    setPosition(st, pos) {
        if (!st?.canSeek || !st.trackId)
            return;
        pos = Math.max(0, Math.min(st.length, Math.round(pos)));
        this._cmd(st, 'SetPosition', new GLib.Variant('(ox)', [st.trackId, pos]));
        st.position = pos;
        st.positionAt = now();
        st.seekHold = {pos, until: now() + SEEK_HOLD_US};
    }

    _set(st, prop, variant) {
        if (st)
            this._call(st.name, PATH, PROPS, 'Set', new GLib.Variant('(ssv)', [PLAYER, prop, variant]), () => this._refresh(st));
    }

    setShuffle(st, on) {
        this._set(st, 'Shuffle', GLib.Variant.new_boolean(on));
    }

    setLoop(st, mode) {
        this._set(st, 'LoopStatus', GLib.Variant.new_string(mode));
    }

    setVolume(st, v) {
        this._set(st, 'Volume', GLib.Variant.new_double(Math.max(0, Math.min(1, v))));
    }

    raise(st) {
        if (st)
            this._call(st.name, PATH, ROOT, 'Raise', null);
    }

    _emit() {
        if (!this._destroyed)
            this._onChange?.();
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        for (const id of this._subs)
            this._bus.signal_unsubscribe(id);
        this._subs = [];
        this._players.clear();
        this._onChange = null;
    }
}
