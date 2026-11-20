// SPDX-License-Identifier: GPL-3.0-or-later
// Inline calculator (pure JS). evaluate(text) -> {value, expr, display, hex?, bin?} | null
//
// Grammar (Pratt): numbers 1,234.5 1e3 0x1f 0b101 0o17 · + - * × · / ÷ ^ ** mod · n% · n! ·
// parens · implicit multiplication ("2pi", "3(4+1)", "2 sqrt 9") · functions with or without
// parens ("sqrt 16") · constants pi π e tau phi. Like macOS, trig takes degrees ("sin 30" = 0.5;
// append "rad" for radians), "15% of 80" = 12 and "80 + 15%" = 92.
//
// Only answers when the input is clearly a calculation (an operator, function or constant), so
// typing "42" or "e" never hijacks the top hit.

const FUNCS = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
    round: Math.round, exp: Math.exp, ln: Math.log, log: Math.log10, log10: Math.log10,
    log2: Math.log2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    sin: 'trig', cos: 'trig', tan: 'trig', asin: 'atrig', acos: 'atrig', atan: 'atrig',
    fact: n => factorial(n),
};
const CONSTS = {pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI, 'τ': 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, 'φ': (1 + Math.sqrt(5)) / 2};
const DEG = Math.PI / 180;

function factorial(n) {
    if (n < 0 || !Number.isInteger(n) || n > 170)
        throw new Error('factorial');
    let r = 1;
    for (let i = 2; i <= n; i++)
        r *= i;
    return r;
}

function tokenize(s) {
    const t = [];
    let i = 0;
    const src = s.replace(/[×✕]/g, '*').replace(/[÷]/g, '/').replace(/[−–]/g, '-');
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        let m;
        const rest = src.slice(i);
        if ((m = /^0x[0-9a-f]+|^0b[01]+|^0o[0-7]+/i.exec(rest))) {
            t.push({k: 'num', v: Number(m[0].toLowerCase().replace(/^0o/, '0o')), raw: m[0], base: m[0][1].toLowerCase()});
            i += m[0].length;
        } else if ((m = /^(\d{1,3}(,\d{3})+|\d+)(\.\d*)?(e[+-]?\d+)?|^\.\d+(e[+-]?\d+)?/i.exec(rest))) {
            t.push({k: 'num', v: Number(m[0].replace(/,/g, ''))});
            i += m[0].length;
        } else if ((m = /^\*\*/.exec(rest))) {
            t.push({k: 'op', v: '^'});
            i += 2;
        } else if ('+-*/^%!(),'.includes(c)) {
            t.push({k: c === '(' || c === ')' || c === ',' ? c : 'op', v: c});
            i++;
        } else if ((m = /^[a-zπτφ][a-z0-9]*/i.exec(rest))) {
            t.push({k: 'id', v: m[0].toLowerCase()});
            i += m[0].length;
        } else {
            throw new Error(`bad char ${c}`);
        }
    }
    return t;
}

class Parser {
    constructor(tokens) {
        this.t = tokens;
        this.i = 0;
        this.signals = 0; // how "calculator-like" the input is
        this.base = null;
    }

    peek(o = 0) {
        return this.t[this.i + o];
    }

    next() {
        return this.t[this.i++];
    }

    expect(k) {
        const x = this.next();
        if (!x || x.k !== k)
            throw new Error(`expected ${k}`);
        return x;
    }

    startsOperand(tok) {
        return tok && (tok.k === 'num' || tok.k === '(' || (tok.k === 'id' && tok.v !== 'of' && tok.v !== 'mod' && tok.v !== 'rad'));
    }

    // binding powers
    infix(tok) {
        if (!tok)
            return null;
        if (tok.k === 'op') {
            switch (tok.v) {
            case '+': case '-': return [10, 11];
            case '*': case '/': return [20, 21];
            case '^': return [41, 40]; // right-assoc
            default: return null;
            }
        }
        if (tok.k === 'id' && tok.v === 'mod')
            return [20, 21];
        if (tok.k === 'id' && tok.v === 'of')
            return [25, 26];
        if (this.startsOperand(tok))
            return [30, 31]; // implicit multiplication, binds tighter than * /
        return null;
    }

    parse(rbp = 0) {
        let left = this.prefix();
        for (;;) {
            const tok = this.peek();
            // postfix: % and !
            if (tok && tok.k === 'op' && (tok.v === '%' || tok.v === '!')) {
                this.next();
                this.signals++;
                if (tok.v === '!') {
                    left = {v: factorial(left.v)};
                } else {
                    // "a + b%" means a + a*b/100 (handled in the + case via pct flag)
                    left = {v: left.v / 100, pct: true};
                }
                continue;
            }
            const bp = this.infix(tok);
            if (!bp || bp[0] < rbp)
                break;
            const implicit = !(tok.k === 'op' || (tok.k === 'id' && (tok.v === 'mod' || tok.v === 'of')));
            if (!implicit)
                this.next();
            const right = this.parse(bp[1]);
            if (implicit) {
                this.signals++;
                left = {v: left.v * right.v};
                continue;
            }
            this.signals++;
            const op = tok.k === 'id' ? tok.v : tok.v;
            switch (op) {
            case '+': left = {v: right.pct ? left.v * (1 + right.v) : left.v + right.v}; break;
            case '-': left = {v: right.pct ? left.v * (1 - right.v) : left.v - right.v}; break;
            case '*': left = {v: left.v * right.v}; break;
            case '/': left = {v: left.v / right.v}; break;
            case '^': left = {v: Math.pow(left.v, right.v)}; break;
            case 'mod': left = {v: ((left.v % right.v) + right.v) % right.v}; break;
            case 'of': left = {v: left.v * right.v}; break; // "15% of 80"
            }
        }
        return left;
    }

