// SPDX-License-Identifier: GPL-3.0-or-later
// Parse every file given on the command line as an ES module: gjs tools/syntax.js a.js b.js
// Exits 1 and names the file and line when one does not parse.
const {GLib} = imports.gi;

let bad = 0;
for (const path of ARGV) {
    const [, bytes] = GLib.file_get_contents(path);
    try {
        Reflect.parse(new TextDecoder().decode(bytes), {target: 'module'});
    } catch (e) {
        bad++;
        printerr(`${path}:${e.lineNumber}: ${e.message}`);
    }
}
if (bad)
    imports.system.exit(1);
print(`syntax ok: ${ARGV.length} modules`);
