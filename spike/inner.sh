#!/bin/bash
# Round 6: the hotkey on GNOME 46 Wayland (fixed test), the desktop's own shortcut, and screen +
# control in ONE remembered box (per-app, not the shared screenshot "yes"), with a frame read back.
set -x
pipewire > out/pipewire.log 2>&1 &
sleep 1
wireplumber > out/wireplumber.log 2>&1 &
B=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/
gnome-shell --headless --wayland --virtual-monitor 1280x800 --unsafe-mode > out/shell.log 2>&1 &
for i in $(seq 1 80); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.5; done
export WAYLAND_DISPLAY=wayland-0
sleep 4
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false "$PWD/out/$1.png" > /dev/null 2>&1 || echo "shot $1 failed"; }
J='const C = imports.gi.Clutter; const G = imports.gi.GLib;'
ev "$J const s = C.get_default_backend().get_default_seat(); global._ciP = s.create_virtual_device(C.InputDeviceType.POINTER_DEVICE); global._ciK = s.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); 'hand made'"; sleep 1
move() { ev "$J global._ciP.notify_absolute_motion(G.get_monotonic_time(), $1, $2); 'moved'"; sleep 0.3; }
click() { move $1 $2; ev "$J const t = G.get_monotonic_time(); global._ciP.notify_button(t, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); global._ciP.notify_button(t + 80000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); 'clicked'"; sleep 0.6; }
keys() { ev "$J const k = global._ciK; let t = G.get_monotonic_time(); const ks = '$*'.split(' ').map(n => C['KEY_' + n]); for (const v of ks) k.notify_keyval(t += 20000, v, C.KeyState.PRESSED); for (const v of ks.reverse()) k.notify_keyval(t += 20000, v, C.KeyState.RELEASED); 'keys $*'"; sleep 0.5; }
windows() { ev "global.get_window_actors().map(a => { const w = a.meta_window, r = w.get_frame_rect(); return w.get_title() + ' [' + w.get_wm_class() + '] ' + [r.x, r.y, r.width, r.height].join(',') + (w.has_focus() ? ' focused' : ''); }).join(' | ')"; }
until_marker() { for i in $(seq 1 80); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.5; done; echo "no $2 in $1"; return 1; }
EL=/tmp/el/node_modules/electron/dist/electron
ev "Main.overview.hide(); 'ok'"

echo "=== 1. Dune Bot's hotkey under Wayland: its own window in front, then another app in front"
STAY=30 $EL --ozone-platform=wayland --no-sandbox spike/target.cjs --portal-keys > out/t-wl.log 2>&1 &
TP=$!
until_marker out/t-wl.log READY; sleep 2; windows
keys Control_L Alt_L space; sleep 1
keys Alt_L Shift_L space; sleep 1
STAY=12 $EL --ozone-platform=wayland --no-sandbox spike/target.cjs > /dev/null 2>&1 &
sleep 5; windows
keys Control_L Alt_L space; sleep 1
wait $TP; grep -vE "drm_render|shared_x_display" out/t-wl.log

echo "=== 2. the same through Xwayland (X11 build of the app), another app in front"
XD=$(ev "imports.gi.GLib.getenv('DISPLAY')" | grep -oE ":[0-9]+"); XA=$(ev "imports.gi.GLib.getenv('XAUTHORITY')" | grep -oE "/[^'\"]+"); echo "DISPLAY=$XD XAUTHORITY=$XA"
DISPLAY=$XD XAUTHORITY=$XA STAY=24 $EL --ozone-platform=x11 --no-sandbox spike/target.cjs > out/t-x11.log 2>&1 &
TP=$!
until_marker out/t-x11.log READY; sleep 2; windows
keys Control_L Alt_L space; sleep 1
STAY=10 $EL --ozone-platform=wayland --no-sandbox spike/target.cjs > /dev/null 2>&1 &
sleep 5; windows
keys Control_L Alt_L space; sleep 1
wait $TP; grep -vE "drm_render|shared_x_display" out/t-x11.log

echo "=== 3. a shortcut in GNOME's own keyboard settings that runs a command"
gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "['$B']"
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$B name 'Dune Bot stop'
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$B command 'touch /tmp/stop-fired'
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$B binding '<Super><Alt>d'
/usr/libexec/gsd-media-keys > out/gsd.log 2>&1 &
sleep 6
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.GrabAccelerator '<Super><Alt>j' 0 0
keys Super_L Alt_L d; sleep 2
ls -la /tmp/stop-fired 2>&1; grep -i "custom0\|grab" out/gsd.log | head -5

echo "=== 4. screen + control in one box, remembered, a frame read back"
WITH_SCREEN=1 python3 spike/portal.py rd out/token-sc > out/sc1.log 2>&1 &
P=$!
if until_marker out/sc1.log BOX; then
  sleep 3; shot sc-box; windows
  click 640 430; shot sc-tile-click
  ev "'(after tile click)'"
  click 886 322 2>/dev/null; shot sc-after-guess
fi
sleep 2; shot sc-before-share
click 922 189; sleep 3; shot sc-after-share
wait $P; cat out/sc1.log
echo "--- again from a fresh process with the saved token"
WITH_SCREEN=1 python3 spike/portal.py rd out/token-sc > out/sc2.log 2>&1 &
P=$!
until_marker out/sc2.log BOX && { sleep 3; shot sc2-3s; windows; }
wait $P; cat out/sc2.log
ls -la out/frame-* 2>&1
