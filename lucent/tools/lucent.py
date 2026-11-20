#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build, check, pack and install the Lucent extensions.

    tools/lucent.py list                 the extensions in this repository
    tools/lucent.py build   [name ...]   extensions/<name> -> build/<uuid>
    tools/lucent.py check                every rule a release has to pass
    tools/lucent.py pack    [name ...]   build/<uuid> -> dist/<uuid>.shell-extension.zip
    tools/lucent.py install [name ...]   copy the build into ~/.local/share/gnome-shell/extensions
    tools/lucent.py uninstall [name ...]

Add --dev to include the development-only extensions under dev/ (never packed).
Only the Python standard library, gjs and glib-compile-schemas are needed.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / 'build'
DIST = ROOT / 'dist'
TOKENS = ROOT / 'design' / 'tokens.json'
LIVE = Path.home() / '.local/share/gnome-shell/extensions'
VARIANTS = ('dark', 'light')

# What may appear in a release zip.
ALLOWED_SUFFIXES = {'.js', '.json', '.css', '.xml', '.svg', '.png', '.mo'}
ALLOWED_NAMES = {'LICENSE'}
# Source files that never go into a build.
SOURCE_ONLY = {'README.md', 'build.json'}


class Problem(Exception):
    pass


# ---------------------------------------------------------------- tokens

def load_tokens():
    return json.loads(TOKENS.read_text())


def lookup(tokens, path):
    node = tokens
    for part in path.split('.'):
        if not isinstance(node, dict) or part not in node:
            raise Problem(f'unknown token "{path}"')
        node = node[part]
    return node


def number(tokens, text):
    """A literal number, or the name of a numeric token such as material.popover."""
    try:
        return float(text)
    except ValueError:
        value = lookup(tokens, text)
        if not isinstance(value, (int, float)):
            raise Problem(f'token "{text}" is not a number')
        return float(value)


def fmt(x):
    return f'{x:.3f}'.rstrip('0').rstrip('.')


def render(text, tokens, variant):
    """Replace every @{...} in text. Colours come from the given variant."""
    colours = tokens['color'][variant]

    def colour(name):
        if name not in colours:
            raise Problem(f'unknown colour "{name}" ({variant})')
        return colours[name]

    def one(match):
        expr = match.group(1).strip()
        if expr.startswith('rgba:'):
            name, _, alpha = expr[5:].partition(',')
            r, g, b = colour(name.strip())
            return f'rgba({r}, {g}, {b}, {fmt(number(tokens, alpha.strip()))})'
        if expr.startswith('rgb:'):
            r, g, b = colour(expr[4:].strip())
            return f'rgb({r}, {g}, {b})'
        value = lookup(tokens, expr)
        if isinstance(value, str):
            return render(value, tokens, variant)
        if isinstance(value, (int, float)):
            return fmt(value)
        raise Problem(f'token "{expr}" cannot be written into a stylesheet')

    return re.sub(r'@\{([^}]+)\}', one, text)


SIDES = re.compile(r'/\* @sides \*/\n(.*?)/\* @end \*/\n', re.S)


def render_sides(text, tokens):
    """Write each "/* @sides */ ... /* @end */" block twice, once per colour side, with "@side"
    in its selectors replaced by "dark" and "light". Everything outside the blocks appears once."""
    def both(match):
        return ''.join(
            f'/* ---- {side} side ---- */\n' + render(match.group(1).replace('@side', side), tokens, side)
            for side in VARIANTS)
    return render(SIDES.sub(both, text), tokens, 'dark')


def tokens_js(tokens):
    def obj(d):
        return json.dumps(d, indent=4)
    parts = [
        '// SPDX-License-Identifier: GPL-3.0-or-later',
        '// Generated from design/tokens.json by tools/lucent.py. Do not edit.',
        '',
    ]
    for key in ('radius', 'space', 'type', 'motion', 'material'):
        parts.append(f'export const {key} = {obj(tokens[key])};\n')
    parts.append(f'export const color = {obj(tokens["color"])};\n')
    parts.append('''/**
 * A token colour as a CSS string.
 *
 * @param {number[]} rgb - a colour from `color.dark` or `color.light`
 * @param {number} [alpha] - opacity, 0 to 1
 * @returns {string}
 */
export function css(rgb, alpha = 1) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
''')
    return '\n'.join(parts)


