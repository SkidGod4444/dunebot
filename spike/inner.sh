#!/bin/bash
# Round 7: the box answered "screen only"; a GNOME shortcut added while its service runs; a
# click-through card over a window; frames that change; the pointer and frames at another scale.
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
move() { ev "$J global._ciP.notify_absolute_motion(G.get_monotonic_time(), $1, $2); 'moved'" > /dev/null; sleep 0.3; }
click() { move $1 $2; ev "$J const t = G.get_monotonic_time(); global._ciP.notify_button(t, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); global._ciP.notify_button(t + 80000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); 'clicked $1 $2'"; sleep 0.6; }
keys() { ev "$J const k = global._ciK; let t = G.get_monotonic_time(); const ks = '$*'.split(' ').map(n => C['KEY_' + n]); for (const v of ks) k.notify_keyval(t += 20000, v, C.KeyState.PRESSED); for (const v of ks.reverse()) k.notify_keyval(t += 20000, v, C.KeyState.RELEASED); 'keys $*'"; sleep 0.5; }
stack() { ev "global.get_window_actors().map(a => { const w = a.meta_window, r = w.get_frame_rect(); return w.get_title() + ' ' + [r.x, r.y, r.width, r.height].join(',') + (w.is_above() ? ' above' : '') + (w.has_focus() ? ' focused' : ''); }).join(' | ') + '  (bottom to top)'"; }
frame_of() { ev "(() => { const a = global.get_window_actors().find(a => a.meta_window.get_title() === '$1'); if (!a) return 'none'; const r = a.meta_window.get_frame_rect(); return [r.x, r.y, r.width, r.height].join(' '); })()" | grep -oE "[0-9]+ [0-9]+ [0-9]+ [0-9]+"; }
until_marker() { for i in $(seq 1 80); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.5; done; echo "no $2 in $1"; return 1; }
EL=/tmp/el/node_modules/electron/dist/electron
ev "Main.overview.hide(); 'ok'" > /dev/null
export WITH_SCREEN=1

echo "=== 1. the box answered with Share alone (control switch left off)"
python3 spike/portal.py rd out/tok > out/a1.log 2>&1 &
P=$!; until_marker out/a1.log BOX && { sleep 3; shot a1-box; click 922 189; }
wait $P; cat out/a1.log
echo "--- fresh process, saved token"
python3 spike/portal.py rd out/tok > out/a2.log 2>&1 &
P=$!; until_marker out/a2.log BOX && { sleep 3; shot a2-3s; }
wait $P; cat out/a2.log
echo "--- ask again: a fresh process with no token"
rm -f out/tok
python3 spike/portal.py rd out/tok > out/a3.log 2>&1 &
P=$!; until_marker out/a3.log BOX && { sleep 3; shot a3-box; click 896 322; shot a3-switched; click 922 189; }
wait $P; cat out/a3.log

echo "=== 2. GNOME's own shortcut, added while its service already runs"
/usr/libexec/gsd-media-keys > out/gsd.log 2>&1 &
sleep 6
B0=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/
B1=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom1/
gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "['$B0', '$B1']"
for b in "$B0|Dune Bot stop|touch /tmp/fired-ctrl-alt-period|<Control><Alt>period" "$B1|Dune Bot bar|touch /tmp/fired-super-alt-d|<Super><Alt>d"; do
  IFS='|' read -r path name cmd bind <<< "$b"
  gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$path name "$name"
  gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$path command "$cmd"
  gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$path binding "$bind"
done
sleep 3
keys Control_L Alt_L period; sleep 1.5
keys Super_L Alt_L d; sleep 1.5
ls -la /tmp/fired-* 2>&1; grep -iE "custom|grab" out/gsd.log | head -6
echo "--- changed live to another combo"
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$B0 binding '<Control><Alt>comma'
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$B0 command 'touch /tmp/fired-ctrl-alt-comma'
sleep 3; keys Control_L Alt_L comma; sleep 1.5; ls -la /tmp/fired-* 2>&1

echo "=== 3. a click-through card over a window; libei clicks; focus; stacking"
rm -f /tmp/card-solid
STAY=70 $EL --ozone-platform=wayland --no-sandbox spike/card.cjs > out/card.log 2>&1 &
CP=$!
until_marker out/card.log READY; sleep 3; stack
read TX TY TW TH <<< "$(frame_of target)"; read CX CY CW CH <<< "$(frame_of card)"
echo "target $TX $TY $TW $TH  card $CX $CY $CW $CH"
OX=$(( (TX > CX ? TX : CX) + 60 )); OY=$(( (TY > CY ? TY : CY) + 60 ))
echo "overlap point $OX $OY"; shot card-start
printf "click $OX $OY\nwait 1\ntype hi\nwait 1\n" > out/steps-a.txt
python3 spike/portal.py rd out/tok out/steps-a.txt > out/c1.log 2>&1; grep eis: out/c1.log | tail -4; stack
touch /tmp/card-solid; sleep 1
printf "click $OX $OY\nwait 1\n" > out/steps-b.txt
python3 spike/portal.py rd out/tok out/steps-b.txt > out/c2.log 2>&1; grep eis: out/c2.log | tail -2; stack
echo "--- the target clicked where the card isn't; is the card still above?"
printf "click $((TX + 20)) $((TY + TH - 20))\nwait 1\n" > out/steps-c.txt
python3 spike/portal.py rd out/tok out/steps-c.txt > out/c3.log 2>&1; stack; shot card-end
kill $CP; wait $CP 2>/dev/null; grep -vE "drm_render|shared_x_display" out/card.log | grep -v "focused: target false card false app none" | head -40

echo "=== 4. frames change with the screen"
BETWEEN_FRAMES="gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval 'Main.overview.show(); 1'; sleep 1.5" python3 spike/portal.py rd out/tok > out/f.log 2>&1; grep frame out/f.log
ev "Main.overview.hide(); 'ok'" > /dev/null; sleep 1

echo "=== 5. another scale"
python3 spike/display.py 2
sleep 3; python3 spike/display.py
STAY=30 $EL --ozone-platform=wayland --no-sandbox spike/target.cjs > out/t2.log 2>&1 &
TP=$!
until_marker out/t2.log READY; sleep 2
read FX FY FW FH <<< "$(frame_of target)"; echo "target frame (logical) $FX $FY $FW $FH"
printf "click $((FX + 100)) $((FY + 150))\nwait 0.5\nclick $((FX + 300)) $((FY + 250))\nwait 0.5\n" > out/steps-s.txt
python3 spike/portal.py rd out/tok out/steps-s.txt > out/s.log 2>&1; grep -E "streams|frame|region|clicked|BOX|Start" out/s.log
shot scaled; wait $TP; grep "page:" out/t2.log
