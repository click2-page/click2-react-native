#!/usr/bin/env bash
# Builds the example app in release mode (Hermes bytecode, like a store build), runs the SDK self-test on an
# Android emulator or device and checks that every test passed. Needs a click2 server on localhost:8799 serving the
# team acme.click2.page with the links spring, webonly, droid and ab (see README.md).
#   ANDROID_SERIAL=emulator-5554 ./selftest-android.sh
set -euo pipefail
cd "$(dirname "$0")"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
# The SDK as published: a packed tarball of the current source.
(cd .. && npm run build >/dev/null && npm pack --silent >/dev/null && mv click2-react-native-*.tgz example/)
npm install --no-audit --no-fund ./click2-react-native-*.tgz >/dev/null
(cd android && ./gradlew -q assembleRelease)
"$ADB" reverse tcp:8799 tcp:8799
"$ADB" install -r android/app/build/outputs/apk/release/app-release.apk >/dev/null
"$ADB" shell pm clear page.click2.example >/dev/null
"$ADB" logcat -c
"$ADB" shell am start -n page.click2.example/.MainActivity >/dev/null
for _ in $(seq 1 30); do
  sleep 2
  "$ADB" logcat -d -s ReactNativeJS | grep -q "C2TEST DONE" && break
done
"$ADB" logcat -d -s ReactNativeJS | grep -o "C2TEST.*"
summary=$("$ADB" logcat -d -s ReactNativeJS | grep -o "C2TEST DONE.*" | tail -1 || true)
[[ "$summary" =~ DONE\ ([0-9]+)/([0-9]+) && "${BASH_REMATCH[1]}" == "${BASH_REMATCH[2]}" ]] || { echo "FAILED: self-test (${summary:-no result})"; exit 1; }
# A link that starts the app, then one while it runs.
"$ADB" shell am force-stop page.click2.example
"$ADB" logcat -c
"$ADB" shell am start -W -a android.intent.action.VIEW -d "https://acme.click2.page/droid" page.click2.example >/dev/null
sleep 8
"$ADB" shell am start -W -a android.intent.action.VIEW -d "https://acme.click2.page/webonly" page.click2.example >/dev/null
sleep 4
links=$("$ADB" logcat -d -s ReactNativeJS | grep -o "C2LINK.*" || true)
echo "$links"
[[ "$links" == *"droid → openRoute android/home"* && "$links" == *"webonly → openWeb"* ]] || { echo "FAILED: link opens"; exit 1; }
echo "OK"
