// SPDX-License-Identifier: GPL-3.0-or-later
// Assertions for the tests run by tools/test.js. Each throws with a readable message.

export function equal(actual, expected, what = '') {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${what ? `${what}: ` : ''}expected ${e}, got ${a}`);
}

export function close(actual, expected, what = '', tolerance = 1e-6) {
    if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance)
        throw new Error(`${what ? `${what}: ` : ''}expected about ${expected}, got ${actual}`);
}

export function ok(value, what = 'expected a truthy value') {
    if (!value)
        throw new Error(what);
}
