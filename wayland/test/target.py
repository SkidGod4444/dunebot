#!/usr/bin/env python3
"""A fullscreen GTK window for the helper's test: it prints where it was clicked (in the window's
own logical points: the tests turn them into the desktop's with the window's place and size, which
differ at 200%), what its text box holds, and which way it was scrolled. A magenta square (the
marker) lets a test find the window in a picture of the screen; clicks go through it.

usage: target.py [seconds] [monitor] [title]     (fullscreen on that monitor; title "target")
Test-only."""
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402


def say(*a):
    print(*a, flush=True)


SECS = int(sys.argv[1]) if len(sys.argv) > 1 else 120
MONITOR = int(sys.argv[2]) if len(sys.argv) > 2 else 0
TITLE = sys.argv[3] if len(sys.argv) > 3 else "target"
MARK = (300, 220, 48, 48)  # x, y, width, height in the area, logical points

w = Gtk.Window(title=TITLE)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
entry = Gtk.Entry()
area = Gtk.EventBox()
area.set_vexpand(True)
area.add_events(
    Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.BUTTON1_MOTION_MASK
)
area.add(Gtk.Label(label="click here"))
css = Gtk.CssProvider()
css.load_from_data(b"#mark { background-color: #ff00ff; }")
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
mark = Gtk.Box(name="mark")
mark.set_size_request(MARK[2], MARK[3])
mark.set_halign(Gtk.Align.START)
mark.set_valign(Gtk.Align.START)
mark.set_margin_start(MARK[0])
mark.set_margin_top(MARK[1])
over = Gtk.Overlay()
over.add(area)
over.add_overlay(mark)
over.set_overlay_pass_through(mark, True)
box.pack_start(entry, False, False, 0)
box.pack_start(over, True, True, 0)
w.add(box)


def press(widget, e):
    x, y = widget.translate_coordinates(w, int(e.x), int(e.y))
    say("press", e.button, x, y, e.type.value_nick)
    return True


def release(widget, e):
    x, y = widget.translate_coordinates(w, int(e.x), int(e.y))
    say("release", e.button, x, y)
    return True


def motion(widget, e):
    x, y = widget.translate_coordinates(w, int(e.x), int(e.y))
    say("drag-motion", x, y)
    return True


def scroll(widget, e):
    if e.direction == Gdk.ScrollDirection.SMOOTH:
        ok, dx, dy = e.get_scroll_deltas()
        say("scroll", "smooth", dx, dy)
    else:
        say("scroll", e.direction.value_nick)
    return True


area.connect("button-press-event", press)
area.connect("button-release-event", release)
area.connect("scroll-event", scroll)
area.connect("motion-notify-event", motion)
entry.connect("changed", lambda e: say("text", repr(e.get_text())))
w.connect("destroy", Gtk.main_quit)


def ready():
    a = entry.get_allocation()
    b = area.get_allocation()
    m = mark.get_allocation()
    # The overlay gives the marker a window of its own: its place comes from there, in the window's points.
    mx, my = mark.translate_coordinates(w, 0, 0)
    say("entry", a.x, a.y, a.width, a.height)
    say("area", b.x, b.y, b.width, b.height)
    say("marker", mx, my, m.width, m.height)
    say("size", w.get_allocated_width(), w.get_allocated_height())
    say("READY")
    return False


w.show_all()
w.fullscreen_on_monitor(w.get_screen(), MONITOR)
GLib.timeout_add(1500, ready)
GLib.timeout_add_seconds(SECS, Gtk.main_quit)
Gtk.main()
