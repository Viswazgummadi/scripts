// SPDX-License-Identifier: GPL-3.0-or-later
// Now Playing: "play", "pause", "next", "previous", "music", or the current song's title.
// Players are read on demand (one ListNames + one Get per player, once per open), never watched.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {best, prepare} from '../core/fuzzy.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';

function call(dest, path, iface, method, params, timeout = 800) {
    return new Promise(resolve => {
        Gio.DBus.session.call(dest, path, iface, method, params, null, Gio.DBusCallFlags.NONE, timeout, null, (c, res) => {
            try {
                resolve(c.call_finish(res).deepUnpack());
            } catch {
                resolve(null);
            }
        });
    });
}

const VERBS = prepare('play pause resume stop next skip previous prev back music song track now playing media spotify');

export class MediaProvider {
    constructor(ctx) {
        this.id = 'media';
        this.sync = false;
        this.delay = 0;
        this.minChars = 2;
        this._ctx = ctx;
        this._players = null;
    }

    open() {
        this._players = null;
    }

    async _load() {
        if (this._players)
            return this._players;
        const names = (await call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null))?.[0] ?? [];
        const players = [];
        for (const name of names.filter(n => n.startsWith(PREFIX) && !n.endsWith('playerctld'))) {
            const props = (await call(name, PATH, 'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', [PLAYER])))?.[0];
            if (!props)
                continue;
            const get = k => props[k]?.deepUnpack?.() ?? props[k];
            const meta = get('Metadata') ?? {};
            const m = k => meta[k]?.deepUnpack?.() ?? meta[k];
            const root = (await call(name, PATH, 'org.freedesktop.DBus.Properties', 'Get', new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2', 'Identity'])))?.[0];
            players.push({
                name,
                identity: root?.deepUnpack?.() ?? name.slice(PREFIX.length).split('.')[0],
                status: get('PlaybackStatus'),
                title: m('xesam:title') ?? '',
                artist: (m('xesam:artist') ?? []).join(', '),
                art: m('mpris:artUrl') ?? '',
            });
        }
        // the playing one first
        players.sort((a, b) => (b.status === 'Playing') - (a.status === 'Playing'));
        this._players = players;
        return players;
    }

    async search(q, cancellable) {
        if (q.prefix || q.kind || !q.folded)
            return [];
        const verbHit = best(q.folded, [[VERBS, 1]]) >= 600;
        if (!verbHit && q.folded.length < 3)
            return [];
        const players = await this._load();
        if (cancellable?.is_cancelled())
            return [];
        const out = [];
        for (const p of players) {
            const songHit = p.title ? best(q.folded, [[prepare(p.title), 1], [prepare(p.artist), 0.8]]) : 0;
            if (!verbHit && songHit < 600)
                continue;
            const playing = p.status === 'Playing';
            const icon = p.art.startsWith('file://') ? {file: Gio.File.new_for_uri(p.art).get_path(), mime: 'image/jpeg', thumb: true} : {name: 'audio-x-generic'};
            const song = p.title ? `${p.title}${p.artist ? ` — ${p.artist}` : ''}` : p.identity;
            const act = (method, label, iconName, score) => ({
                id: `media:${p.name}:${method}`, section: 'media', noLearn: true,
                title: label, subtitle: `${song} · ${p.identity}`, kind: 'Media',
                icon: method === 'PlayPause' ? icon : {name: iconName}, score,
                activate: () => call(p.name, PATH, PLAYER, method, null, 2000),
                preview: {type: 'media', art: p.art, title: p.title || p.identity, artist: p.artist, player: p.identity, status: p.status},
                hints: [['↩', label]],
            });
            const f = q.folded;
            const wantsNext = /^(next|skip)/.test(f), wantsPrev = /^(prev|back)/.test(f);
            out.push(act('PlayPause', playing ? 'Pause' : 'Play', 'media-playback-start-symbolic', wantsNext || wantsPrev ? 600 : 900 + songHit / 10));
            out.push(act('Next', 'Next Track', 'media-skip-forward-symbolic', wantsNext ? 950 : 560));
            out.push(act('Previous', 'Previous Track', 'media-skip-backward-symbolic', wantsPrev ? 950 : 540));
        }
        return out;
    }

    destroy() {
        this._players = null;
    }
}
