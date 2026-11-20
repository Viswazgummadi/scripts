// SPDX-License-Identifier: GPL-3.0-or-later
import {close, equal, ok} from '../../../tools/assert.js';
import {layout} from '../magnifier.js';

const centers = [34, 106, 178, 250, 322];
const sizes = [68, 68, 68, 68, 68];

export const tests = {
    'nothing changes when the pointer is away or magnification is 1'() {
        equal(layout(centers, sizes, null, 1.6, 2.5).map(r => r.scale), [1, 1, 1, 1, 1]);
        equal(layout(centers, sizes, 178, 1, 2.5).map(r => r.shift), [0, 0, 0, 0, 0]);
    },
    'the icon under the pointer gets the full magnification'() {
        close(layout(centers, sizes, 178, 1.6, 2.5)[2].scale, 1.6);
    },
    'scale falls off with distance and is symmetric'() {
        const r = layout(centers, sizes, 178, 1.6, 2.5);
        ok(r[2].scale > r[1].scale && r[1].scale > r[0].scale && r[0].scale >= 1);
        close(r[1].scale, r[3].scale);
        close(r[0].scale, r[4].scale);
    },
    'icons beyond the reach keep their size'() {
        const r = layout(centers, sizes, 34, 1.6, 1);
        equal(r.slice(2).map(x => x.scale), [1, 1, 1]);
    },
    'the row grows equally on both sides, and grown icons never overlap'() {
        for (const pointer of [34, 100, 178, 300]) {
            const r = layout(centers, sizes, pointer, 2, 2.5);
            const edges = r.map((x, i) => {
                const c = centers[i] + x.shift, half = sizes[i] * x.scale / 2;
                return [c - half, c + half];
            });
            for (let i = 1; i < edges.length; i++)
                ok(edges[i][0] >= edges[i - 1][1] - 1e-6, `overlap at ${i} with pointer ${pointer}`);
            const grow = r.reduce((a, x, i) => a + (x.scale - 1) * sizes[i], 0);
            close(edges[0][0], centers[0] - sizes[0] / 2 - grow / 2, 'left edge');
            close(edges.at(-1)[1], centers.at(-1) + sizes.at(-1) / 2 + grow / 2, 'right edge');
        }
    },
    'an empty dock gives an empty answer'() {
        equal(layout([], [], 10, 1.6, 2.5), []);
    },
};
