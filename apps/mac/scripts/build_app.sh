#!/usr/bin/env bash
# Build + sign (+ optionally notarize) the .app. macOS only. Requires Xcode command line tools.
#   SIGN_ID="Developer ID Application: Name (TEAMID)"  -> real signature, hardened runtime
#   (unset)                                            -> ad-hoc signature (local runs only)
#   NOTARY_PROFILE=<keychain profile>                  -> also submit to notarytool and staple
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname)" == "Darwin" ]] || { echo "BLOCKED: macOS required" >&2; exit 3; }
swift build -c release --product AlfredCompanion
BIN="$(swift build -c release --show-bin-path)/AlfredCompanion"
APP="dist/Alfred.app"; rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/AlfredCompanion"
cp Sources/AlfredCompanion/Info.plist "$APP/Contents/Info.plist"
codesign --force --timestamp --options runtime --entitlements Sources/AlfredCompanion/AlfredCompanion.entitlements \
  --sign "${SIGN_ID:--}" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
if [[ -n "${NOTARY_PROFILE:-}" && -n "${SIGN_ID:-}" ]]; then
  ditto -c -k --keepParent "$APP" dist/Alfred.zip
  xcrun notarytool submit dist/Alfred.zip --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
fi
echo "built $APP"
