#!/bin/sh
# Installs Evoked for the current user. No root needed.
#
#   curl -fsSL https://dabane-ghassan.github.io/evoked/install.sh | sh
#
# Works on any distro with the GNOME desktop: it only uses sh, curl and tar.
#   sh install.sh             install from this folder instead (a checkout or an unpacked release)
#   sh install.sh --remove    uninstall
set -eu

UUID="evoked@dabane-ghassan.github.io"
APP="io.github.dabane_ghassan.Evoked"
RELEASE="https://github.com/dabane-ghassan/evoked/releases/latest/download/evoked.tar.gz"
SOURCE="https://github.com/dabane-ghassan/evoked/archive/refs/heads/main.tar.gz"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT="$DATA/gnome-shell/extensions/$UUID"
BIN="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }

if [ "${1:-}" = "--remove" ]; then
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    rm -rf "$EXT" "$BIN/evoked" "$DATA/applications/$APP.desktop" \
        "$DATA/icons/hicolor/scalable/apps/$APP.svg"
    say "Evoked removed. Your settings are kept; log out and back in to finish."
    exit 0
fi

command -v gnome-shell >/dev/null 2>&1 || { say "Evoked needs the GNOME desktop (GNOME Shell 45 or later)."; exit 1; }
command -v gjs >/dev/null 2>&1 || say "Note: 'gjs' was not found. The overlays will work, but the Evoked window needs it."
command -v gst-launch-1.0 >/dev/null 2>&1 || say "Note: 'gst-launch-1.0' was not found. The room neuron needs it to hear the microphone (package: gstreamer1 on Fedora, gstreamer1.0-tools on Debian and Ubuntu)."

# Find the files: next to this script, or download the latest release.
SRC=""
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$HERE" ] && [ -f "$HERE/extension/metadata.json" ]; then
    SRC="$HERE"
else
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    say "Downloading Evoked..."
    fetch() {
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "$1" -o "$2" 2>/dev/null
        else
            wget -q "$1" -O "$2"
        fi
    }
    # the latest release, or the current source when there is no release yet
    if fetch "$RELEASE" "$TMP/evoked.tar.gz"; then
        tar -xzf "$TMP/evoked.tar.gz" -C "$TMP"
    elif fetch "$SOURCE" "$TMP/source.tar.gz"; then
        tar -xzf "$TMP/source.tar.gz" -C "$TMP"
        mv "$TMP/evoked-main" "$TMP/evoked"
    else
        say "Could not download Evoked. Check your connection and try again."
        exit 1
    fi
    SRC="$TMP/evoked"
fi

WAS=""
[ -f "$EXT/metadata.json" ] && WAS="$(sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' "$EXT/metadata.json")"
NOW="$(sed -n 's/.*"version-name": *"\(.*\)".*/\1/p' "$SRC/extension/metadata.json")"
mkdir -p "$EXT" "$BIN" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps"
rm -rf "$EXT"
mkdir -p "$EXT"
cp -R "$SRC/extension/." "$EXT/"
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$EXT/schemas"
fi
install -m 755 "$SRC/bin/evoked" "$BIN/evoked"
sed "s|^Exec=evoked|Exec=$BIN/evoked|" "$SRC/packaging/$APP.desktop" > "$DATA/applications/$APP.desktop"
cp "$SRC/extension/assets/evoked.svg" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
gtk-update-icon-cache -q "$DATA/icons/hicolor" >/dev/null 2>&1 || true

gnome-extensions enable "$UUID" >/dev/null 2>&1 || true

say ""
if [ -n "$WAS" ] && [ "$WAS" != "$NOW" ]; then
    say "Evoked updated from $WAS to $NOW."
elif [ -n "$WAS" ]; then
    say "Evoked $NOW reinstalled."
else
    say "Evoked $NOW is installed."
fi
if gdbus call --session --dest org.gnome.Shell --object-path /io/github/dabane_ghassan/Evoked \
        --method io.github.dabane_ghassan.Evoked.GetState >/dev/null 2>&1; then
    say "Log out and back in to load the new version."
else
    say "Log out and back in once so GNOME loads it."
fi
say "Then open Evoked from your apps, or click the neuron in the top bar."
case ":$PATH:" in
    *":$BIN:"*) ;;
    *) say "(The 'evoked' command is in $BIN, which is not on your PATH yet.)" ;;
esac
