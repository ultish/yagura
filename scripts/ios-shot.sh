#!/bin/sh
# A page as iOS Safari draws it, in the iOS Simulator (real WebKit): scripts/ios-shot.sh <url> <out.png> [seconds to wait, default 8]
# Chrome's phone emulation is Blink and misses WebKit-only layout bugs: a font stack that made every button squeeze its label showed only here.
# IOS_DEVICE=<simulator udid> picks the phone (default: the first iPhone listed); the simulator stays booted, stop it with: xcrun simctl shutdown all
set -eu
url=${1:?usage: ios-shot.sh <url> <out.png> [seconds]}
out=${2:?usage: ios-shot.sh <url> <out.png> [seconds]}
wait=${3:-8}
udid=${IOS_DEVICE:-$(xcrun simctl list devices available | grep -m1 "iPhone" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')}
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl openurl "$udid" "$url"
sleep "$wait"
xcrun simctl io "$udid" screenshot "$out"
