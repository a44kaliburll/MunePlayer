package app.muneplayer.playback

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AndroidColor
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.Shader
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.BitmapLoader
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.toBitmap
import app.muneplayer.MainActivity
import app.muneplayer.R
import app.muneplayer.MuneApp
import app.muneplayer.data.Session
import app.muneplayer.data.Song
import app.muneplayer.data.toCover
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.guava.future

/** MediaItems for songs. The artwork URI is resolved by [ArtworkLoader]. */
object Queue {
    fun item(song: Song): MediaItem = MediaItem.Builder()
        .setMediaId(song.key)
        .setUri(song.uri)
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(song.title)
                .setArtist(song.artist)
                .setAlbumTitle(song.album)
                .setAlbumArtist(song.albumArtist)
                .setGenre(song.genre)
                .setTrackNumber(song.track)
                .setDiscNumber(song.disc)
                .setReleaseYear(song.year)
                .setDurationMs(song.durationMs.takeIf { it > 0 })
                .setArtworkUri(Uri.parse("mune://cover/${song.albumKey}"))
                .setIsPlayable(true)
                .setIsBrowsable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                .build(),
        )
        .build()
}

/**
 * Background playback: ExoPlayer in a MediaSessionService, which gives the notification,
 * lock screen and Bluetooth controls, and keeps playing when the app is closed.
 */
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private var counter: PlayCounter? = null

    override fun onCreate() {
        super.onCreate()
        val graph = MuneApp.graph
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
                DefaultAudioSink.Builder(context)
                    .setEnableFloatOutput(enableFloatOutput)
                    .setAudioProcessors(arrayOf(graph.levels.processor))
                    .build()
        }
        // Songs streamed from the PC need the pairing token.
        val http = OkHttpDataSource.Factory(graph.http).setUserAgent("MunePlayer/1.1")
        val dataSources = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, http)) { spec -> graph.pc.authorize(spec) }
        val player = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()

        val open = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_NOW_PLAYING)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        session = MediaSession.Builder(this, player)
            .setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .setBitmapLoader(CacheBitmapLoader(ArtworkLoader(this)))
            .setCallback(Callback())
            .build()

        val notifications = DefaultMediaNotificationProvider.Builder(this).setChannelName(R.string.playback_channel).build()
        notifications.setSmallIcon(R.drawable.ic_stat_mune)
        setMediaNotificationProvider(notifications)

        counter = PlayCounter(player).also { player.addListener(it) }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0 || p.playbackState == Player.STATE_ENDED) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        counter?.saveSession()
        counter?.stop()
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }

    private inner class Callback : MediaSession.Callback {
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> {
            val lib = MuneApp.graph.library.state.value
            val items = mediaItems.mapNotNull { item ->
                if (item.localConfiguration != null) item else lib.songByKey[item.mediaId]?.let(Queue::item)
            }
            return Futures.immediateFuture(items.toMutableList())
        }

        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            isForPlayback: Boolean,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val graph = MuneApp.graph
            return graph.scope.future(Dispatchers.Main) {
                val lib = graph.awaitLibrary()
                val s = graph.store.data.session ?: throw IOException("Nothing to resume")
                val songs = s.keys.mapNotNull { lib.songByKey[it] }
                if (songs.isEmpty()) throw IOException("Nothing to resume")
                MediaSession.MediaItemsWithStartPosition(songs.map(Queue::item), s.index.coerceIn(0, songs.size - 1), s.positionMs)
            }
        }
    }

    /** Counts a play once half a song (or four minutes) has played, and remembers the queue. */
    private class PlayCounter(private val player: Player) : Player.Listener {
        private val handler = Handler(Looper.getMainLooper())
        private var counted = false
        private var ticks = 0
        private val tick = object : Runnable {
            override fun run() {
                check()
                if (++ticks % 10 == 0) saveSession()
                if (player.isPlaying) handler.postDelayed(this, 1000)
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            counted = false
            saveSession()
        }

        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
            // Repeat-one restarts the same item: that's a new play.
            if (oldPosition.mediaItemIndex == newPosition.mediaItemIndex && newPosition.positionMs < 1000 && reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION) {
                counted = false
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            handler.removeCallbacks(tick)
            if (isPlaying) handler.post(tick) else saveSession()
        }

        private fun check() {
            if (counted) return
            val dur = player.duration
            if (dur == C.TIME_UNSET || dur <= 0) return
            if (player.currentPosition >= minOf(dur / 2, 240_000L)) {
                counted = true
                val key = player.currentMediaItem?.mediaId ?: return
                val graph = MuneApp.graph
                graph.library.state.value.songByKey[key]?.let { graph.store.recordPlay(it) }
            }
        }

        fun saveSession() {
            val n = player.mediaItemCount
            val graph = MuneApp.graph
            if (n == 0) return graph.store.saveSession(null)
            val keys = (0 until n).map { player.getMediaItemAt(it).mediaId }
            graph.store.saveSession(Session(keys, player.currentMediaItemIndex, player.currentPosition, player.shuffleModeEnabled, player.repeatMode))
        }

        fun stop() = handler.removeCallbacksAndMessages(null)
    }
}

