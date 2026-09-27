# Zoon Player release build. Media3, Coil, OkHttp, WorkManager and Compose ship their own
# consumer rules; the app only needs its WorkManager worker kept by name.
-keep class app.zoonplayer.sync.AutoSyncWorker { <init>(...); }
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
