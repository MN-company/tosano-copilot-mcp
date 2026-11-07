#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:99
Xvfb :99 -screen 0 1366x768x24 -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
for _ in {1..50}; do
  [[ -S /tmp/.X11-unix/X99 ]] && break
  sleep 0.1
done
x11vnc -display :99 -rfbport 5900 -localhost -nopw -forever -shared >/dev/null 2>&1 &
VNC_PID=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/dev/null 2>&1 &
WEB_PID=$!
cleanup() { kill "$WEB_PID" "$VNC_PID" "$XVFB_PID" 2>/dev/null || true; }
trap cleanup EXIT
echo 'Open http://127.0.0.1:6080/vnc.html on the WINDOWS PC while this command is running.'
echo 'This page is bound to loopback only. Follow the active discovery/login script; press ENTER when it asks.'
SCRIPT="${1:-src/login.mjs}"
case "$SCRIPT" in src/login.mjs|src/discover-cart.mjs|src/discover-site.mjs) ;; *) echo 'Unsupported browser script' >&2;exit 2;; esac
node "$SCRIPT"
