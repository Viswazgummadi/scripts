// SPDX-License-Identifier: GPL-3.0-or-later
// Query understanding (pure JS).
// parse(raw) -> {raw, text, folded, terms, kind, after, before, inDir, ext, prefix}
//   kind:pdf / kind:image / "pdfs from last week" / "images today" / date:yesterday / in:Downloads / ext:md
//   prefix: '>' command, '=' calculator, '?' web search, null otherwise.
import {fold} from './fuzzy.js';

// kind -> {mime prefixes, extensions}
export const KINDS = {
    folder: {label: 'Folders', mime: ['inode/directory'], ext: []},
    image: {label: 'Images', mime: ['image/'], ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'ico', 'xcf', 'raw', 'cr2', 'nef']},
    pdf: {label: 'PDF Documents', mime: ['application/pdf'], ext: ['pdf']},
    presentation: {label: 'Presentations', mime: ['application/vnd.openxmlformats-officedocument.presentationml', 'application/vnd.ms-powerpoint', 'application/vnd.oasis.opendocument.presentation'], ext: ['pptx', 'ppt', 'odp', 'key']},
    spreadsheet: {label: 'Spreadsheets', mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml', 'application/vnd.ms-excel', 'application/vnd.oasis.opendocument.spreadsheet', 'text/csv'], ext: ['xlsx', 'xls', 'ods', 'csv', 'tsv', 'numbers']},
    document: {label: 'Documents', mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml', 'application/msword', 'application/vnd.oasis.opendocument.text', 'application/rtf', 'text/markdown', 'text/plain'], ext: ['docx', 'doc', 'odt', 'rtf', 'md', 'txt', 'tex', 'pages', 'epub']},
    audio: {label: 'Music', mime: ['audio/'], ext: ['mp3', 'flac', 'ogg', 'opus', 'wav', 'm4a', 'aac', 'wma']},
    video: {label: 'Movies', mime: ['video/'], ext: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'm4v']},
    code: {label: 'Developer', mime: ['text/x-', 'application/x-shellscript', 'application/json', 'application/xml', 'application/javascript', 'text/css', 'text/html'], ext: ['c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cu', 'cuh', 'py', 'js', 'mjs', 'ts', 'rs', 'go', 'java', 'kt', 'sh', 'zsh', 'bash', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'll', 'td', 's', 'S', 'cmake', 'mk', 'lua', 'rb', 'php', 'sql', 'glsl', 'cl', 'v', 'sv', 'vhd']},
    archive: {label: 'Archives', mime: ['application/zip', 'application/x-tar', 'application/gzip', 'application/x-7z', 'application/x-xz', 'application/x-bzip', 'application/zstd', 'application/x-rar'], ext: ['zip', 'tar', 'gz', 'tgz', 'xz', 'bz2', 'zst', '7z', 'rar', 'rpm', 'deb', 'iso', 'appimage']},
};

const KIND_WORDS = {
    folder: ['folder', 'folders', 'directory', 'directories', 'dir', 'dirs'],
    image: ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'screenshot', 'screenshots', 'wallpaper', 'wallpapers'],
    pdf: ['pdf', 'pdfs'],
    presentation: ['presentation', 'presentations', 'slides', 'deck', 'decks', 'ppt', 'pptx', 'keynote'],
    spreadsheet: ['spreadsheet', 'spreadsheets', 'sheet', 'sheets', 'excel', 'csv'],
    document: ['document', 'documents', 'doc', 'docs', 'note', 'notes', 'text'],
    audio: ['music', 'song', 'songs', 'audio', 'mp3', 'track', 'tracks'],
    video: ['video', 'videos', 'movie', 'movies', 'film', 'films', 'clip', 'clips'],
    code: ['code', 'source', 'sources', 'script', 'scripts'],
    archive: ['archive', 'archives', 'zip', 'zips', 'tarball'],
};
const kindByWord = new Map();
for (const [k, ws] of Object.entries(KIND_WORDS)) {
    for (const w of ws)
        kindByWord.set(w, k);
}

export function kindOf(name, mime) {
    if (mime === 'inode/directory')
        return 'folder';
    const ext = /\.([^.\/]+)$/.exec(name ?? '')?.[1]?.toLowerCase();
    for (const [k, d] of Object.entries(KINDS)) {
        if (k === 'folder')
            continue;
        if (ext && d.ext.includes(ext))
            return k;
    }
    if (mime) {
        for (const [k, d] of Object.entries(KINDS)) {
            if (d.mime.some(p => mime.startsWith(p)))
                return k;
        }
    }
    return 'other';
}

