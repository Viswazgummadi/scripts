// SPDX-License-Identifier: GPL-3.0-or-later
// Today's calendar event titles for the quote picker.
//
// Listens to the date menu's own event source (never a second DBusEventSource: the calendar
// server keeps one shared time range) and keeps a small per-day cache in
// ~/.cache/lucent-tiles/events.json, so events are known right after login too.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

import {dateKey} from './quotes.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const KEEP_DAYS = 45;

export class EventCache {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lucent-tiles']);
        this._file = GLib.build_filenamev([this._dir, 'events.json']);
        this._days = this._read();
        this._src = null;
        this._srcId = 0;
        this._modeId = Main.sessionMode.connect('updated', () => this._hook());
        this._hook();
    }

    _read() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._file);
            const data = ok ? JSON.parse(decoder.decode(bytes)) : {};
            return data && typeof data === 'object' ? data : {};
        } catch {
            return {};
        }
    }

    _write() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            GLib.file_set_contents(this._file, encoder.encode(JSON.stringify(this._days)));
        } catch (e) {
            console.warn(`lucent-tiles: ${this._file}: ${e.message}`);
        }
    }

    _unhook() {
        if (this._src && this._srcId)
            this._src.disconnect(this._srcId);
        this._src = null;
        this._srcId = 0;
    }

    _hook() {
        const src = Main.panel?.statusArea?.dateMenu?._eventSource ?? null;
        if (src === this._src)
            return;
        this._unhook();
        if (!Main.sessionMode.showCalendarEvents || !(src instanceof Calendar.DBusEventSource))
            return;
        this._src = src;
        this._srcId = src.connect('changed', () => this._snapshot());
        this._snapshot();
    }

    _snapshot() {
        const src = this._src;
        if (!src || src.isLoading || !src.hasCalendars || !Main.sessionMode.showCalendarEvents)
            return;
        // Only trust days inside the range the date menu actually asked the server for.
        const begin = src._lastRequestBegin, end = src._lastRequestEnd;
        if (!(begin instanceof Date) || !(end instanceof Date))
            return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let changed = false;
        for (let i = 0; i < 7; i++) {
            const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
            const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i + 1);
            if (day < begin || next > end)
                continue;
            const titles = [...new Set(src.getEvents(day, next).map(e => e.summary).filter(Boolean))];
            const key = dateKey(day);
            if (JSON.stringify(this._days[key] ?? []) !== JSON.stringify(titles)) {
                this._days[key] = titles;
                changed = true;
            }
        }
        // Drop old days.
        const cutoff = dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - KEEP_DAYS));
        for (const key of Object.keys(this._days)) {
            if (key < cutoff) {
                delete this._days[key];
                changed = true;
            }
        }
        if (changed)
            this._write();
    }

    today(now = new Date()) {
        return this._days[dateKey(now)] ?? [];
    }

    destroy() {
        this._unhook();
        if (this._modeId)
            Main.sessionMode.disconnect(this._modeId);
        this._modeId = 0;
    }
}