/** Album art for the notification and lock screen, through the same Coil pipeline as the app. */
private class ArtworkLoader(private val context: Context) : BitmapLoader {
    private val fallback = DataSourceBitmapLoader.Builder(context).build()

    override fun supportsMimeType(mimeType: String): Boolean = fallback.supportsMimeType(mimeType)

    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = fallback.decodeBitmap(data)

    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> {
        if (uri.scheme != "mune") return fallback.loadBitmap(uri)
        val graph = MuneApp.graph
        val albumKey = uri.lastPathSegment.orEmpty()
        return graph.scope.future(Dispatchers.IO) {
            val album = graph.library.state.value.albumByKey[albumKey] ?: throw IOException("Unknown album")
            val request = ImageRequest.Builder(context).data(album.toCover()).size(720).allowHardware(false).build()
            val art = graph.imageLoader.execute(request).image?.toBitmap() ?: throw IOException("No art")
            forSystemUi(art, graph.store.data.settings.accent.toInt())
        }
    }

    /**
     * The lock screen and notification player tint themselves from the cover. On the Android 17
     * emulator, a cover with almost no colour (a black and grey night photo, say) makes SystemUI's
     * colour picking crash. So: an opaque ARGB copy, and colourless covers get a faint glow in the
     * accent colour in one corner, which gives SystemUI a colour to work with.
     */
    private fun forSystemUi(src: Bitmap, accent: Int): Bitmap {
        val side = minOf(720, maxOf(src.width, src.height))
        val scale = side.toFloat() / maxOf(src.width, src.height)
        val w = maxOf(1, (src.width * scale).toInt())
        val h = maxOf(1, (src.height * scale).toInt())
        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        canvas.drawColor(AndroidColor.BLACK)
        canvas.drawBitmap(src, null, Rect(0, 0, w, h), Paint(Paint.FILTER_BITMAP_FLAG))
        if (!colourful(out)) {
            val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                shader = RadialGradient(
                    0f, h.toFloat(), maxOf(w, h) * 0.75f,
                    intArrayOf(AndroidColor.argb(170, AndroidColor.red(accent), AndroidColor.green(accent), AndroidColor.blue(accent)), AndroidColor.TRANSPARENT),
                    null, Shader.TileMode.CLAMP,
                )
            }
            canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), glow)
        }
        return out
    }

    /** At least 5% of a small sample is clearly coloured (not black, white or grey). */
    private fun colourful(b: Bitmap): Boolean {
        val small = Bitmap.createScaledBitmap(b, 24, 24, true)
        val hsv = FloatArray(3)
        var n = 0
        for (y in 0 until 24) for (x in 0 until 24) {
            AndroidColor.colorToHSV(small.getPixel(x, y), hsv)
            if (hsv[1] > 0.3f && hsv[2] > 0.25f) n++
        }
        return n >= 29
    }
}