const DAY = 86400000;
function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// "today", "yesterday", "this week", "last week", "this month", "last month", "this year",
// "last year", "last 3 days", "past 2 weeks" -> [after, before) in ms
export function dateRange(phrase, now = new Date()) {
    const p = phrase.trim().toLowerCase();
    const t0 = startOfDay(now).getTime();
    const dow = (now.getDay() + 6) % 7; // monday = 0
    let m;
    switch (p) {
    case 'today': return [t0, t0 + DAY];
    case 'yesterday': return [t0 - DAY, t0];
    case 'this week': return [t0 - dow * DAY, t0 + DAY];
    case 'last week': return [t0 - (dow + 7) * DAY, t0 - dow * DAY];
    case 'this month': return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), t0 + DAY];
    case 'last month': return [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime()];
    case 'this year': return [new Date(now.getFullYear(), 0, 1).getTime(), t0 + DAY];
    case 'last year': return [new Date(now.getFullYear() - 1, 0, 1).getTime(), new Date(now.getFullYear(), 0, 1).getTime()];
    }
    if ((m = /^(?:last|past)\s+(\d+)\s+(day|week|month)s?$/.exec(p))) {
        const n = Number(m[1]) * {day: 1, week: 7, month: 30}[m[2]];
        return [t0 - (n - 1) * DAY, t0 + DAY];
    }
    return null;
}

const DATE_PHRASE = /(?:^|\s)(?:(?:from|modified|created|edited|opened|since|in)\s+)?(today|yesterday|this week|last week|this month|last month|this year|last year|(?:last|past)\s+\d+\s+(?:days?|weeks?|months?))\s*$/i;

export function parse(raw) {
    const q = {raw, text: '', folded: '', terms: [], kind: null, after: null, before: null, inDir: null, ext: null, prefix: null, natural: false};
    let s = String(raw ?? '');
    const lead = /^\s*([>=?])\s*/.exec(s);
    if (lead) {
        q.prefix = lead[1];
        s = s.slice(lead[0].length);
    }
    s = s.replace(/^\s+/, '');

    if (!q.prefix) {
        // explicit filters anywhere: kind:pdf date:today in:Downloads ext:md
        s = s.replace(/(?:^|\s)(kind|type|date|in|ext):("[^"]*"|\S+)/gi, (_, key, val) => {
            val = val.replace(/^"|"$/g, '');
            const k = key.toLowerCase();
            if (k === 'kind' || k === 'type') {
                q.kind = kindByWord.get(val.toLowerCase()) ?? (val.toLowerCase() in KINDS ? val.toLowerCase() : null);
            } else if (k === 'date') {
                const r = dateRange(val.replace(/[-_]/g, ' '));
                if (r)
                    [q.after, q.before] = r;
            } else if (k === 'in') {
                q.inDir = val;
            } else if (k === 'ext') {
                q.ext = val.replace(/^\./, '').toLowerCase();
            }
            return ' ';
        });

        // natural language: "pdfs from last week", "screenshots today", "presentations"
        const dm = DATE_PHRASE.exec(s);
        if (dm && s.trim() !== dm[0].trim()) {
            const r = dateRange(dm[1]);
            if (r) {
                [q.after, q.before] = r;
                s = s.slice(0, dm.index);
                q.natural = true;
            }
        } else if (dm && s.trim() === dm[0].trim()) {
            // the whole query is a date phrase: "today" → files from today, but keep it as text too
            const r = dateRange(dm[1]);
            if (r) {
                q.dateOnly = r;
            }
        }
        const ws = s.trim().split(/\s+/).filter(Boolean);
        if (!q.kind && ws.length) {
            const k = kindByWord.get(ws[0].toLowerCase());
            // a kind word counts as a filter when followed by more words or a date ("pdfs about x")
            if (k && (ws.length > 1 || q.after !== null)) {
                q.kind = k;
                ws.shift();
                if (['about', 'with', 'named', 'called', 'containing'].includes(ws[0]?.toLowerCase()))
                    ws.shift();
                q.natural = true;
            }
        }
        s = ws.join(' ');
        // a lone kind word ("pdfs", "screenshots") stays a text query but also hints at the kind
        if (!q.kind && ws.length === 1)
            q.kindHint = kindByWord.get(ws[0].toLowerCase()) ?? null;
    }
    q.text = s.trim();
    q.folded = fold(q.text);
    q.terms = q.folded.split(/\s+/).filter(Boolean);
    q.hasFilters = Boolean(q.kind || q.after !== null || q.inDir || q.ext);
    return q;
}

// ---- dates and time zones --------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const HOLIDAYS = {christmas: [11, 25], xmas: [11, 25], 'new year': [0, 1], 'new years': [0, 1], halloween: [9, 31], valentines: [1, 14], 'independence day': [7, 15], 'republic day': [0, 26]};