def luminance(rgb):
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_report(tokens):
    """Yield (ok, text) for every pair listed under "contrast".

    An entry is either one material over a backdrop ("bg" + "opacity"), or a stack ("layers": a list
    of [colour, opacity] laid over the backdrop in order, each opacity a number or a material name).
    "fg" is a colour name, or [colour, opacity] for text drawn at an opacity over the result."""
    def alpha(value):
        return number(tokens, f'material.{value}') if isinstance(value, str) else float(value)

    def over(top, a, bottom):
        return [a * t + (1 - a) * b for t, b in zip(top, bottom)]

    for pair in tokens.get('contrast', []):
        colours = tokens['color'][pair['variant']]
        bg = list(pair['backdrop'])
        layers = pair.get('layers') or [[pair['bg'], pair['opacity']]]
        for name, a in layers:
            bg = over(colours[name], alpha(a), bg)
        fg_name, fg_alpha = pair['fg'] if isinstance(pair['fg'], list) else (pair['fg'], 1)
        fg = over(colours[fg_name], alpha(fg_alpha), bg)
        hi, lo = sorted((luminance(fg), luminance(bg)), reverse=True)
        ratio = (hi + 0.05) / (lo + 0.05)
        yield ratio >= pair['min'], f'{pair["name"]} ({pair["variant"]}): {ratio:.2f}:1, needs {pair["min"]}:1'


# ------------------------------------------------------------ extensions

class Ext:
    def __init__(self, src, dev):
        self.src = src
        self.name = src.name
        self.dev = dev
        self.meta = json.loads((src / 'metadata.json').read_text())
        self.uuid = self.meta['uuid']
        self.out = BUILD / self.uuid
        opts = src / 'build.json'
        self.opts = json.loads(opts.read_text()) if opts.exists() else {}


def find(names, dev):
    exts = [Ext(p.parent, False) for p in sorted((ROOT / 'extensions').glob('*/metadata.json'))]
    if dev:
        exts += [Ext(p.parent, True) for p in sorted((ROOT / 'dev').glob('*/metadata.json'))]
    if names:
        known = {e.name: e for e in exts}
        missing = [n for n in names if n not in known]
        if missing:
            raise Problem(f'no such extension: {", ".join(missing)}')
        exts = [known[n] for n in names]
    return exts


def build(ext, tokens):
    if ext.out.exists():
        shutil.rmtree(ext.out)
    for path in sorted(ext.src.rglob('*')):
        rel = path.relative_to(ext.src)
        if path.is_dir() or rel.name in SOURCE_ONLY or rel.name.endswith('.in.css') or rel.parts[0] == 'tests':
            continue
        dest = ext.out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
    for template in sorted(ext.src.rglob('*.in.css')):
        rel = template.relative_to(ext.src)
        stem = rel.name[:-len('.in.css')]
        text = template.read_text()
        header = f'/* Generated from {rel} and design/tokens.json. Do not edit. */\n'
        if SIDES.search(text):
            # The extension picks dark or light per surface while it runs: one file holds both.
            (ext.out / rel.parent / f'{stem}.css').write_text(header + render_sides(text, tokens))
            continue
        for variant in VARIANTS:
            (ext.out / rel.parent / f'{stem}-{variant}.css').write_text(header + render(text, tokens, variant))
    if ext.opts.get('tokens'):
        (ext.out / 'tokens.js').write_text(tokens_js(tokens))
    for shared in ext.opts.get('shared', []):
        shutil.copy2(ROOT / 'shared' / shared, ext.out / shared)
    shutil.copy2(ROOT / 'LICENSE', ext.out / 'LICENSE')
    schemas = ext.out / 'schemas'
    if schemas.is_dir():
        run(['glib-compile-schemas', '--strict', str(schemas)])


def pack(ext):
    DIST.mkdir(exist_ok=True)
    target = DIST / f'{ext.uuid}.shell-extension.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        for path in sorted(ext.out.rglob('*')):
            # GNOME Shell 44 and later compile the schema themselves on install.
            if path.is_file() and path.name != 'gschemas.compiled':
                z.write(path, path.relative_to(ext.out))
    return target


def run(cmd, **kw):
    done = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if done.returncode != 0:
        raise Problem(f'{" ".join(cmd)}\n{done.stdout}{done.stderr}'.strip())
    return done.stdout


# ----------------------------------------------------------------- check

def strip_comments(js):
    """Blank out comments and string contents so the rules below see code only."""
    out, i, n = [], 0, len(js)
    while i < n:
        two = js[i:i + 2]
        if two == '//':
            j = js.find('\n', i)
            j = n if j < 0 else j
            i = j
        elif two == '/*':
            j = js.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append('\n' * js.count('\n', i, j))
            i = j
        elif js[i] in '\'"`':
            quote, j = js[i], i + 1
            while j < n and js[j] != quote:
                j += 2 if js[j] == '\\' else 1
            body = js[i + 1:j]
            # keep import specifiers readable, hide everything else
            keep = body if re.fullmatch(r'(gi://|resource://|\./|\.\./)[\w./:@-]*', body) else re.sub(r'[^\n]', ' ', body)
            out.append(quote + keep + quote)
            i = j + 1
        else:
            out.append(js[i])
            i += 1
    return ''.join(out)


