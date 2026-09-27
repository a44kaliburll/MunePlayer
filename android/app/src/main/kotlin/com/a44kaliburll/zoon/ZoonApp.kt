package com.a44kaliburll.zoon

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import com.a44kaliburll.zoon.data.CoverFetcher
import com.a44kaliburll.zoon.data.CoverKeyer
import com.a44kaliburll.zoon.data.Covers
import com.a44kaliburll.zoon.data.Library
import com.a44kaliburll.zoon.data.MusicLibrary
import com.a44kaliburll.zoon.data.Online
import com.a44kaliburll.zoon.data.Playlist
import com.a44kaliburll.zoon.data.UserStore
import com.a44kaliburll.zoon.playback.AudioLevels
import com.a44kaliburll.zoon.playback.PlayerConnection
import com.a44kaliburll.zoon.sync.AutoSyncWorker
import com.a44kaliburll.zoon.sync.PcLink
import com.a44kaliburll.zoon.sync.SyncEngine
import com.a44kaliburll.zoon.sync.SyncManifest
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import okhttp3.OkHttpClient
import okio.Path.Companion.toOkioPath

/** Everything the app shares: library, player, stores, sync. One per process. */
class AppGraph(val app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .build()
    val store = UserStore(File(app.filesDir, "state.json"), scope)
    val manifest = SyncManifest(File(app.filesDir, "synced.json"))
    val library = MusicLibrary(app, manifest, scope)
    val online = Online(http, File(app.filesDir, "online.json"), scope) { store.data.settings }
    val covers = Covers(app, online)
    val levels = AudioLevels()
    val player = PlayerConnection(app)
    val pc = PcLink(app, http, File(app.filesDir, "pc.json"))
    val sync = SyncEngine(app, this)

    val imageLoader: ImageLoader = ImageLoader.Builder(app)
        .components {
            add(OkHttpNetworkFetcherFactory(callFactory = { http }))
            add(CoverFetcher.Factory(covers))
            add(CoverKeyer())
        }
        .memoryCache { MemoryCache.Builder().maxSizePercent(app, 0.22).build() }
        .diskCache { DiskCache.Builder().directory(File(app.cacheDir, "images").toOkioPath()).maxSizeBytes(250L * 1024 * 1024).build() }
        .crossfade(true)
        .build()

    /** The phone's own playlists, then the PC's (showing only songs that are on the phone). */
    val playlists: StateFlow<List<Playlist>> = combine(store.state, manifest.version, library.state) { user, _, lib ->
        val pcLists = manifest.playlists.map { p ->
            Playlist("pc:${p.id}", p.name, p.trackIds.map { "pc:$it" }.filter { it in lib.songByKey }, pcId = p.id)
        }.filter { it.songKeys.isNotEmpty() }
        user.playlists + pcLists
    }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    suspend fun awaitLibrary(): Library = library.state.first { it.loaded }

    fun start() {
        library.start()
        library.refresh()
        AutoSyncWorker.schedule(app, pc.pc.value != null && store.data.settings.autoSync)
    }
}

class ZoonApp : Application(), SingletonImageLoader.Factory {
    override fun onCreate() {
        super.onCreate()
        instance = this
        graph.start()
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader = graph.imageLoader

    companion object {
        private lateinit var instance: ZoonApp
        val graph: AppGraph by lazy { AppGraph(instance) }
    }
}