function parseDay(s, now) {
    s = s.trim().toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ');
    if (s === 'today')
        return startOfDay(now);
    if (s === 'tomorrow')
        return new Date(startOfDay(now).getTime() + DAY);
    if (s === 'yesterday')
        return new Date(startOfDay(now).getTime() - DAY);
    let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)))
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const next = (mo, d) => {
        let dt = new Date(now.getFullYear(), mo, d);
        if (dt < startOfDay(now))
            dt = new Date(now.getFullYear() + 1, mo, d);
        return dt;
    };
    if (HOLIDAYS[s])
        return next(...HOLIDAYS[s]);
    // "dec 25", "25 dec", "december 25 2027", "25/12/2027" (day-first, India/EU)
    if ((m = /^([a-z]{3})[a-z]*\s+(\d{1,2})(?:\s+(\d{4}))?$/.exec(s)) && MONTHS.includes(m[1]))
        return m[3] ? new Date(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2])) : next(MONTHS.indexOf(m[1]), Number(m[2]));
    if ((m = /^(\d{1,2})\s+([a-z]{3})[a-z]*(?:\s+(\d{4}))?$/.exec(s)) && MONTHS.includes(m[2]))
        return m[3] ? new Date(Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1])) : next(MONTHS.indexOf(m[2]), Number(m[1]));
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)))
        return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return null;
}

