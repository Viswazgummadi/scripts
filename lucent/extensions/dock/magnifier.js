// SPDX-License-Identifier: GPL-3.0-or-later
// The magnification curve, kept free of any shell library so it can be tested on its own.

/**
 * How much each icon grows, and how far it moves along the dock so that no two overlap.
 *
 * Icons are laid out along one axis with their centres at `centers` and sizes `sizes` (the same
 * unit as `pointer`). An icon at distance d from the pointer is scaled by
 *     1 + (magnification - 1) * cos²(π/2 · d / range)   for d < range, else 1,
 * where range = reach × the size of a typical icon. The extra length the scaled icons need is
 * shared out so the row grows by the same amount on both sides, as it does on macOS.
 *
 * @param {number[]} centers - icon centres along the dock, in order
 * @param {number[]} sizes - icon lengths along the dock
 * @param {number|null} pointer - pointer position along the dock, or null when it is away
 * @param {number} magnification - largest scale, 1 = none
 * @param {number} reach - spread to each side, in icons
 * @returns {{scale: number, shift: number}[]}
 */
export function layout(centers, sizes, pointer, magnification, reach) {
    const n = centers.length;
    if (!n || pointer === null || magnification <= 1)
        return centers.map(() => ({scale: 1, shift: 0}));
    const typical = sizes.reduce((a, b) => a + b, 0) / n;
    const range = Math.max(1, reach * typical);
    const scales = centers.map(c => {
        const d = Math.abs(c - pointer);
        if (d >= range)
            return 1;
        const k = Math.cos((Math.PI / 2) * (d / range));
        return 1 + (magnification - 1) * k * k;
    });
    const extra = scales.map((s, i) => (s - 1) * sizes[i]);
    const total = extra.reduce((a, b) => a + b, 0);
    const out = [];
    let before = 0;
    for (let i = 0; i < n; i++) {
        out.push({scale: scales[i], shift: before + extra[i] / 2 - total / 2});
        before += extra[i];
    }
    return out;
}
