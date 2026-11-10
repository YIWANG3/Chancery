#!/usr/bin/env bash
# Rebuilds build/icon.icns, the icon electron-builder puts on the packaged app, from scripts/make-icon.swift.
# Xcode's toolchain, like build-native.sh: the CLT swift skews against the SDK.
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
xcrun swift scripts/make-icon.swift "$tmp/icon.png"
if [[ -n "${ICON_PREVIEW:-}" ]]; then cp "$tmp/icon.png" "$ICON_PREVIEW"; fi

set="$tmp/icon.iconset"
mkdir -p "$set" build
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$tmp/icon.png" --out "$set/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$tmp/icon.png" --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o build/icon.icns
echo "built build/icon.icns"
