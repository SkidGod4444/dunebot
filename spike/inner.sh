#!/bin/bash
# Round 4. The CI's own hand (shell-internal, harness only) is proven first; then each box is
# accepted once and asked again, and the restore token is used from a fresh process.
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
hand_init() { ev "$J const s = C.get_default_backend().get_default_seat(); global._ciP = s.create_virtual_device(C.InputDeviceType.POINTER_DEVICE); global._ciK = s.create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); 'hand made'"; sleep 1; }
move() { ev "$J global._ciP.notify_absolute_motion(G.get_monotonic_time(), $1, $2); 'moved'"; sleep 0.3; ev "'pointer ' + global.get_pointer().slice(0, 2).join(',')"; }
click() { move $1 $2; ev "$J const t = G.get_monotonic_time(); global._ciP.notify_button(t, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); global._ciP.notify_button(t + 50000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); 'clicked $1,$2'"; sleep 0.5; }
key() { ev "$J const t = G.get_monotonic_time(); global._ciK.notify_keyval(t, C.KEY_$1, C.KeyState.PRESSED); global._ciK.notify_keyval(t + 30000, C.KEY_$1, C.KeyState.RELEASED); 'key $1'"; sleep 0.4; }
windows() { ev "global.get_window_actors().map(a => { const w = a.meta_window, r = w.get_frame_rect(); return w.get_title() + ' [' + w.get_wm_class() + '] ' + [r.x, r.y, r.width, r.height].join(','); }).join(' | ')"; }
until_marker() { for i in $(seq 1 80); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.5; done; echo "no $2 in $1"; return 1; }
perms() { gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore --object-path /org/freedesktop/impl/portal/PermissionStore --method org.freedesktop.impl.portal.PermissionStore.Lookup "$1" "$2" 2>&1 | cut -c1-300; }
ev "Main.overview.hide(); 'ok'"

echo "=== 0. the hand itself"
hand_init
move 100 100
move 640 400
shot hand-cursor

echo "=== 1. remote control: the box, accepted"
python3 spike/portal.py rd out/token > out/rd1.log 2>&1 &
P=$!
until_marker out/rd1.log BOX && { sleep 3; shot rd-box; windows; click 886 322; shot rd-switched; click 922 189; sleep 2; shot rd-after; }
wait $P; cat out/rd1.log
if ! grep -q "Start -> {'code': 0" out/rd1.log; then
  echo "--- the mouse hand didn't accept it; keyboard"
  python3 spike/portal.py rd out/token > out/rd1k.log 2>&1 &
  P=$!
  until_marker out/rd1k.log BOX && { sleep 3; key Tab; key Tab; shot rd-k1; key space; shot rd-k2; key Tab; key Tab; key Return; sleep 2; shot rd-k3; }
  wait $P; cat out/rd1k.log
fi
echo "--- remote-desktop table: $(gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore --object-path /org/freedesktop/impl/portal/PermissionStore --method org.freedesktop.impl.portal.PermissionStore.List remote-desktop 2>&1 | cut -c1-200)"

echo "=== 2. remote control again, from a fresh process, with the saved token"
python3 spike/portal.py rd out/token > out/rd2.log 2>&1 &
P=$!
until_marker out/rd2.log BOX && { sleep 4; shot rd2-after-4s; windows; }
wait $P; cat out/rd2.log

echo "=== 3. screenshot portal: unanswered, then allowed, then again"
python3 spike/portal.py shot > out/s1.log 2>&1; cat out/s1.log
echo "--- after unanswered: $(perms screenshot screenshot)"
python3 spike/portal.py shot > out/s2.log 2>&1 &
P=$!
until_marker out/s2.log BOX && { sleep 3; shot s2-box; click 762 497; }
wait $P; cat out/s2.log
echo "--- after allow: $(perms screenshot screenshot)"
python3 spike/portal.py shot > out/s3.log 2>&1 &
P=$!
until_marker out/s3.log BOX && { sleep 1; shot s3-1s; }
wait $P; cat out/s3.log
ls -la ~/Pictures ~/Pictures/Screenshots 2>&1 | tail -8

echo "=== 4. Electron: the pointer outside and inside its window, then its capture twice"
timeout 150 /tmp/el/node_modules/electron/dist/electron --ozone-platform=wayland --no-sandbox spike/probe.cjs > out/electron.log 2>&1 &
EP=$!
until_marker out/electron.log WINDOW && {
  sleep 2; windows
  move 50 760; echo "hand at 50,760 (outside)"; sleep 1.5
  R=$(ev "(() => { const a = global.get_window_actors().find(a => a.meta_window.get_title() === 'probe'); const r = a.meta_window.get_frame_rect(); return (r.x + 100) + ' ' + (r.y + 100); })()" | grep -oE "[0-9]+ [0-9]+")
  move $R; echo "hand at $R (inside)"; sleep 1.5
  move 1200 60; echo "hand at 1200,60 (outside)"; sleep 1.5
}
until_marker out/electron.log CAPTURE1 && { sleep 4; shot cap1-box; windows; click 640 330; shot cap1-picked; click 922 189; sleep 2; shot cap1-after; }
until_marker out/electron.log CAPTURE2 && { sleep 4; shot cap2-4s; windows; key Escape; }
wait $EP; echo "electron exit $?"
cat out/electron.log | grep -vE "drm_render_node|shared_x_display"
grep -iE "error|warn|critical" out/shell.log | tail -15
