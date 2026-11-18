#!/bin/bash
# Round 5: clicks and typing through the remote-control route (libei), the hotkey on Wayland,
# then the screenshot boxes answered in time, then Electron's own capture.
set -x
pipewire > out/pipewire.log 2>&1 &
sleep 1
wireplumber > out/wireplumber.log 2>&1 &
gnome-shell --headless --wayland --virtual-monitor 1280x800 --unsafe-mode > out/shell.log 2>&1 &
for i in $(seq 1 80); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.5; done
export WAYLAND_DISPLAY=wayland-0
sleep 4
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false "$PWD/out/$1.png" > /dev/null 2>&1 || echo "shot $1 failed"; }
J='const C = imports.gi.Clutter; const G = imports.gi.GLib;'
ev "$J const s = C.get_default_backend().get_default_seat(); global._ciP = s.create_virtual_device(C.InputDeviceType.POINTER_DEVICE); global._ciK = s.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); 'hand made'"; sleep 1
move() { ev "$J global._ciP.notify_absolute_motion(G.get_monotonic_time(), $1, $2); 'moved'"; sleep 0.3; }
click() { move $1 $2; ev "$J const t = G.get_monotonic_time(); global._ciP.notify_button(t, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); global._ciP.notify_button(t + 50000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); 'clicked $1,$2'"; sleep 0.5; }
keys() { ev "$J const k = global._ciK; let t = G.get_monotonic_time(); const ks = [$1].map(n => C['KEY_' + n]); for (const v of ks) k.notify_keyval(t += 20000, v, C.KeyState.PRESSED); for (const v of ks.reverse()) k.notify_keyval(t += 20000, v, C.KeyState.RELEASED); 'keys $1'"; sleep 0.5; }
windows() { ev "global.get_window_actors().map(a => { const w = a.meta_window, r = w.get_frame_rect(); return w.get_title() + ' [' + w.get_wm_class() + '] ' + [r.x, r.y, r.width, r.height].join(','); }).join(' | ')"; }
frame_of() { ev "(() => { const a = global.get_window_actors().find(a => a.meta_window.get_title() === '$1'); if (!a) return 'none'; const r = a.meta_window.get_frame_rect(); return [r.x, r.y, r.width, r.height].join(' '); })()" | grep -oE "[0-9]+ [0-9]+ [0-9]+ [0-9]+"; }
until_marker() { for i in $(seq 1 80); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.5; done; echo "no $2 in $1"; return 1; }
perms() { gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore --object-path /org/freedesktop/impl/portal/PermissionStore --method org.freedesktop.impl.portal.PermissionStore.Lookup "$1" "$2" 2>&1 | cut -c1-300; }
EL=/tmp/el/node_modules/electron/dist/electron
ev "Main.overview.hide(); 'ok'"
python3 spike/portal.py versions

echo "=== 1. remote control: the box once (accepted by the test's hand)"
python3 spike/portal.py rd out/token > out/rd1.log 2>&1 &
P=$!
until_marker out/rd1.log BOX && { sleep 3; click 886 322; click 922 189; }
wait $P; cat out/rd1.log

echo "=== 2. a window; click and type into it through libei"
STAY=60 $EL --ozone-platform=wayland --no-sandbox spike/target.cjs > out/target.log 2>&1 &
TP=$!
until_marker out/target.log READY; sleep 2
read FX FY FW FH <<< "$(frame_of target)"; echo "target frame $FX $FY $FW $FH"
{ echo "click $((FX + 100)) $((FY + 150))"; echo "wait 0.5"; echo "click $((FX + 300)) $((FY + 250))"; echo "wait 0.5";
  echo "type aA b"; echo "wait 0.5"; echo "type ö"; echo "wait 0.5"; echo "click 1100 700"; echo "wait 0.5"; } > out/steps.txt
cat out/steps.txt
python3 spike/portal.py rd out/token out/steps.txt > out/rd2.log 2>&1; cat out/rd2.log
ev "'pointer after libei ' + global.get_pointer().slice(0, 2).join(',')"
shot after-libei

echo "=== 3. Dune Bot's hotkey, pressed by the test's hand, with the target in front"
click $((FX + 50)) $((FY + 100))
keys "'Control_L', 'Alt_L', 'space'"; sleep 1
keys "'Alt_L', 'Shift_L', 'space'"; sleep 1
wait $TP; echo "--- target (wayland, portal keys off):"; grep -vE "drm_render|shared_x_display" out/target.log
STAY=14 $EL --ozone-platform=wayland --no-sandbox spike/target.cjs --portal-keys > out/target-portal.log 2>&1 &
TP=$!
until_marker out/target-portal.log READY; sleep 3; shot portal-keys-box; windows
keys "'Control_L', 'Alt_L', 'space'"; sleep 1
wait $TP; echo "--- target (wayland, portal keys on):"; grep -vE "drm_render|shared_x_display" out/target-portal.log
XD=$(ev "imports.gi.GLib.getenv('DISPLAY')" | grep -oE ":[0-9]+"); echo "Xwayland display: $XD"
if [ -n "$XD" ]; then
  DISPLAY=$XD STAY=14 $EL --ozone-platform=x11 --no-sandbox spike/target.cjs > out/target-x11.log 2>&1 &
  TP=$!
  until_marker out/target-x11.log READY; sleep 2
  STAY=10 $EL --ozone-platform=wayland --no-sandbox spike/target.cjs > /dev/null 2>&1 &
  sleep 4; windows
  keys "'Control_L', 'Alt_L', 'space'"; sleep 1
  wait $TP; echo "--- target (x11 via Xwayland, a Wayland window in front):"; grep -vE "drm_render|shared_x_display" out/target-x11.log
fi
echo "--- the desktop's own custom shortcut, running a command"
/usr/libexec/gsd-media-keys > out/gsd.log 2>&1 &
B=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/
gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "['$B']"
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$B name 'Dune Bot stop'
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$B command 'touch /tmp/stop-fired'
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$B binding '<Control><Alt>period'
sleep 3; keys "'Control_L', 'Alt_L', 'period'"; sleep 2
ls -la /tmp/stop-fired 2>&1; tail -5 out/gsd.log

echo "=== 4. screenshot portal: the box answered in time, then twice more"
python3 spike/portal.py shot > out/s1.log 2>&1 &
P=$!
until_marker out/s1.log BOX && { sleep 2; shot s1-box; click 762 497; }
wait $P; cat out/s1.log
echo "--- store: $(perms screenshot screenshot)"
for n in 2 3; do python3 spike/portal.py shot > out/s$n.log 2>&1 & P=$!; until_marker out/s$n.log BOX && { sleep 0.6; shot s$n-0.6s; }; wait $P; cat out/s$n.log; done
ls -la ~/Pictures ~/Pictures/Screenshots 2>&1 | tail -6
keys "'Escape'"

echo "=== 5. Electron's own capture: pick the screen once, then again"
timeout 120 $EL --ozone-platform=wayland --no-sandbox spike/probe.cjs > out/electron.log 2>&1 &
EP=$!
until_marker out/electron.log CAPTURE1 && { sleep 4; shot cap1-box; click 640 430; shot cap1-picked; click 922 189; sleep 2; shot cap1-after; }
until_marker out/electron.log CAPTURE2 && { sleep 4; shot cap2-4s; windows; keys "'Escape'"; }
wait $EP; grep -E "capture|CAPTURE" out/electron.log
