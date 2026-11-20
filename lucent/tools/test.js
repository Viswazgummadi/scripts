// SPDX-License-Identifier: GPL-3.0-or-later
// A very small test runner: gjs -m tools/test.js path/to/a.test.js ...
// A test file exports `tests`, an object of name -> function (may be async). A test fails by throwing;
// tools/assert.js has the assertions.
import GLib from 'gi://GLib';
import System from 'system';

let passed = 0;
const failures = [];
for (const path of ARGV) {
    const file = GLib.path_get_basename(path);
    let tests;
    try {
        ({tests} = await import(`file://${GLib.canonicalize_filename(path, null)}`));
    } catch (e) {
        failures.push(`${file}: cannot load: ${e.message}`);
        continue;
    }
    for (const [name, fn] of Object.entries(tests ?? {})) {
        try {
            await fn();
            passed++;
        } catch (e) {
            failures.push(`${file}: ${name}: ${e.message}`);
        }
    }
}
for (const f of failures)
    printerr(f);
print(`tests: ${passed} passed, ${failures.length} failed`);
if (failures.length)
    System.exit(1);