SHELL_ONLY = re.compile(r"gi://(Clutter|Meta|St|Shell|Cogl)\b|resource:///org/gnome/shell/ui/")
PREFS_ONLY = re.compile(r"gi://(Gtk|Gdk|Adw)\b")
RULES = [
    (re.compile(r'\bimports\.(gi|misc|ui|lang|mainloop|byteArray|gettext)\b'), 'legacy imports object; use ES modules'),
    (re.compile(r'(?<![\w.])log\('), 'log(); use console.debug/warn/error'),
    (re.compile(r'\bconsole\.log\('), 'console.log(); use console.debug/warn/error'),
    (re.compile(r'\bspawn_sync\(|\bspawn_command_line_sync\('), 'blocks the shell while a process runs; use Gio.Subprocess'),
    (re.compile(r'\beval\(|new Function\('), 'evaluates code from a string'),
]
TIMER = re.compile(r'GLib\.(timeout_add|timeout_add_seconds|idle_add)\(')
TOP_LEVEL_NEW = re.compile(r'^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+(?!Map\b|Set\b|WeakMap\b|WeakSet\b|RegExp\b|TextEncoder\b|TextDecoder\b|Intl\.)')
RAW_COLOUR = re.compile(r'#[0-9a-fA-F]{3,8}\b|\brgba?\(')


def is_prefs(rel):
    return rel.name == 'prefs.js' or 'prefs' in rel.parts


def check_ext(ext, errors, warnings):
    def err(where, text):
        errors.append(f'{ext.name}/{where}: {text}')

    meta = ext.meta
    for key in ('uuid', 'name', 'description', 'shell-version', 'url', 'version-name'):
        if key not in meta:
            err('metadata.json', f'missing "{key}"')
    if not re.fullmatch(r'[A-Za-z0-9._-]+@[A-Za-z0-9._-]+', ext.uuid) or ext.uuid.endswith('@gnome.org'):
        err('metadata.json', f'bad uuid "{ext.uuid}"')
    versions = meta.get('shell-version', [])
    if not versions or not all(isinstance(v, str) and v.isdigit() for v in versions):
        err('metadata.json', '"shell-version" must be a list of major versions as strings')
    if 'unlock-dialog' in meta.get('session-modes', []) and not ext.dev:
        warnings.append(f'{ext.name}/metadata.json: runs on the lock screen; reviewers ask for a reason in disable()')

    schema_id = meta.get('settings-schema')
    xmls = sorted((ext.src / 'schemas').glob('*.gschema.xml')) if (ext.src / 'schemas').is_dir() else []
    if schema_id and not xmls:
        err('metadata.json', f'"settings-schema" is set but schemas/ has no .gschema.xml')
    for xml in xmls:
        text = xml.read_text()
        ids = re.findall(r'<schema\s+id="([^"]+)"\s+path="([^"]+)"', text)
        if not ids:
            err(f'schemas/{xml.name}', 'no <schema id=... path=...>')
        for sid, path in ids:
            if not sid.startswith('org.gnome.shell.extensions.') or not path.startswith('/org/gnome/shell/extensions/'):
                err(f'schemas/{xml.name}', 'schema id and path must sit under org.gnome.shell.extensions')
        if schema_id and schema_id not in [sid for sid, _ in ids]:
            err(f'schemas/{xml.name}', f'does not define "{schema_id}" named in metadata.json')
        if xml.name != f'{ids[0][0]}.gschema.xml' if ids else False:
            err(f'schemas/{xml.name}', 'file must be named after its schema id')
    if xmls:
        try:
            run(['glib-compile-schemas', '--strict', '--dry-run', str(ext.src / 'schemas')])
        except Problem as e:
            err('schemas', str(e))

    for path in sorted(ext.src.rglob('*.js')):
        rel = path.relative_to(ext.src)
        if rel.parts[0] == 'tests':
            continue
        code = strip_comments(path.read_text())
        if not path.read_text().lstrip().startswith('// SPDX-License-Identifier:'):
            err(rel, 'first line must be the SPDX licence identifier')
        if is_prefs(rel):
            if SHELL_ONLY.search(code):
                err(rel, 'preferences run outside the shell and must not import Clutter, Meta, St, Shell or shell UI modules')
        elif PREFS_ONLY.search(code):
            err(rel, 'shell code must not import Gtk, Gdk or Adw')
        for n, line in enumerate(code.split('\n'), 1):
            for pattern, why in RULES:
                if pattern.search(line) and not ext.dev:
                    err(f'{rel}:{n}', why)
            if not ext.dev and TIMER.search(line) and not re.search(r'(=|return|\.push\(|\.add\(|=>)\s*GLib\.', line):
                err(f'{rel}:{n}', 'the id of this main-loop source is dropped, so disable() cannot remove it')
            if not is_prefs(rel) and TOP_LEVEL_NEW.match(line):
                warnings.append(f'{ext.name}/{rel}:{n}: object created when the module loads; only enable() may create objects')

    for template in sorted(ext.src.rglob('*.in.css')):
        rel = template.relative_to(ext.src)
        body = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), template.read_text(), flags=re.S)
        for n, line in enumerate(body.split('\n'), 1):
            if RAW_COLOUR.search(re.sub(r'@\{[^}]*\}', '', line)):
                err(f'{rel}:{n}', 'colour written by hand; take it from design/tokens.json')
            if 'background-position: center' in line:
                err(f'{rel}:{n}', 'St has no "center" keyword for background-position (unset is centred)')
    for css in sorted(ext.src.rglob('*.css')):
        if not css.name.endswith('.in.css'):
            err(css.relative_to(ext.src), 'stylesheets are generated; write a .in.css template')

    if ext.out.is_dir():
        for path in sorted(ext.out.rglob('*')):
            if path.is_file() and path.suffix not in ALLOWED_SUFFIXES and path.name not in ALLOWED_NAMES \
                    and path.name != 'gschemas.compiled':
                err(path.relative_to(ext.out), 'this kind of file may not ship in an extension')


