# Working on Lucent

## Layout

```
design/tokens.json        every colour, radius, duration (docs/DESIGN.md)
extensions/<name>/        one extension: metadata.json, extension.js, prefs.js, schemas/, stylesheet.in.css, tests/
dev/probe/                development-only extension, never packed
tools/lucent.py           list, build, check, pack, install, uninstall
tools/probe               send commands to the probe
build/, dist/             generated
```

## The loop

GNOME Shell on Wayland cannot be restarted without logging out, and it caches every module it has
imported. The probe works around both: it runs a private copy of a build inside the running shell.

```sh
make install-dev EXT=probe       # once; then log out and in, and enable Lucent Probe
make build EXT=corner
tools/probe '{"op":"trial","name":"corner","dir":"'$PWD'/build/lucent-corner@viswazgummadi.github.io"}'
tools/probe '{"op":"cycle","name":"corner","n":6}'      # disable and enable six times; reports leaked actors
tools/probe '{"op":"shot","name":"a.png"}'              # lands in ~/.cache/lucent-probe/
tools/probe '{"op":"untrial","name":"corner"}'
```

Disable the installed copy of an extension before running a trial of it. The full command list is at
the top of `dev/probe/src/main.js`: show a shell surface, move and click the pointer, read the
colours St resolved for a style class, open a preferences window, try a stylesheet.
Switch the probe off when you are not developing: it lets anything running as you drive the shell.

## Rules (`make check` enforces the mechanical ones)

- ES modules only. No `imports.*`, `Lang`, `Mainloop`, `ByteArray`.
- Shell code never imports Gtk, Gdk or Adw. `prefs.js` never imports Clutter, Meta, St, Shell or shell UI modules.
- Nothing is created, connected or scheduled when a module loads or in a constructor; only in `enable()`.
- `disable()` undoes everything: actors destroyed, signals disconnected, every main-loop source removed
  (so its id must be kept), settings given back. A screen lock calls `disable()` and `enable()`.
- No blocking process calls (`spawn_sync`). `console.debug/warn/error`, not `log()` or `console.log()`.
- No colour in a stylesheet template; take it from the tokens. Stylesheets are generated, never committed.
- Every source file starts with its SPDX licence line.
- Loading a stylesheet that is already loaded leaves a broken copy in the shell theme. Let the shell
  load `stylesheet.css`; do not call `load_stylesheet()` yourself.

## Before a change is done

1. `make check` passes.
2. A trial runs with a clean journal: `journalctl --user -b | grep -iE 'js error|lucent'`.
3. `cycle` reports `"leaked": 0`.
4. It was looked at, in dark and in light, and the screenshot matches the tokens.
5. New logic has a test under `extensions/<name>/tests/` (plain `gjs`, see `tools/test.js`).
