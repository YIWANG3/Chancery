#!/bin/bash
# Compiles native/axctl with Xcode's toolchain (the CLT swiftc skews against the SDK).
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mkdir -p native/bin
xcrun swiftc -O -o native/bin/axctl native/axctl/main.swift -framework AppKit -framework ApplicationServices
echo "built native/bin/axctl"
