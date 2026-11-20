#!/bin/bash
# The Wayland tests on Fedora 43 (GNOME 49) in a container: the image (fedora.Dockerfile), the
# helper built there, then run.sh as a plain user.
# usage: fedora.sh <folder with a Linux Electron> <out dir>
# DUNEBOT_WL_MONITORS / DUNEBOT_WL_SCALES as run.sh; DUNEBOT_WL_ONLY=app for the app's side alone.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
ELECTRON_DIR=$(cd "$1" && pwd)
mkdir -p "$2"
OUT=$(cd "$2" && pwd)
docker build -q -t dunebot-wl-fedora -f "$HERE/fedora.Dockerfile" "$HERE" > /dev/null
docker run --rm \
  -v "$ROOT/wayland":/home/dev/src:ro -v "$ROOT/electron":/home/dev/electron:ro -v "$ELECTRON_DIR":/opt/electron:ro -v "$OUT":/out \
  -e DUNEBOT_WL_MONITORS="${DUNEBOT_WL_MONITORS:-}" -e DUNEBOT_WL_SCALES="${DUNEBOT_WL_SCALES:-}" -e DUNEBOT_WL_ONLY="${DUNEBOT_WL_ONLY:-}" \
  dunebot-wl-fedora bash -c '
    set -e
    cp -r /home/dev/src /tmp/w
    (cd /tmp/w && CARGO_TARGET_DIR=/tmp/target cargo build --release --quiet)
    install -m 755 /tmp/target/release/dunebot-wayland /usr/local/bin/dunebot-wayland
    chown dev /out
    rm -rf /run/systemd/seats; mkdir -p /run/dbus && dbus-daemon --system --fork --nopidfile
    exec runuser -u dev -- env HOME=/home/dev PATH=/usr/bin:/bin \
      DUNEBOT_WL_MONITORS="$DUNEBOT_WL_MONITORS" DUNEBOT_WL_SCALES="$DUNEBOT_WL_SCALES" DUNEBOT_WL_ONLY="$DUNEBOT_WL_ONLY" \
      DUNEBOT_TEST_ELECTRON=/opt/electron/electron bash /home/dev/src/test/run.sh /usr/local/bin/dunebot-wayland /out'
