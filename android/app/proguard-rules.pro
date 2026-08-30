# The JavaScript bridge is called by name from the web layer, so its methods
# must survive any future shrinking.
-keepclassmembers class com.candleapp.flame.MainActivity$HostBridge {
    public *;
}
