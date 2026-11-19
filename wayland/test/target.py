#!/usr/bin/env python3
"""A fullscreen GTK window for the helper's test: it prints where it was clicked (window
coordinates, which equal the desktop's while it's fullscreen at 0,0), what its text box holds,
and which way it was scrolled. Test-only."""
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402


def say(*a):
    print(*a, flush=True)


w = Gtk.Window(title="target")
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
entry = Gtk.Entry()
area = Gtk.EventBox()
area.set_vexpand(True)
area.add_events(
    Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.SCROLL_MASK | Gdk.EventMask.BUTTON1_MOTION_MASK
)
area.add(Gtk.Label(label="click here"))
box.pack_start(entry, False, False, 0)
box.pack_start(area, True, True, 0)
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
    say("entry", a.x, a.y, a.width, a.height)
    say("area", b.x, b.y, b.width, b.height)
    say("READY")
    return False


w.fullscreen()
w.show_all()
GLib.timeout_add(1500, ready)
GLib.timeout_add_seconds(int(sys.argv[1]) if len(sys.argv) > 1 else 120, Gtk.main_quit)
Gtk.main()
