// SPDX-License-Identifier: GPL-3.0-or-later
// Unit + currency conversion (pure JS).
// convert(text, {rates, homeCurrencies}) -> {category, input, results:[{value, unit, display}]} | null
//   "100 km to mi" · "5'11\" in cm" · "72f" · "3 cups in ml" · "$20 in rupees" · "1.5 GiB to MB"
// Without a target unit it answers with the category's common units (like macOS does).
import {formatNumber} from './calc.js';

// [category, base unit note, [[symbol, factor-to-base, ...aliases]]]
const TABLE = {
    length: [
        ['nm', 1e-9, 'nanometer', 'nanometers', 'nanometre', 'nanometres'],
        ['µm', 1e-6, 'um', 'micron', 'microns', 'micrometer', 'micrometers'],
        ['mm', 1e-3, 'millimeter', 'millimeters', 'millimetre', 'millimetres'],
        ['cm', 1e-2, 'centimeter', 'centimeters', 'centimetre', 'centimetres'],
        ['m', 1, 'meter', 'meters', 'metre', 'metres'],
        ['km', 1e3, 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'kms'],
        ['in', 0.0254, 'inch', 'inches', '"', '″'],
        ['ft', 0.3048, 'foot', 'feet', "'", '′'],
        ['yd', 0.9144, 'yard', 'yards'],
        ['mi', 1609.344, 'mile', 'miles'],
        ['nmi', 1852, 'nautical mile', 'nautical miles'],
        ['au', 149597870700, 'astronomical unit', 'astronomical units'],
        ['ly', 9460730472580800, 'light year', 'light years', 'lightyear', 'lightyears'],
    ],
    mass: [
        ['mg', 1e-6, 'milligram', 'milligrams'],
        ['g', 1e-3, 'gram', 'grams', 'gm', 'gms'],
        ['kg', 1, 'kilogram', 'kilograms', 'kilo', 'kilos', 'kgs'],
        ['t', 1e3, 'tonne', 'tonnes', 'metric ton', 'metric tons', 'ton', 'tons'],
        ['ct', 2e-4, 'carat', 'carats'],
        ['oz', 0.028349523125, 'ounce', 'ounces'],
        ['lb', 0.45359237, 'lbs', 'pound', 'pounds'],
        ['st', 6.35029318, 'stone', 'stones'],
    ],
    volume: [
        ['ml', 1e-3, 'mL', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc'],
        ['cl', 1e-2, 'centiliter', 'centiliters'],
        ['dl', 1e-1, 'deciliter', 'deciliters'],
        ['l', 1, 'L', 'liter', 'liters', 'litre', 'litres', 'ltr'],
        ['m³', 1e3, 'm3', 'cubic meter', 'cubic meters', 'cubic metre', 'cubic metres'],
        ['tsp', 0.00492892159375, 'teaspoon', 'teaspoons'],
        ['tbsp', 0.01478676478125, 'tablespoon', 'tablespoons'],
        ['fl oz', 0.0295735295625, 'floz', 'fluid ounce', 'fluid ounces'],
        ['cup', 0.2365882365, 'cups'],
        ['pt', 0.473176473, 'pint', 'pints'],
        ['qt', 0.946352946, 'quart', 'quarts'],
        ['gal', 3.785411784, 'gallon', 'gallons'],
        ['ft³', 28.316846592, 'ft3', 'cubic foot', 'cubic feet'],
    ],
    area: [
        ['mm²', 1e-6, 'mm2', 'square millimeter', 'square millimeters'],
        ['cm²', 1e-4, 'cm2', 'square centimeter', 'square centimeters'],
        ['m²', 1, 'm2', 'sqm', 'square meter', 'square meters', 'square metre', 'square metres'],
        ['ha', 1e4, 'hectare', 'hectares'],
        ['km²', 1e6, 'km2', 'square kilometer', 'square kilometers'],
        ['in²', 0.00064516, 'in2', 'sq in', 'square inch', 'square inches'],
        ['ft²', 0.09290304, 'ft2', 'sqft', 'sq ft', 'square foot', 'square feet'],
        ['yd²', 0.83612736, 'yd2', 'square yard', 'square yards'],
        ['acre', 4046.8564224, 'acres', 'ac'],
        ['mi²', 2589988.110336, 'mi2', 'square mile', 'square miles'],
    ],
    speed: [
        ['m/s', 1, 'mps', 'meters per second', 'metres per second'],
        ['km/h', 1 / 3.6, 'kmh', 'kph', 'kmph', 'kilometers per hour', 'kilometres per hour'],
        ['mph', 0.44704, 'mi/h', 'miles per hour'],
        ['ft/s', 0.3048, 'fps', 'feet per second'],
        ['kn', 0.514444444, 'knot', 'knots', 'kt'],
        ['mach', 340.29],
    ],
    time: [
        ['ns', 1e-9, 'nanosecond', 'nanoseconds'],
        ['µs', 1e-6, 'us', 'microsecond', 'microseconds'],
        ['ms', 1e-3, 'millisecond', 'milliseconds'],
        ['s', 1, 'sec', 'secs', 'second', 'seconds'],
        ['min', 60, 'mins', 'minute', 'minutes'],
        ['h', 3600, 'hr', 'hrs', 'hour', 'hours'],
        ['day', 86400, 'days', 'd'],
        ['week', 604800, 'weeks', 'wk', 'wks'],
        ['month', 2629746, 'months', 'mo'],
        ['year', 31556952, 'years', 'yr', 'yrs'],
    ],
    data: [
        ['bit', 0.125, 'bits', 'b'],
        ['B', 1, 'byte', 'bytes'],
        ['kB', 1e3, 'KB', 'kilobyte', 'kilobytes'],
        ['KiB', 1024, 'kibibyte', 'kibibytes'],
        ['MB', 1e6, 'megabyte', 'megabytes'],
        ['MiB', 1048576, 'mebibyte', 'mebibytes'],
        ['GB', 1e9, 'gigabyte', 'gigabytes'],
        ['GiB', 1073741824, 'gibibyte', 'gibibytes'],
        ['TB', 1e12, 'terabyte', 'terabytes'],
        ['TiB', 1099511627776, 'tebibyte', 'tebibytes'],
        ['Kb', 125, 'kbit', 'kilobit', 'kilobits'],
        ['Mb', 125000, 'mbit', 'megabit', 'megabits'],
        ['Gb', 125000000, 'gbit', 'gigabit', 'gigabits'],
    ],
    energy: [
        ['J', 1, 'joule', 'joules'],
        ['kJ', 1e3, 'kilojoule', 'kilojoules'],
        ['cal', 4.184, 'calorie', 'calories'],
        ['kcal', 4184, 'kilocalorie', 'kilocalories', 'Cal'],
        ['Wh', 3600, 'watt hour', 'watt hours'],
        ['kWh', 3.6e6, 'kilowatt hour', 'kilowatt hours', 'unit', 'units'],
        ['eV', 1.602176634e-19, 'electronvolt', 'electronvolts'],
        ['BTU', 1055.05585262, 'btu', 'btus'],
    ],
    power: [
        ['W', 1, 'watt', 'watts'],
        ['kW', 1e3, 'kilowatt', 'kilowatts'],
        ['MW', 1e6, 'megawatt', 'megawatts'],
        ['hp', 745.69987158227022, 'horsepower'],
    ],
    pressure: [
        ['Pa', 1, 'pascal', 'pascals'],
        ['kPa', 1e3, 'kilopascal', 'kilopascals'],
        ['bar', 1e5, 'bars'],
        ['atm', 101325, 'atmosphere', 'atmospheres'],
        ['psi', 6894.757293168, 'PSI'],
        ['mmHg', 133.322387415, 'mmhg', 'torr'],
    ],
    angle: [
        ['°', Math.PI / 180, 'deg', 'degree', 'degrees'],
        ['rad', 1, 'radian', 'radians'],
        ['grad', Math.PI / 200, 'gradian', 'gradians', 'gon'],
        ['turn', 2 * Math.PI, 'turns', 'rev', 'revolution', 'revolutions'],
    ],
    frequency: [
        ['Hz', 1, 'hz', 'hertz'],
        ['kHz', 1e3, 'khz', 'kilohertz'],
        ['MHz', 1e6, 'mhz', 'megahertz'],
        ['GHz', 1e9, 'ghz', 'gigahertz'],
    ],
};

// Common targets when the user did not name one, per category and per source unit system.
const COMMON = {
    length: {metric: ['in', 'ft', 'mi', 'm'], imperial: ['cm', 'm', 'km', 'ft']},
    mass: {metric: ['lb', 'oz', 'g', 'kg'], imperial: ['kg', 'g', 'lb', 'oz']},
    volume: {metric: ['fl oz', 'cup', 'gal', 'ml'], imperial: ['ml', 'l', 'cup', 'fl oz']},
    area: {metric: ['ft²', 'acre', 'm²', 'ha'], imperial: ['m²', 'ha', 'ft²', 'acre']},
    speed: {metric: ['mph', 'km/h', 'm/s', 'kn'], imperial: ['km/h', 'm/s', 'mph', 'kn']},
    time: {metric: ['s', 'min', 'h', 'day']},
    data: {metric: ['MB', 'MiB', 'GB', 'GiB']},
    energy: {metric: ['J', 'kcal', 'kWh', 'BTU']},
    power: {metric: ['W', 'kW', 'hp']},
    pressure: {metric: ['kPa', 'bar', 'psi', 'atm']},
    angle: {metric: ['°', 'rad', 'turn']},
    frequency: {metric: ['Hz', 'kHz', 'MHz', 'GHz']},
    temperature: {metric: ['°C', '°F', 'K']},
};
const IMPERIAL = new Set(['in', 'ft', 'yd', 'mi', 'oz', 'lb', 'st', 'tsp', 'tbsp', 'fl oz', 'cup', 'pt', 'qt', 'gal', 'ft³',
    'in²', 'ft²', 'yd²', 'acre', 'mi²', 'mph', 'ft/s']);

const TEMPS = [
    ['°C', 'c', 'celsius', 'centigrade', 'degc', 'degrees c', 'degrees celsius', '℃'],
    ['°F', 'f', 'fahrenheit', 'degf', 'degrees f', 'degrees fahrenheit', '℉'],
    ['K', 'k', 'kelvin', 'kelvins'],
];

// currency code -> aliases (symbols handled separately)
const CURRENCY_NAMES = {
    USD: ['usd', 'dollar', 'dollars', 'us dollar', 'us dollars', 'bucks'],
    EUR: ['eur', 'euro', 'euros'],
    INR: ['inr', 'rupee', 'rupees', 'rs', 'indian rupee', 'indian rupees'],
    GBP: ['gbp', 'british pound', 'british pounds', 'sterling', 'quid'],
    JPY: ['jpy', 'yen'],
    CNY: ['cny', 'yuan', 'rmb', 'renminbi'],
    AUD: ['aud', 'australian dollar', 'australian dollars'],
    CAD: ['cad', 'canadian dollar', 'canadian dollars'],
    CHF: ['chf', 'swiss franc', 'swiss francs', 'franc', 'francs'],
    SGD: ['sgd', 'singapore dollar', 'singapore dollars'],
    AED: ['aed', 'dirham', 'dirhams'],
    KRW: ['krw', 'won'],
    RUB: ['rub', 'ruble', 'rubles', 'rouble', 'roubles'],
    BRL: ['brl', 'real', 'reais'],
    MXN: ['mxn', 'peso', 'pesos'],
    HKD: ['hkd'], NZD: ['nzd'], SEK: ['sek', 'krona'], NOK: ['nok', 'krone'], DKK: ['dkk'],
    PLN: ['pln', 'zloty'], THB: ['thb', 'baht'], IDR: ['idr', 'rupiah'], MYR: ['myr', 'ringgit'],
    PHP: ['php'], ZAR: ['zar', 'rand'], TRY: ['try', 'lira'], ILS: ['ils', 'shekel', 'shekels'],
    CZK: ['czk'], HUF: ['huf', 'forint'], RON: ['ron'], ISK: ['isk'], BGN: ['bgn'],
};
const CURRENCY_SYMBOLS = {'$': 'USD', '€': 'EUR', '₹': 'INR', '£': 'GBP', '¥': 'JPY', '₩': 'KRW', '₽': 'RUB', '฿': 'THB', '₺': 'TRY', '₪': 'ILS', 'r$': 'BRL', 'a$': 'AUD', 'c$': 'CAD', 's$': 'SGD'};
const CURRENCY_SIGN = {USD: '$', EUR: '€', INR: '₹', GBP: '£', JPY: '¥', KRW: '₩', RUB: '₽', THB: '฿', TRY: '₺', ILS: '₪'};

// alias -> {cat, sym, f}; exact-case map first (MB vs Mb), then lower-case
const exact = new Map();
const lower = new Map();
function addAlias(alias, rec) {
    if (!exact.has(alias))
        exact.set(alias, rec);
    const l = alias.toLowerCase();
    if (!lower.has(l))
        lower.set(l, rec);
}
for (const [cat, rows] of Object.entries(TABLE)) {
    for (const [sym, f, ...aliases] of rows) {
        const rec = {cat, sym, f};
        addAlias(sym, rec);
        for (const a of aliases)
            addAlias(a, rec);
    }
}
for (const [sym, ...aliases] of TEMPS) {
    const rec = {cat: 'temperature', sym};
    addAlias(sym, rec);
    for (const a of aliases)
        addAlias(a, rec);
}
for (const [code, aliases] of Object.entries(CURRENCY_NAMES)) {
    const rec = {cat: 'currency', sym: code};
    // currency codes win over unit look-alikes only in lower-case lookups ("try" stays a word otherwise)
    for (const a of [code, ...aliases]) {
        if (a === 'try' || a === 'php' || a === 'real')
            continue; // too ambiguous as plain words; codes still work upper-case
        lower.set(a.toLowerCase(), lower.get(a.toLowerCase()) ?? rec);
    }
    exact.set(code, rec);
}

function lookup(name) {
    if (!name)
        return null;
    const n = name.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
    return exact.get(n) ?? lower.get(n.toLowerCase()) ?? lower.get(n.toLowerCase().replace(/s$/, '')) ?? null;
}

function toKelvin(v, sym) {
    if (sym === '°C')
        return v + 273.15;
    if (sym === '°F')
        return (v - 32) * 5 / 9 + 273.15;
    return v;
}
function fromKelvin(k, sym) {
    if (sym === '°C')
        return k - 273.15;
    if (sym === '°F')
        return (k - 273.15) * 9 / 5 + 32;
    return k;
}

function fmt(v, unitSym, cat) {
    if (cat === 'currency') {
        const sign = CURRENCY_SIGN[unitSym];
        const n = Math.abs(v) >= 1 ? Number(v.toFixed(2)) : Number(v.toPrecision(4));
        const s = formatNumber(n);
        return sign ? `${sign}${s}` : `${s} ${unitSym}`;
    }
    const n = Math.abs(v) >= 1e-3 && Math.abs(v) < 1e15 ? Number(v.toPrecision(7)) : v;
    const s = formatNumber(n);
    const glue = unitSym.startsWith('°') || unitSym === '"' ? '' : ' ';
    return `${s}${glue}${unitSym}`;
}

const NUM = /^([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?)\s*/i;

// Split "100 km to mi" into {value, from, to}. Handles currency symbols and feet/inches.
export function parse(text) {
    let s = String(text ?? '').trim();
    if (!s || s.length > 80)
        return null;

    // 5'11" / 5 ft 11 in
    let m = /^(\d+(?:\.\d+)?)\s*(?:'|′|ft|feet|foot)\s*(\d+(?:\.\d+)?)\s*(?:"|″|in|inch|inches)?\s*(?:(?:to|in|as|into|=|->|→)\s*(.+))?$/i.exec(s);
    if (m && m[2]) {
        const inches = Number(m[1]) * 12 + Number(m[2]);
        return {value: inches, from: lookup('in'), to: lookup(m[3]) ?? null, toName: m[3] ?? null, label: `${m[1]}′${m[2]}″`};
    }

    // leading currency symbol: "$20", "₹ 500", "A$10"
    m = /^(r\$|a\$|c\$|s\$|[$€₹£¥₩₽฿₺₪])\s*(.*)$/i.exec(s);
    let sym = null;
    if (m) {
        sym = CURRENCY_SYMBOLS[m[1].toLowerCase()];
        s = m[2];
    }

    m = NUM.exec(s);
    if (!m || !m[1] || !/\d/.test(m[1]))
        return null;
    const value = Number(m[1].replace(/,/g, ''));
    let rest = s.slice(m[0].length).trim();

    // trailing currency symbol "20$", "50 €"
    if (!sym) {
        const t = /^(r\$|a\$|c\$|s\$|[$€₹£¥₩₽฿₺₪])(.*)$/i.exec(rest);
        if (t) {
            sym = CURRENCY_SYMBOLS[t[1].toLowerCase()];
            rest = t[2].trim();
        }
    }

    let fromName, toName = null;
    const sep = /\s+(?:to|in|as|into)\s+|\s*(?:=|->|→)\s*/i;
    if (sym) {
        fromName = sym;
        const t = rest.replace(/^(?:to|in|as|into|=|->|→)\s*/i, '');
        toName = t || null;
        if (rest && !/^(?:to|in|as|into|=|->|→)/i.test(rest))
            return null;
    } else {
        const parts = rest.split(sep);
        fromName = parts[0];
        toName = parts.length > 1 ? parts.slice(1).join(' ') : null;
        if (!fromName)
            return null;
    }
    const from = sym ? {cat: 'currency', sym} : lookup(fromName);
    if (!from)
        return null;
    let to = toName ? lookup(toName) : null;
    if (toName && !to)
        return null;
    return {value, from, to, toName};
}

// rates: {base:'EUR', rates:{USD:1.08,...}} or null. home: preferred currencies.
export function convert(text, {rates = null, home = ['USD', 'EUR', 'GBP']} = {}) {
    const p = parse(text);
    if (!p)
        return null;
    const {value, from} = p;
    let {to} = p;
    const cat = from.cat;
    if (to && to.cat !== cat) {
        // "1 ton to lb": "t" collides nowhere, but "min" vs "mi"... a mismatch means no answer
        return null;
    }
    const input = p.label ?? fmt(value, from.sym, cat);

    if (cat === 'currency') {
        if (!rates)
            return {category: 'currency', input, pendingRates: true, results: []};
        const r = c => (c === rates.base ? 1 : rates.rates[c]);
        if (!r(from.sym))
            return null;
        const targets = to ? [to.sym] : home.filter(c => c !== from.sym);
        const results = [];
        for (const t of targets) {
            if (!r(t))
                continue;
            const v = value / r(from.sym) * r(t);
            results.push({value: v, unit: t, display: fmt(v, t, cat)});
        }
        return results.length ? {category: cat, input, results, ratesDate: rates.date} : null;
    }

    let targets;
    if (to) {
        targets = [to.sym];
    } else {
        const c = COMMON[cat];
        const list = (IMPERIAL.has(from.sym) ? c.imperial : null) ?? c.metric;
        targets = list.filter(t => t !== from.sym).slice(0, 4);
    }
    const results = [];
    for (const t of targets) {
        let v;
        if (cat === 'temperature') {
            v = fromKelvin(toKelvin(value, from.sym), t);
        } else {
            const rec = lookup(t);
            v = value * from.f / rec.f;
        }
        results.push({value: v, unit: t, display: fmt(v, t, cat)});
    }
    if (!results.length)
        return null;
    // a bare "5 m" or "2 s" without a target is too ambiguous to steal the top hit; callers
    // check `explicit` to decide prominence
    return {category: cat, input, results, explicit: Boolean(to)};
}

export const currencyCodes = Object.keys(CURRENCY_NAMES);
