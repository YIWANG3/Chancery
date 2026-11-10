#!/bin/bash
# Compiles the native pieces with Xcode's toolchain (the CLT swiftc skews against the SDK):
#   native/bin/axctl       the accessibility helper, a command of its own
#   native/bin/glass.node  the Liquid Glass addon the main process loads (needs the macOS 26 SDK to build; at run
#                          time it does nothing before macOS 26)
# With no argument both are built; `axctl` or `glass` builds just that one.
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
only="${1:-}"
mkdir -p native/bin

if [[ -z "$only" || "$only" == axctl ]]; then
  xcrun swiftc -O -o native/bin/axctl native/axctl/main.swift -framework AppKit -framework ApplicationServices
  echo "built native/bin/axctl"
fi

if [[ -z "$only" || "$only" == glass ]]; then
  # N-API is a stable C ABI whose symbols the host (Electron) provides when the addon is loaded, so the headers of
  # whatever Node runs this script are enough and nothing is linked against.
  include="$(node -p 'require("node:path").resolve(process.execPath, "..", "..", "include", "node")')"
  for arch in arm64 x86_64; do
    xcrun clang++ -arch "$arch" -mmacosx-version-min=14.0 -O2 -fobjc-arc -std=c++17 -bundle -undefined dynamic_lookup \
      -I "$include" -framework AppKit -o "native/bin/glass.$arch.node" native/glass/glass.mm
  done
  lipo -create -output native/bin/glass.node native/bin/glass.arm64.node native/bin/glass.x86_64.node
  rm native/bin/glass.arm64.node native/bin/glass.x86_64.node
  echo "built native/bin/glass.node"
fi
