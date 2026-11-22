#!/usr/bin/env bash
# Runs the instrumented agent test (Shadow tab + scripted local model) on the running emulator.
set -u
mkdir -p ci-out
cd android
./gradlew --no-daemon :app:connectedDebugAndroidTest
status=$?
cp -r app/build/reports/androidTests ../ci-out/ 2>/dev/null
adb logcat -d -s Perspicacity:* TestRunner:* AndroidRuntime:E > ../ci-out/agent-test-logcat.txt 2>/dev/null
tail -60 ../ci-out/agent-test-logcat.txt
exit $status
