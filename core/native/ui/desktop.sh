#!/bin/bash
set -eu
export DISPLAY=:99 DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/sfa-desktop-bus
export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
exec 9>/tmp/sfa-desktop.lock
flock -n 9 || exit 0
rm -f /tmp/sfa-desktop-bus /tmp/.X99-lock
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork
Xvfb :99 -screen 0 1568x1000x24 -nolisten tcp -ac &
xpid=$!
trap 'kill "$xpid" 2>/dev/null || true' EXIT
for i in {1..50}; do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep .1; done
openbox >/tmp/sfa-openbox.log 2>&1 &
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || true
dbus-send --session --dest=org.a11y.Bus --type=method_call /org/a11y/bus org.a11y.Bus.GetAddress >/dev/null 2>&1 || true
wait "$xpid"
