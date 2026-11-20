# Fedora 43 (GNOME 49, Mutter's logical layout) for the Wayland tests: GNOME's shell, portal and
# PipeWire, GTK 3 for the target window, the accessibility bus for GNOME's box, Electron's
# libraries, and what the helper builds with. Used by fedora.sh.
FROM fedora:43
RUN dnf -y install --setopt=install_weak_deps=False \
    gnome-shell mutter xdg-desktop-portal xdg-desktop-portal-gnome pipewire wireplumber \
    python3-gobject gtk3 at-spi2-core dbus-daemon dbus-tools glib2 mesa-dri-drivers mesa-libEGL dejavu-sans-fonts \
    gnome-settings-daemon xorg-x11-server-Xwayland dconf ibus nodejs util-linux procps-ng which \
    nss alsa-lib libXScrnSaver mesa-libgbm libxshmfence at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr libXtst \
    pipewire-devel libxkbcommon-devel clang clang-devel pkgconf-pkg-config cargo rust gcc \
  && dnf clean all
RUN useradd -m dev && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
