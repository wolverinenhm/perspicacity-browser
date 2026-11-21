# Tor service and its control library are reached by reflection/intent.
-keep class org.torproject.jni.** { *; }
-keep class net.freehaven.tor.control.** { *; }
-dontwarn net.freehaven.tor.control.**
-dontwarn kotlin.**