def check(exts, tokens):
    errors, warnings = [], []
    for ok, text in contrast_report(tokens):
        print(f'  {"ok  " if ok else "FAIL"} contrast: {text}')
        if not ok:
            errors.append(f'design/tokens.json: {text}')
    for ext in exts:
        try:
            build(ext, tokens)
        except Problem as e:
            errors.append(f'{ext.name}: build failed: {e}')
            continue
        check_ext(ext, errors, warnings)
    files = [str(p) for e in exts for p in sorted(e.out.rglob('*.js'))]
    tests = sorted(str(p) for p in ROOT.glob('tests/*.test.js')) + \
        sorted(str(p) for e in exts for p in e.src.glob('tests/*.test.js'))
    if files:
        try:
            print('  ' + run(['gjs', str(ROOT / 'tools' / 'syntax.js'), *files]).strip())
        except Problem as e:
            errors.append(f'syntax: {e}')
    if tests:
        try:
            print('  ' + run(['gjs', '-m', str(ROOT / 'tools' / 'test.js'), *tests]).strip().replace('\n', '\n  '))
        except Problem as e:
            errors.append(f'tests: {e}')
    for w in warnings:
        print(f'  warn {w}')
    for e in errors:
        print(f'  FAIL {e}')
    print(f'{len(exts)} extensions, {len(files)} modules, {len(errors)} errors, {len(warnings)} warnings')
    return not errors


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['list', 'build', 'check', 'pack', 'install', 'uninstall'])
    ap.add_argument('names', nargs='*')
    ap.add_argument('--dev', action='store_true', help='include dev/ extensions')
    args = ap.parse_args()
    try:
        tokens = load_tokens()
        exts = find(args.names, args.dev)
        if args.command == 'list':
            for e in exts:
                print(f'{e.name:12} {e.uuid:48} {"dev" if e.dev else e.meta.get("version-name", "")}')
        elif args.command == 'build':
            for e in exts:
                build(e, tokens)
                print(f'built {e.out.relative_to(ROOT)}')
        elif args.command == 'check':
            sys.exit(0 if check(exts, tokens) else 1)
        elif args.command == 'pack':
            if not check([e for e in exts if not e.dev], tokens):
                raise Problem('not packing: the checks above failed')
            for e in exts:
                if not e.dev:
                    print(f'packed {pack(e).relative_to(ROOT)}')
        elif args.command == 'install':
            LIVE.mkdir(parents=True, exist_ok=True)
            for e in exts:
                build(e, tokens)
                dest = LIVE / e.uuid
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(e.out, dest)
                print(f'installed {e.uuid}')
            print('Log out and back in, then enable them in the Extensions app (or: gnome-extensions enable <uuid>).')
        elif args.command == 'uninstall':
            for e in exts:
                dest = LIVE / e.uuid
                if dest.exists():
                    shutil.rmtree(dest)
                    print(f'removed {e.uuid}')
    except Problem as e:
        print(f'error: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