    prefix() {
        const tok = this.next();
        if (!tok)
            throw new Error('eof');
        if (tok.k === 'num') {
            if (tok.base)
                this.base = tok.base;
            return {v: tok.v};
        }
        if (tok.k === 'op' && (tok.v === '-' || tok.v === '+')) {
            const r = this.parse(35);
            return {v: tok.v === '-' ? -r.v : r.v};
        }
        if (tok.k === '(') {
            const r = this.parse(0);
            this.expect(')');
            this.signals++;
            return {v: r.v};
        }
        if (tok.k === 'id') {
            if (tok.v in CONSTS) {
                this.signals++;
                return {v: CONSTS[tok.v]};
            }
            const fn = FUNCS[tok.v];
            if (fn) {
                this.signals += 2;
                const args = [];
                if (this.peek()?.k === '(') {
                    this.next();
                    if (this.peek()?.k !== ')') {
                        args.push(this.parse(0).v);
                        while (this.peek()?.k === ',') {
                            this.next();
                            args.push(this.parse(0).v);
                        }
                    }
                    this.expect(')');
                } else {
                    args.push(this.parse(35).v); // "sqrt 16", "sin 30"
                }
                let rad = false;
                if (this.peek()?.k === 'id' && this.peek().v === 'rad') {
                    this.next();
                    rad = true;
                }
                if (fn === 'trig')
                    return {v: Math[tok.v](rad ? args[0] : args[0] * DEG)};
                if (fn === 'atrig')
                    return {v: Math[tok.v](args[0]) / (rad ? 1 : DEG)};
                return {v: fn(...args)};
            }
            if (tok.v === 'max' || tok.v === 'min') {
                this.expect('(');
                const args = [this.parse(0).v];
                while (this.peek()?.k === ',') {
                    this.next();
                    args.push(this.parse(0).v);
                }
                this.expect(')');
                this.signals += 2;
                return {v: Math[tok.v](...args)};
            }
        }
        throw new Error(`unexpected ${tok.v}`);
    }
}

// 1234567.891 -> "1,234,567.891"; tiny/huge -> exponent form; at most 12 significant digits.
export function formatNumber(v) {
    if (!Number.isFinite(v))
        return Number.isNaN(v) ? 'Not a number' : (v > 0 ? '∞' : '-∞');
    if (Object.is(v, -0))
        v = 0;
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e15 || a < 1e-9))
        return v.toExponential(8).replace(/\.?0+e/, 'e').replace('e+', 'e');
    let s = Number(v.toPrecision(12)).toString();
    if (s.includes('e'))
        return s;
    const [int, frac] = s.split('.');
    const sign = int.startsWith('-') ? '-' : '';
    const digits = int.replace('-', '');
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + grouped + (frac ? `.${frac}` : '');
}

export function evaluate(text) {
    let s = String(text ?? '').trim();
    if (!s || s.length > 200)
        return null;
    let forced = false;
    if (s.startsWith('=')) {
        forced = true;
        s = s.slice(1).trim();
    }
    s = s.replace(/=\s*$/, '').trim();
    if (!s)
        return null;
    let p;
    let r;
    try {
        p = new Parser(tokenize(s));
        r = p.parse(0);
        if (p.i !== p.t.length)
            return null;
    } catch {
        return null;
    }
    const lone = p.t.length === 1 && p.t[0].k === 'num';
    if (!forced && p.signals === 0 && !(lone && p.base))
        return null;
    if (!forced && lone && !p.base)
        return null;
    // a bare constant: only "pi"/"π" answers ("e" or "tau" alone are more likely the start of a word)
    if (!forced && p.t.length === 1 && p.t[0].k === 'id' && !['pi', 'π'].includes(p.t[0].v))
        return null;
    if (r.pct && p.t.length === 2) // "15%" alone
        r = {v: r.v};
    const v = r.v;
    if (typeof v !== 'number' || Number.isNaN(v))
        return null;
    const out = {value: v, expr: s, display: formatNumber(v)};
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) {
        if (p.base || /\b(hex|bin)\b/.test(s)) {
            out.hex = `0x${v.toString(16).toUpperCase()}`;
            out.bin = `0b${v.toString(2)}`;
        }
    }
    return out;
}
