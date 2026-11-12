UUID    := evoked@dabane-ghassan.github.io
VERSION := $(shell sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' extension/metadata.json)
DIST    := dist

.PHONY: all assets site install uninstall dist test clean

all: assets

# Regenerate the logo and the website's shared files.
assets:
	python3 tools/make_brand.py
	$(MAKE) site

# The join page uses the same protocol file as the app; keep the website's copies fresh.
site:
	cp extension/lib/mqtt-core.js docs/j/mqtt-core.js
	cp install.sh docs/install.sh
	touch docs/.nojekyll

install:
	sh install.sh

uninstall:
	sh install.sh --remove

# evoked.tar.gz: everything install.sh needs (what the curl installer downloads).
# evoked.shell-extension.zip: just the shell part, for `gnome-extensions install`.
dist:
	rm -rf $(DIST) && mkdir -p $(DIST)/evoked
	cp -R extension bin packaging install.sh LICENSE README.md $(DIST)/evoked/
	rm -f $(DIST)/evoked/extension/schemas/gschemas.compiled
	tar -C $(DIST) -czf $(DIST)/evoked.tar.gz evoked
	glib-compile-schemas $(DIST)/evoked/extension/schemas
	cd $(DIST)/evoked/extension && zip -qr ../../evoked.shell-extension.zip .
	rm -rf $(DIST)/evoked

# End-to-end tests in a headless GNOME Shell (see tests/README.md).
test:
	python3 tests/run.py

clean:
	rm -rf $(DIST) extension/schemas/gschemas.compiled
