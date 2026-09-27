package app.zoonplayer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

sealed interface Screen {
    data object Home : Screen
    data class Music(val page: Int = 0) : Screen
    data class ArtistPage(val key: String) : Screen
    data class AlbumPage(val key: String) : Screen
    data class PlaylistPage(val id: String) : Screen
    data class GenrePage(val key: String) : Screen
    data object Search : Screen
    data object Settings : Screen
    data object Sync : Screen
    data object SmartDj : Screen
    data class YouTubeHome(val page: Int = 0, val query: String? = null) : Screen
    data class YouTubePlaylist(val id: String, val title: String) : Screen
    data object YouTubePlayer : Screen
    data object YouTubeSetup : Screen
}

/** One place in the back stack. [id] keys its saved scroll positions. */
data class Entry(val id: Int, val screen: Screen)

/** A tiny back stack with Zune-style forward/back transitions, plus the now playing overlay. */
class Nav {
    private var nextId = 1
    val stack = mutableStateListOf(Entry(0, Screen.Home))
    var forward by mutableStateOf(true)
        private set
    var nowPlaying by mutableStateOf(false)
    var queueOpen by mutableStateOf(false)
    /** Ids of entries that were popped, so their saved state can be dropped. */
    val dropped = mutableListOf<Int>()

    val top: Entry get() = stack.last()

    fun go(screen: Screen) {
        nowPlaying = false
        if (top.screen == screen) return
        forward = true
        stack.add(Entry(nextId++, screen))
    }

    /** Replace the top screen (e.g. switching pivots from the home menu). */
    fun home() {
        nowPlaying = false
        if (stack.size == 1) return
        forward = false
        while (stack.size > 1) dropped += stack.removeAt(stack.lastIndex).id
    }

    fun back(): Boolean {
        if (queueOpen) {
            queueOpen = false
            return true
        }
        if (nowPlaying) {
            nowPlaying = false
            return true
        }
        if (stack.size > 1) {
            forward = false
            dropped += stack.removeAt(stack.lastIndex).id
            return true
        }
        return false
    }

    val canGoBack get() = queueOpen || nowPlaying || stack.size > 1
}
