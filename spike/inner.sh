#!/bin/bash
set -x
pipewire > out/pipewire.log 2>&1 &
sleep 1
wireplumber > out/wireplumber.log 2>&1 &
gnome-shell --headless --wayland --virtual-monitor 1280x800 --unsafe-mode > out/shell.log 2>&1 &
for i in $(seq 1 80); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.5; done
export WAYLAND_DISPLAY=wayland-0
sleep 4
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$PWD/out/$1.png" > /dev/null 2>&1 || echo "screenshot $1 failed"; }
shell_eval() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
# The CI's own hand (inside the shell, test only): a click at a point of the 1280x800 monitor.
shell_click() { shell_eval "const C = imports.gi.Clutter; const G = imports.gi.GLib; global._ciPointer ??= C.get_default_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); const d = global._ciPointer; const t = G.get_monotonic_time(); d.notify_absolute_motion(t, $1, $2); d.notify_button(t + 30000, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); d.notify_button(t + 60000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); 'clicked $1,$2'"; }
windows() { shell_eval "global.get_window_actors().map(a => a.meta_window.get_title() + ' [' + a.meta_window.get_wm_class() + '] ' + JSON.stringify(a.meta_window.get_frame_rect())).join(' | ')"; }
until_marker() { for i in $(seq 1 60); do grep -q "$1" out/portal.log 2>/dev/null && return 0; sleep 0.5; done; echo "no $1"; return 1; }
shell_eval "Main.overview.hide(); Main.messageTray._bannerBin?.hide?.(); 'ok'"
shot start

# 1. The remote-control portal: the box once (accepted here), then a second session with the
#    remembered answer, then the screenshot portal without a picker.
python3 spike/portal.py > out/portal.log 2>&1 &
PP=$!
until_marker BOX1 && { sleep 3; shot box1; windows; shell_click 886 322; sleep 1; shot box1-switch; shell_click 922 189; sleep 2; shot box1-after; }
until_marker BOX2 && { sleep 3; shot box2; windows; }
until_marker SHOT && { sleep 3; shot screenshot-portal; windows; }
wait $PP; echo "portal exit $?"
cat out/portal.log

# 2. Electron's own screenshot (desktopCapturer) under Wayland: a picker each time?
timeout 80 /tmp/el/node_modules/electron/dist/electron --ozone-platform=wayland --no-sandbox spike/shot.cjs > out/electron-shot.log 2>&1 &
EP=$!
sleep 10; shot electron-capture-1; windows
sleep 27; shot electron-capture-2; windows
wait $EP; echo "electron exit $?"
cat out/electron-shot.log
tail -20 out/shell.log