// 2026-02-02 for the local calendar day. (toISOString() gives the UTC day, which is the day
// before for anyone east of Greenwich during the early hours.)
function isoDate(d) {
    const two = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function formatDate(d) {
    return d.toLocaleDateString('en-GB', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'});
}

// "days until dec 25" · "days since 2026-01-01" · "today + 30 days" · "90 days from today"
// · "what day is dec 25" · "week number" -> {title, subtitle} | null
export function dateMath(text, now = new Date()) {
    const s = String(text ?? '').trim().toLowerCase();
    let m;
    if ((m = /^(?:how many\s+)?(days|weeks)\s+(until|till|to|since|from)\s+(.+?)\??$/.exec(s))) {
        const d = parseDay(m[3], now);
        if (!d)
            return null;
        const diff = Math.round((d.getTime() - startOfDay(now).getTime()) / DAY);
        const n = Math.abs(diff);
        const unit = m[1] === 'weeks' ? `${(n / 7).toFixed(n % 7 ? 1 : 0)} weeks` : `${n} day${n === 1 ? '' : 's'}`;
        return {title: unit, subtitle: `${diff >= 0 ? 'until' : 'since'} ${formatDate(d)}`, copy: m[1] === 'weeks' ? (n / 7).toFixed(1) : String(n)};
    }
    if ((m = /^(today|now|tomorrow|yesterday|[\d-]{8,10})\s*([+-])\s*(\d+)\s*(days?|weeks?|months?|years?)$/.exec(s)) ||
        (m = /^(\d+)\s*(days?|weeks?|months?|years?)\s+(from|after|before)\s+(today|now|tomorrow|[\d-]{8,10})$/.exec(s))) {
        let base, sign, n, unit;
        if (/^\d+$/.test(m[1]) && m.length === 5 && /from|after|before/.test(m[3])) {
            [n, unit, sign, base] = [Number(m[1]), m[2], m[3] === 'before' ? '-' : '+', m[4]];
        } else {
            [base, sign, n, unit] = [m[1], m[2], Number(m[3]), m[4]];
        }
        const d = parseDay(base === 'now' ? 'today' : base, now);
        if (!d)
            return null;
        const k = sign === '-' ? -n : n;
        if (unit.startsWith('day'))
            d.setDate(d.getDate() + k);
        else if (unit.startsWith('week'))
            d.setDate(d.getDate() + 7 * k);
        else if (unit.startsWith('month'))
            d.setMonth(d.getMonth() + k);
        else
            d.setFullYear(d.getFullYear() + k);
        return {title: formatDate(d), subtitle: `${n} ${unit} ${sign === '-' ? 'before' : 'after'} ${base}`, copy: isoDate(d)};
    }
    if ((m = /^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?(today|tomorrow|yesterday|date(?:\s+today)?|today'?s date)\??$/.exec(s))) {
        const word = m[1].startsWith('tomorrow') ? 'tomorrow' : m[1].startsWith('yesterday') ? 'yesterday' : 'today';
        const d = parseDay(word, now);
        return {title: formatDate(d), subtitle: word[0].toUpperCase() + word.slice(1), copy: isoDate(d)};
    }
    if ((m = /^(?:what\s+)?day\s+(?:is|was|of)\s+(.+?)\??$/.exec(s))) {
        const d = parseDay(m[1], now);
        return d ? {title: d.toLocaleDateString('en-GB', {weekday: 'long'}), subtitle: formatDate(d), copy: formatDate(d)} : null;
    }
    if (/^(week number|what week is it|week no|current week)$/.test(s)) {
        const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        const day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - day);
        const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const wk = Math.ceil(((d - y0) / DAY + 1) / 7);
        return {title: `Week ${wk}`, subtitle: `ISO week of ${formatDate(now)}`, copy: String(wk)};
    }
    if (/^(date|today|today's date|what is the date|what's the date)$/.test(s))
        return {title: formatDate(now), subtitle: 'Today', copy: isoDate(now)};
    return null;
}

// city / abbreviation -> IANA zone. Kept small on purpose: the common ones plus the team's.
export const ZONES = {
    'london': 'Europe/London', 'uk': 'Europe/London', 'gmt': 'Etc/GMT', 'utc': 'Etc/UTC',
    'paris': 'Europe/Paris', 'berlin': 'Europe/Berlin', 'madrid': 'Europe/Madrid', 'rome': 'Europe/Rome',
    'amsterdam': 'Europe/Amsterdam', 'zurich': 'Europe/Zurich', 'stockholm': 'Europe/Stockholm',
    'moscow': 'Europe/Moscow', 'istanbul': 'Europe/Istanbul', 'athens': 'Europe/Athens', 'cet': 'Europe/Paris',
    'dubai': 'Asia/Dubai', 'riyadh': 'Asia/Riyadh', 'tehran': 'Asia/Tehran', 'karachi': 'Asia/Karachi',
    'india': 'Asia/Kolkata', 'ist': 'Asia/Kolkata', 'delhi': 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata',
    'mumbai': 'Asia/Kolkata', 'bangalore': 'Asia/Kolkata', 'bengaluru': 'Asia/Kolkata', 'pune': 'Asia/Kolkata',
    'hyderabad': 'Asia/Kolkata', 'chennai': 'Asia/Kolkata', 'kolkata': 'Asia/Kolkata',
    'kathmandu': 'Asia/Kathmandu', 'dhaka': 'Asia/Dhaka', 'bangkok': 'Asia/Bangkok', 'jakarta': 'Asia/Jakarta',
    'singapore': 'Asia/Singapore', 'kuala lumpur': 'Asia/Kuala_Lumpur', 'hong kong': 'Asia/Hong_Kong',
    'beijing': 'Asia/Shanghai', 'shanghai': 'Asia/Shanghai', 'china': 'Asia/Shanghai', 'taipei': 'Asia/Taipei',
    'seoul': 'Asia/Seoul', 'tokyo': 'Asia/Tokyo', 'japan': 'Asia/Tokyo', 'jst': 'Asia/Tokyo', 'manila': 'Asia/Manila',
    'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne', 'perth': 'Australia/Perth',
    'auckland': 'Pacific/Auckland', 'honolulu': 'Pacific/Honolulu', 'hawaii': 'Pacific/Honolulu',
    'new york': 'America/New_York', 'nyc': 'America/New_York', 'boston': 'America/New_York', 'est': 'America/New_York',
    'edt': 'America/New_York', 'toronto': 'America/Toronto', 'chicago': 'America/Chicago', 'cst': 'America/Chicago',
    'denver': 'America/Denver', 'mst': 'America/Denver', 'phoenix': 'America/Phoenix',
    'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles',
    'sf': 'America/Los_Angeles', 'seattle': 'America/Los_Angeles', 'pst': 'America/Los_Angeles', 'pdt': 'America/Los_Angeles',
    'cupertino': 'America/Los_Angeles', 'vancouver': 'America/Vancouver', 'mexico city': 'America/Mexico_City',
    'sao paulo': 'America/Sao_Paulo', 'buenos aires': 'America/Argentina/Buenos_Aires', 'lagos': 'Africa/Lagos',
    'cairo': 'Africa/Cairo', 'nairobi': 'Africa/Nairobi', 'johannesburg': 'Africa/Johannesburg',
};

// "time in tokyo" · "tokyo time" · "what time is it in london" -> {zone, place} | null
export function timeQuery(text) {
    const s = String(text ?? '').trim().toLowerCase().replace(/\?$/, '');
    let m = /^(?:what(?:'s| is)?\s+(?:the\s+)?)?time(?:\s+is\s+it)?\s+in\s+(.+)$/.exec(s) ?? /^(.+?)\s+time$/.exec(s) ?? /^time\s+(.+)$/.exec(s);
    if (!m)
        return null;
    const place = m[1].trim();
    const zone = ZONES[place];
    return zone ? {zone, place: place.replace(/\b\w/g, c => c.toUpperCase())} : null;
}
