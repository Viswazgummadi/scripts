// SPDX-License-Identifier: GPL-3.0-or-later
// The launcher's pure logic: matching, the calculator, conversions and query parsing.
import {close, equal, ok} from '../../../tools/assert.js';
import * as fuzzy from '../core/fuzzy.js';
import * as calc from '../core/calc.js';
import * as units from '../core/units.js';
import * as query from '../core/query.js';

const score = (q, text) => fuzzy.score(fuzzy.fold(q), fuzzy.prepare(text));
const value = text => calc.evaluate(text)?.value;
const first = (text, options) => units.convert(text, options)?.results[0];

export const tests = {
    // ---- matching ----
    'an exact match scores 1000'() {
        equal(score('firefox', 'Firefox'), 1000);
    },
    'no match scores 0'() {
        equal(score('zzz', 'Firefox'), 0);
    },
    'match tiers are ordered: exact, prefix, word starts, initials, substring, subsequence'() {
        const tiers = [
            score('firefox', 'Firefox'),
            score('fire', 'Firefox'),
            score('stu co', 'Visual Studio Code'),
            score('vsc', 'Visual Studio Code'),
            score('refo', 'Firefox'),
            score('ffx', 'Firefox'),
        ];
        for (let i = 1; i < tiers.length; i++)
            ok(tiers[i - 1] > tiers[i] && tiers[i] > 0, `tier ${i} out of order: ${tiers}`);
    },
    'a shorter text wins inside a tier'() {
        ok(score('fil', 'Files') > score('fil', 'Files and Folders'));
    },
    'accents do not matter'() {
        equal(fuzzy.fold('Café ÀÉ'), 'cafe ae');
        ok(score('cafe', 'Café Latte') > 800);
    },
    'words split on separators, case changes and digits'() {
        equal(fuzzy.words('LibreOffice-Writer_Draft2'), ['libre', 'office', 'writer', 'draft', '2']);
    },
    'the ghost completion is the rest of the text'() {
        equal(fuzzy.completion('fire', 'Firefox'), 'fox');
        equal(fuzzy.completion('fox', 'Firefox'), '');
    },
    'best takes the highest weighted field'() {
        const top = fuzzy.best('fire', [[fuzzy.prepare('Mozilla'), 1], [fuzzy.prepare('Firefox'), 0.5]]);
        close(top, score('fire', 'Firefox') * 0.5, 'weighted', 1e-9);
    },

    // ---- calculator ----
    'arithmetic and precedence'() {
        equal(value('12*7+3'), 87);
        equal(value('2^10'), 1024);
        equal(value('3(4+1)'), 15);
        equal(value('10 mod 3'), 1);
        equal(value('5!'), 120);
    },
    'functions, constants and implicit multiplication'() {
        equal(value('sqrt 16'), 4);
        close(value('2pi'), 2 * Math.PI);
        close(value('sin 30'), 0.5, 'trig takes degrees');
    },
    'percentages read the way people write them'() {
        equal(value('15% of 80'), 12);
        equal(value('80 + 15%'), 92);
    },
    'other bases, with hex and binary shown for integers'() {
        const r = calc.evaluate('0x1f + 1');
        equal([r.value, r.hex, r.bin], [32, '0x20', '0b100000']);
    },
    'thousands separators are read and written'() {
        equal(value('1,234.5 * 2'), 2469);
        equal(calc.evaluate('2^10').display, '1,024');
        equal(calc.formatNumber(1234567.891), '1,234,567.891');
    },
    'floating point noise is not shown'() {
        equal(calc.formatNumber(0.1 + 0.2), '0.3');
        equal(calc.evaluate('sin 30').display, '0.5');
    },
    'plain words and bare numbers are not calculations'() {
        equal(calc.evaluate('42'), null);
        equal(calc.evaluate('e'), null);
        equal(calc.evaluate('hello'), null);
        equal(calc.evaluate('2 +'), null);
    },
    'division by zero shows infinity'() {
        equal(calc.evaluate('1/0').display, '∞');
    },

    // ---- conversions ----
    'length, both spellings of the target'() {
        close(first('100 km to mi').value, 62.137119, 'km to mi', 1e-5);
        equal(first('5 km in miles').display, '3.106856 mi');
        close(first('5\'11" in cm').value, 180.34, 'feet and inches', 1e-9);
    },
    'temperature without a target answers with the common units'() {
        const r = units.convert('72f');
        equal(r.category, 'temperature');
        close(r.results[0].value, 22.222222, 'celsius', 1e-5);
        equal(r.results.map(x => x.unit), ['°C', 'K']);
    },
    'binary and decimal data sizes are different'() {
        close(first('1.5 GiB to MB').value, 1610.612736);
    },
    'kitchen units'() {
        close(first('3 cups in ml').value, 709.76471, 'cups', 1e-4);
    },
    'currency uses the rate table, and says when it has none yet'() {
        const rates = {rates: {USD: 1.1, EUR: 1, INR: 90, GBP: 0.85}};
        equal(first('$20 in eur', {rates}).display, '€18.18');
        equal(units.convert('100 usd').pendingRates, true);
    },
    'text that is not a quantity is not converted'() {
        equal(units.convert('hello'), null);
    },

    // ---- query parsing ----
    'prefixes select a mode'() {
        equal(query.parse('> ls -la').prefix, '>');
        equal(query.parse('= 2+2').prefix, '=');
        equal(query.parse('? weather').prefix, '?');
        equal(query.parse('hello world').prefix, null);
    },
    'filters are taken out of the search text'() {
        const q = query.parse('notes in:Downloads ext:md');
        equal([q.text, q.inDir, q.ext], ['notes', 'Downloads', 'md']);
        const k = query.parse('kind:pdf report');
        equal([k.text, k.kind], ['report', 'pdf']);
    },
    'natural phrases become a kind and a date range'() {
        const q = query.parse('pdfs from last week');
        equal([q.text, q.kind, Boolean(q.after), Boolean(q.before)], ['', 'pdf', true, true]);
    },
    'files are classified by type or by extension'() {
        equal(query.kindOf('a.pdf', 'application/pdf'), 'pdf');
        equal(query.kindOf('x.png', null), 'image');
        equal(query.kindOf('dir', 'inode/directory'), 'folder');
        equal(query.kindOf('a.xyz', null), 'other');
    },
    'date arithmetic copies the same day it shows (local time, not UTC)'() {
        const r = query.dateMath('today + 3 days', new Date(2026, 0, 30));
        equal([r.title, r.copy], ['Monday, 2 February 2026', '2026-02-02']);
    },
    'days until a date'() {
        equal(query.dateMath('days until christmas', new Date(2026, 11, 20)).title, '5 days');
    },
    'time zones are recognised by place'() {
        ok(query.timeQuery('time in tokyo')?.zone);
        equal(query.timeQuery('hello'), null);
    },
};
