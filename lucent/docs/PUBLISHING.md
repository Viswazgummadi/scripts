# Publishing

Two ways to get Lucent to other people. The first needs nothing but a GitHub account.

## 1. GitHub

```sh
make pack                        # runs every check, writes dist/*.shell-extension.zip
git tag v0.1.0 && git push origin main v0.1.0
```

Create a release for the tag and attach the zips from `dist/`. People then either clone and run
`./install.sh`, or download a zip and run `gnome-extensions install <zip>`.
`.github/workflows/check.yml` runs `make check` on every push (it has not run yet: it needs the
repository to exist on GitHub).

## 2. extensions.gnome.org

Each extension is uploaded separately at <https://extensions.gnome.org/upload/> as its zip from
`dist/`, and a person reviews it. What the review looks at, and where Lucent stands:

| Rule | Status |
|---|---|
| Nothing created or connected outside `enable()`; `disable()` cleans up completely | checked by hand and by the probe's `cycle` (0 leaked actors each) |
| No deprecated modules; Gtk only in `prefs.js`; no shell libraries in `prefs.js` | enforced by `make check` |
| No binaries, no minified code, no compiled schema in the zip | enforced by `make check` and the packer |
| Schema id and path under `org.gnome.shell.extensions` | enforced by `make check` |
| `metadata.json` has uuid, name, description, shell-version, url | enforced by `make check` |
| Clipboard access is declared in the description | done for the launcher |
| Network use is declared | done for the launcher |
| Changing another component's settings | the launcher borrows Super+Space from "switch input source" and gives it back in `disable()`; a reviewer may still ask for it to be opt-in |
| Patching shell internals | Dissolve shadows one method of one `Set` instance and removes it in `disable()`; explained at the top of its `extension.js` |
| Licence compatible with GPL-2.0-or-later | GPL-3.0-or-later |

Two things to know before submitting:

- **You must be able to explain the code.** The review guidelines reject submissions that look
  machine-generated or that the author cannot justify. Read each extension through before uploading
  it, start with the two small ones (Corner, Dissolve), and answer the reviewer's questions yourself.
  Expect questions about the launcher: it is large, runs commands and uses the network.
- **`shell-version` must only list versions you have tested.** Today that is 51.

The url in every `metadata.json` points at `github.com/Viswazgummadi/lucent`; change it there and in
`README.md` if the repository gets another name.

## Version numbers

`version-name` in `metadata.json` is what people see (`0.1.0`). extensions.gnome.org assigns its own
integer `version` on upload; do not add one by hand.
