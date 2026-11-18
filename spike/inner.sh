#!/bin/bash
set -x
pipewire > out/pipewire.log 2>&1 &
sleep 1
wireplumber > out/wireplumber.log 2>&1 &
gnome-shell --headless --wayland --virtual-monitor 1280x800 --unsafe-mode > out/shell.log 2>&1 &
for i in $(seq 1 80); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.5; done
ls -la "$XDG_RUNTIME_DIR"
export WAYLAND_DISPLAY=wayland-0
sleep 4
shot() { gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$PWD/out/$1.png" > out/shot-$1.txt 2>&1 || echo "screenshot $1 failed: $(cat out/shot-$1.txt)"; }
shell_eval() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
shot start
shell_eval "global.display.get_n_monitors() + ' monitors; ' + global.workspace_manager.n_workspaces + ' workspaces'"
shell_eval "Main.overview.hide(); 'hid overview'"

# A: what Electron's own screenshot does under Wayland (a picker each time? the size? the pointer?)
timeout 70 /tmp/el/node_modules/electron/dist/electron --ozone-platform=wayland --no-sandbox spike/shot.cjs > out/electron-shot.log 2>&1 &
EP=$!
sleep 10; shot during-electron-capture
shell_eval "global.get_window_actors().map(a => a.meta_window.get_title() + ' [' + a.meta_window.get_wm_class() + ']').join(' | ')"
wait $EP; echo "electron exit $?"

# B: the remote-control portal: the box it shows, then Return pressed on it from inside the shell
timeout 100 python3 spike/portal.py > out/portal.log 2>&1 &
PP=$!
sleep 8; shot portal-box
shell_eval "global.get_window_actors().map(a => a.meta_window.get_title() + ' [' + a.meta_window.get_wm_class() + ']').join(' | ')"
shell_eval "const C = imports.gi.Clutter; const d = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const t = global.get_current_time() * 1000; d.notify_keyval(t, C.KEY_Return, C.KeyState.PRESSED); d.notify_keyval(t + 20000, C.KEY_Return, C.KeyState.RELEASED); 'pressed Return'"
sleep 4; shot after-return
wait $PP; echo "portal exit $?"
cat out/portal.log
cat out/electron-shot.log
tail -30 out/shell.log
