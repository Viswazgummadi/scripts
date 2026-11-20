#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Install or remove the Lucent extensions for the current user. No root needed.
#
#   ./install.sh                  build and install all of them
#   ./install.sh launcher glass   only these
#   ./install.sh --remove         remove them again (settings are kept)
set -euo pipefail
cd "$(dirname "$0")"

for tool in python3 gjs glib-compile-schemas gnome-shell; do
    command -v "$tool" >/dev/null || { echo "install.sh: '$tool' is needed and was not found" >&2; exit 1; }
done

if [ "${1:-}" = "--remove" ]; then
    shift
    tools/lucent.py uninstall "$@"
    echo "Removed. Log out and back in to unload them from the running session."
    exit 0
fi

version="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
supported="$(python3 -c "
import json, glob
print(' '.join(sorted({v for f in glob.glob('extensions/*/metadata.json') for v in json.load(open(f))['shell-version']})))")"
case " $supported " in
    *" $version "*) ;;
    *) echo "install.sh: this is GNOME Shell $version; Lucent is tested on: $supported." >&2
       echo "GNOME Shell will refuse to load an extension that does not list its version." >&2
       exit 1 ;;
esac

tools/lucent.py check "$@" >/dev/null || { echo "install.sh: the build did not pass its checks; run 'make check' to see why" >&2; exit 1; }
tools/lucent.py install "$@"
