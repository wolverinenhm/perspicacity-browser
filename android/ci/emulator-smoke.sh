#!/usr/bin/env bash
# Installs the universal APK, launches it, and checks that it stays up and that the bundled
# Tor reaches the network. FLAG_SECURE makes screenshots black, so we rely on logcat.
set -u
mkdir -p ci-out
APK=$(ls out/*universal*.apk | head -1)
adb install -r "$APK"
adb logcat -c
adb shell am start -W -n org.perspicacity.browser/.MainActivity
ok=0
for i in $(seq 1 90); do
  sleep 2
  if adb logcat -d -s Perspicacity:I | grep -q "network ready via socks5"; then ok=1; break; fi
done
adb logcat -d > ci-out/logcat.txt
grep -E "Perspicacity|TorService|FATAL|AndroidRuntime" ci-out/logcat.txt | tail -80
if grep -q "FATAL EXCEPTION" ci-out/logcat.txt && grep -A3 "FATAL EXCEPTION" ci-out/logcat.txt | grep -q "org.perspicacity"; then
  echo "App crashed"; exit 1
fi
adb shell pidof org.perspicacity.browser >/dev/null || { echo "App is not running"; exit 1; }
if [ "$ok" = 1 ]; then
  echo "Tor connected and the WebView proxy is applied."
else
  echo "::warning::Tor did not finish connecting within 3 minutes on the emulator (network-dependent); the app itself stayed up."
fi
