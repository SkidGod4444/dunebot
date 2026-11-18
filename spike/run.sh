#!/bin/bash
# A headless GNOME Wayland session on the runner, then the checks inside it.
mkdir -p out
export XDG_RUNTIME_DIR=/tmp/xdg-run; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland XDG_SESSION_DESKTOP=gnome
dpkg -l | grep -E " (gnome-shell|mutter|xdg-desktop-portal|xdg-desktop-portal-gnome|pipewire) " | awk '{print $2, $3}' | tee out/versions.txt
gnome-shell --help > out/shell-help.txt 2>&1
dbus-run-session -- bash spike/inner.sh 2>&1 | tee out/inner.log
