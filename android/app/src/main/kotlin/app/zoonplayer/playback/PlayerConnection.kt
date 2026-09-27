package app.zoonplayer.playback

import android.content.ComponentName
import android.content.Context
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.zoonplayer.data.Session
import app.zoonplayer.data.Song
import kotlin.random.Random
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class PlayerState(
    val connected: Boolean = false,
    val key: String? = null,
    val index: Int = -1,
    val count: Int = 0,
    val isPlaying: Boolean = false,
    val playWhenReady: Boolean = false,
    val buffering: Boolean = false,
    val shuffle: Boolean = false,
    val repeat: Int = Player.REPEAT_MODE_OFF,
    val durationMs: Long = 0,
    /** Changes whenever the queue's contents change. */
    val queueVersion: Int = 0,
    val error: String? = null,
) {
    val hasQueue get() = count > 0
}

/** The app's side of playback: a MediaController for [PlaybackService], as Compose-friendly state. */
class PlayerConnection(private val context: Context) {
    private val _state = MutableStateFlow(PlayerState())
    val state: StateFlow<PlayerState> = _state
    private val main = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var controller: MediaController? = null
    private var ready = CompletableDeferred<MediaController>()
    private var connecting = false
    private var queueVersion = 0

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (events.contains(Player.EVENT_TIMELINE_CHANGED)) queueVersion++
            publish()
        }
    }

    fun connect() {
        if (controller != null || connecting) return
        connecting = true
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token)
            .setListener(object : MediaController.Listener {
                override fun onDisconnected(controller: MediaController) {
                    this@PlayerConnection.controller = null
                    ready = CompletableDeferred()
                    _state.value = PlayerState()
                }
            })
            .buildAsync()
        future.addListener({
            connecting = false
            try {
                val c = future.get()
                controller = c
                c.addListener(listener)
                queueVersion++
                publish()
                ready.complete(c)
            } catch (e: Exception) {
                Log.w("PlayerConnection", "could not connect", e)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun publish() {
        val c = controller ?: return
        _state.value = PlayerState(
            connected = true,
            key = c.currentMediaItem?.mediaId,
            index = c.currentMediaItemIndex,
            count = c.mediaItemCount,
            isPlaying = c.isPlaying,
            playWhenReady = c.playWhenReady,
            buffering = c.playbackState == Player.STATE_BUFFERING,
            shuffle = c.shuffleModeEnabled,
            repeat = c.repeatMode,
            durationMs = c.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0,
            queueVersion = queueVersion,
            error = c.playerError?.message,
        )
    }

    val positionMs: Long get() = controller?.currentPosition ?: 0L
    val bufferedMs: Long get() = controller?.bufferedPosition ?: 0L

    /** Song keys in queue order. */
    fun queueKeys(): List<String> = controller?.let { c -> (0 until c.mediaItemCount).map { c.getMediaItemAt(it).mediaId } } ?: emptyList()

    private fun withController(block: (MediaController) -> Unit) {
        val c = controller
        if (c != null) return block(c)
        connect()
        main.launch { block(ready.await()) }
    }

    fun play(songs: List<Song>, start: Int = 0, shuffle: Boolean = false) {
        if (songs.isEmpty()) return
        withController { c ->
            c.shuffleModeEnabled = shuffle
            val first = if (shuffle && start == 0) Random.nextInt(songs.size) else start.coerceIn(0, songs.size - 1)
            c.setMediaItems(songs.map(Queue::item), first, 0L)
            c.prepare()
            c.play()
        }
    }

    fun playNext(songs: List<Song>) {
        if (songs.isEmpty()) return
        withController { c ->
            if (c.mediaItemCount == 0) return@withController play(songs)
            c.addMediaItems((c.currentMediaItemIndex + 1).coerceAtMost(c.mediaItemCount), songs.map(Queue::item))
        }
    }

    fun enqueue(songs: List<Song>) {
        if (songs.isEmpty()) return
        withController { c ->
            if (c.mediaItemCount == 0) return@withController play(songs)
            c.addMediaItems(songs.map(Queue::item))
        }
    }

    fun toggle() = withController { c ->
        if (c.isPlaying) {
            c.pause()
        } else {
            if (c.playbackState == Player.STATE_IDLE) c.prepare()
            if (c.playbackState == Player.STATE_ENDED) c.seekToDefaultPosition(0)
            c.play()
        }
    }

    fun next() = withController { it.seekToNextMediaItem() }
    fun previous() = withController { it.seekToPrevious() }
    fun seekTo(ms: Long) = withController { it.seekTo(ms) }
    fun jumpTo(index: Int) = withController { c ->
        c.seekToDefaultPosition(index)
        if (!c.isPlaying) c.play()
    }

    fun setShuffle(on: Boolean) = withController { it.shuffleModeEnabled = on }

    /** off -> all -> one -> off, like Zune's repeat button. */
    fun cycleRepeat() = withController { c ->
        c.repeatMode = when (c.repeatMode) {
            Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
            Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
    }

    fun remove(index: Int) = withController { c -> if (index in 0 until c.mediaItemCount) c.removeMediaItem(index) }
    fun move(from: Int, to: Int) = withController { c -> if (from in 0 until c.mediaItemCount) c.moveMediaItem(from, to.coerceIn(0, c.mediaItemCount - 1)) }
    fun clear() = withController { it.clearMediaItems() }

    /** Put back the last queue (paused) when the app starts, like Zune's "resume where I left off". */
    fun restore(session: Session, songs: Map<String, Song>) = withController { c ->
        if (c.mediaItemCount > 0) return@withController
        val items = session.keys.mapNotNull { songs[it] }
        if (items.isEmpty()) return@withController
        c.shuffleModeEnabled = session.shuffle
        c.repeatMode = session.repeat
        c.setMediaItems(items.map(Queue::item), session.index.coerceIn(0, items.size - 1), session.positionMs)
        c.prepare()
    }
}
