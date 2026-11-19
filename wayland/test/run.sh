#!/bin/bash
# The helper's test, then the app side's, in a headless GNOME Wayland session (GNOME's own shell,
# portal, PipeWire and media-keys service). Needs python3-gi with GTK 3, and node.
# usage: run.sh <helper binary> <out dir>     (runs itself again inside dbus-run-session)
set -u
HELPER=$(realpath "$1"); OUT=$(realpath -m "$2"); HERE=$(dirname "$(realpath "$0")")
if [ -z "${INSIDE:-}" ]; then
  mkdir -p "$OUT"
  export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/xdg-run}; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
  export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland XDG_SESSION_DESKTOP=gnome
  INSIDE=1 exec dbus-run-session -- bash "$0" "$HELPER" "$OUT"
fi
pipewire > "$OUT/pipewire.log" 2>&1 &
sleep 1
wireplumber > "$OUT/wireplumber.log" 2>&1 &
gnome-shell --headless --wayland --virtual-monitor 1280x800 --unsafe-mode > "$OUT/shell.log" 2>&1 &
for _ in $(seq 1 80); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.5; done
export WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland
sleep 4
# DUNEBOT_WL_ONLY=app: the app's side alone (quicker, while working on it). CI runs both.
HELPER_TEST=0
if [ "${DUNEBOT_WL_ONLY:-}" != app ]; then
  DUNEBOT_WL_DEBUG=1 python3 -I "$HERE/drive.py" "$HELPER" "$OUT"
  HELPER_TEST=$?
fi
# The app's side (electron/wayland.mjs, input.mjs, gnome-keys.mjs) on the same desktop, with GNOME's
# media-keys service up so the shortcuts it adds can be pressed for real.
/usr/libexec/gsd-media-keys > "$OUT/gsd.log" 2>&1 &
sleep 3
node "$HERE/app_side.mjs" "$HELPER" "$OUT"
APP_TEST=$?
exit $(( HELPER_TEST || APP_TEST ))
