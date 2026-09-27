package com.a44kaliburll.zoon.ui

import androidx.compose.runtime.staticCompositionLocalOf
import com.a44kaliburll.zoon.AppGraph
import com.a44kaliburll.zoon.data.Album
import com.a44kaliburll.zoon.data.Artist
import com.a44kaliburll.zoon.data.Genre
import com.a44kaliburll.zoon.data.LOVE
import com.a44kaliburll.zoon.data.HATE
import com.a44kaliburll.zoon.data.Library
import com.a44kaliburll.zoon.data.Playlist
import com.a44kaliburll.zoon.data.Ref
import com.a44kaliburll.zoon.data.SmartDj
import com.a44kaliburll.zoon.data.Song
import com.a44kaliburll.zoon.data.UNKNOWN_ARTIST
import com.a44kaliburll.zoon.data.VARIOUS_ARTISTS
import com.a44kaliburll.zoon.data.toCover
import com.a44kaliburll.zoon.ui.components.ConfirmRequest
import com.a44kaliburll.zoon.ui.components.MenuAction
import com.a44kaliburll.zoon.ui.components.MenuRequest
import com.a44kaliburll.zoon.ui.components.PromptRequest
import com.a44kaliburll.zoon.ui.components.UiHost
import com.a44kaliburll.zoon.util.plural
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** What the screens can do: play things, open things, and the long-press menus. */
class ZoonActions(val graph: AppGraph, val nav: Nav, val ui: UiHost) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val player get() = graph.player
    val store get() = graph.store
    val lib: Library get() = graph.library.state.value

    fun songsOf(p: Playlist): List<Song> = p.songKeys.mapNotNull { lib.songByKey[it] }

    fun play(songs: List<Song>, start: Int = 0, shuffle: Boolean = false, from: Ref? = null, open: Boolean = false) {
        if (songs.isEmpty()) return
        player.play(songs, start, shuffle)
        from?.let { store.addHistory(it.type, it.id) }
        if (open) nav.nowPlaying = true
    }

    fun playAlbum(a: Album, shuffle: Boolean = false, start: Int = 0) = play(a.songs, start, shuffle, Ref(Ref.ALBUM, a.key))
    fun playArtist(a: Artist, shuffle: Boolean = false) = play(a.songs, 0, shuffle, Ref(Ref.ARTIST, a.key))
    fun playGenre(g: Genre, shuffle: Boolean = false) = play(g.songs, 0, shuffle, Ref(Ref.GENRE, g.key))
    fun playPlaylist(p: Playlist, shuffle: Boolean = false, start: Int = 0) = play(songsOf(p), start, shuffle, Ref(Ref.PLAYLIST, p.id))

    fun smartDj(artist: Artist) {
        ui.toast("smart dj: mixing ${artist.name} with related artists…")
        scope.launch {
            val songs = SmartDj.build(graph.online, lib, store.data, artist.key)
            if (songs.isEmpty()) return@launch ui.toast("Not enough music for a Smart DJ mix yet")
            player.play(songs, 0, false)
            store.addHistory(Ref.DJ, artist.key)
            nav.nowPlaying = true
        }
    }

    fun openAlbum(a: Album) = nav.go(Screen.AlbumPage(a.key))
    fun openArtist(key: String) = nav.go(Screen.ArtistPage(key))

    fun heartLabel(song: Song) = when (store.rating(song.key)) {
        LOVE -> "dislike"
        HATE -> "clear rating"
        else -> "love"
    }

    fun togglePin(type: String, id: String, name: String) {
        val pinned = store.isPinned(type, id)
        store.togglePin(type, id)
        ui.toast(if (pinned) "Unpinned $name" else "Pinned $name to quickplay")
    }

    private fun pinLabel(type: String, id: String) = if (store.isPinned(type, id)) "unpin from quickplay" else "pin to quickplay"

    fun songMenu(song: Song, extra: List<MenuAction> = emptyList()) {
        val album = lib.albumByKey[song.albumKey]
        ui.menu = MenuRequest(
            song.title, "${song.artist} · ${song.album}", song.toCover(),
            extra + listOf(
                MenuAction("play next") { player.playNext(listOf(song)); ui.toast("Playing \"${song.title}\" next") },
                MenuAction("add to now playing") { player.enqueue(listOf(song)); ui.toast("Added to now playing") },
                MenuAction("add to playlist") { addToPlaylist(listOf(song)) },
                MenuAction(heartLabel(song)) { store.cycleRating(song) },
            ) + listOfNotNull(
                album?.let { MenuAction("go to album") { openAlbum(it) } },
                song.artistKey.takeIf { song.albumArtist != UNKNOWN_ARTIST && song.albumArtist != VARIOUS_ARTISTS }?.let { MenuAction("go to artist") { openArtist(it) } },
            ),
        )
    }

    fun albumMenu(a: Album) {
        ui.menu = MenuRequest(
            a.title, a.artist, a.toCover(),
            listOf(
                MenuAction("play") { playAlbum(a) },
                MenuAction("shuffle") { playAlbum(a, shuffle = true) },
                MenuAction("play next") { player.playNext(a.songs); ui.toast("Playing \"${a.title}\" next") },
                MenuAction("add to now playing") { player.enqueue(a.songs); ui.toast("Added ${plural(a.songs.size, "song")}") },
                MenuAction("add to playlist") { addToPlaylist(a.songs) },
                MenuAction(pinLabel(Ref.ALBUM, a.key)) { togglePin(Ref.ALBUM, a.key, a.title) },
            ) + listOfNotNull(
                a.artistKey.takeIf { a.artist != UNKNOWN_ARTIST && a.artist != VARIOUS_ARTISTS }?.let { MenuAction("go to artist") { openArtist(it) } },
            ),
        )
    }

    fun artistMenu(a: Artist) {
        ui.menu = MenuRequest(
            a.name, "${plural(a.albums.size, "album")} · ${plural(a.songCount, "song")}", a.albums.firstOrNull()?.toCover(),
            listOf(
                MenuAction("play all") { playArtist(a) },
                MenuAction("shuffle") { playArtist(a, shuffle = true) },
                MenuAction("smart dj") { smartDj(a) },
                MenuAction("add to now playing") { player.enqueue(a.songs); ui.toast("Added ${plural(a.songCount, "song")}") },
                MenuAction(pinLabel(Ref.ARTIST, a.key)) { togglePin(Ref.ARTIST, a.key, a.name) },
            ),
        )
    }

    fun playlistMenu(p: Playlist) {
        val songs = songsOf(p)
        val actions = mutableListOf(
            MenuAction("play") { playPlaylist(p) },
            MenuAction("shuffle") { playPlaylist(p, shuffle = true) },
            MenuAction("add to now playing") { player.enqueue(songs); ui.toast("Added ${plural(songs.size, "song")}") },
            MenuAction(pinLabel(Ref.PLAYLIST, p.id)) { togglePin(Ref.PLAYLIST, p.id, p.name) },
        )
        if (p.pcId == null) {
            actions += MenuAction("rename") {
                ui.prompt = PromptRequest("rename playlist", p.name, "rename") { name -> store.editPlaylist(p.id) { it.copy(name = name.trim().ifEmpty { it.name }) } }
            }
            actions += MenuAction("delete") {
                ui.confirm = ConfirmRequest("delete playlist", "Delete \"${p.name}\"? The songs stay on your phone.", "delete") {
                    store.deletePlaylist(p.id)
                    if ((nav.top.screen as? Screen.PlaylistPage)?.id == p.id) nav.back()
                }
            }
        }
        ui.menu = MenuRequest(p.name, if (p.pcId != null) "playlist from your pc" else plural(songs.size, "song"), songs.firstOrNull()?.toCover(), actions)
    }

    fun addToPlaylist(songs: List<Song>) {
        val mine = store.data.playlists
        ui.menu = MenuRequest(
            "add to playlist", plural(songs.size, "song"), null,
            listOf(MenuAction("new playlist…") { newPlaylist(songs) }) + mine.map { p ->
                MenuAction(p.name) {
                    store.editPlaylist(p.id) { it.copy(songKeys = it.songKeys + songs.map { s -> s.key }) }
                    ui.toast("Added to ${p.name}")
                }
            },
        )
    }

    fun newPlaylist(songs: List<Song> = emptyList()) {
        ui.prompt = PromptRequest("new playlist", "", "create") { name ->
            val p = store.createPlaylist(name, songs.map { it.key })
            ui.toast("Created ${p.name}")
        }
    }
}

val LocalZoon = staticCompositionLocalOf<ZoonActions> { error("ZoonActions not provided") }
