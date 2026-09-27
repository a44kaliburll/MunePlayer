# Mune Player release build. Media3, Coil, OkHttp, WorkManager and Compose ship their own
# consumer rules; the app only needs its WorkManager worker kept by name.
-keep class app.muneplayer.sync.AutoSyncWorker { <init>(...); }
# The YouTube player page calls back into the app through a JavaScript bridge.
-keepclassmembers class app.muneplayer.ui.screens.YtBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
