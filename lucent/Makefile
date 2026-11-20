# SPDX-License-Identifier: GPL-3.0-or-later
# Lucent: every command lives in tools/lucent.py; these are the short names.
.PHONY: help list build check pack install uninstall install-dev clean

help:
	@echo "make check        build everything and run every release check"
	@echo "make pack         check, then write dist/<uuid>.shell-extension.zip"
	@echo "make install      build and copy all extensions into your account"
	@echo "make install EXT=launcher   only one"
	@echo "make uninstall    remove them again"
	@echo "make install-dev  also install the development probe"
	@echo "make list | build | clean"

list:
	@tools/lucent.py list --dev
build:
	@tools/lucent.py build $(EXT)
check:
	@tools/lucent.py check
pack:
	@tools/lucent.py pack $(EXT)
install:
	@tools/lucent.py install $(EXT)
uninstall:
	@tools/lucent.py uninstall --dev $(EXT)
install-dev:
	@tools/lucent.py install --dev $(EXT)
clean:
	rm -rf build dist
