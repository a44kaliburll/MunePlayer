package app.zoonplayer.ui.screens

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.MarqueeAnimationMode
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.zoonplayer.ZoonApp
import app.zoonplayer.data.Album
import app.zoonplayer.data.Artist
import app.zoonplayer.data.Ref
import app.zoonplayer.data.UNKNOWN_ARTIST
import app.zoonplayer.data.VARIOUS_ARTISTS
import app.zoonplayer.data.toCover
import app.zoonplayer.ui.LocalBottomInset
import app.zoonplayer.ui.LocalZoon
import app.zoonplayer.ui.components.ActionLink
import app.zoonplayer.ui.components.AlbumArt
import app.zoonplayer.ui.components.MenuAction
import app.zoonplayer.ui.components.ZText
import app.zoonplayer.ui.components.ZoonEase
import app.zoonplayer.ui.components.featherIn
import app.zoonplayer.ui.components.pressable
import app.zoonplayer.ui.theme.LocalAccent
import app.zoonplayer.ui.theme.Palette
import app.zoonplayer.ui.theme.Type
import app.zoonplayer.ui.theme.ZIcons
import app.zoonplayer.util.fmtTime
import app.zoonplayer.util.norm
import app.zoonplayer.util.plural

@Composable
private fun ActionRow(content: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) { content() }
}

private fun minutes(ms: Long) = "${(ms / 60000).coerceAtLeast(1)} min"

// ------------------------------------------------------------------ artist

@Composable
fun ArtistScreen(key: String) {
    val z = LocalZoon.current
    val graph = ZoonApp.graph
    val lib by graph.library.state.collectAsStateWithLifecycle()
    val artist = lib.artistByKey[key] ?: return MissingPage("artist")
    val list = rememberLazyListState()
    val nowKey = rememberNowKey()
    val related by produceState(emptyList<Artist>(), artist.key, lib.version) {
        val byName = lib.artists.associateBy { norm(it.name) }
        value = graph.online.related(artist.name).mapNotNull { byName[norm(it)] }.filter { it.key != artist.key }.distinctBy { it.key }.take(12)
    }
    val songs = remember(artist) { artist.songs }
    val special = artist.name == UNKNOWN_ARTIST || artist.name == VARIOUS_ARTISTS

    LazyColumn(Modifier.fillMaxSize(), list, contentPadding = PaddingValues(bottom = LocalBottomInset.current + 24.dp)) {
        item(key = "header") {
            Box(Modifier.fillMaxWidth().height(430.dp)) {
                // Photo drifts at half speed as the page scrolls (parallax).
                Box(
                    Modifier.fillMaxSize().graphicsLayer {
                        if (list.firstVisibleItemIndex == 0) translationY = list.firstVisibleItemScrollOffset * 0.5f
                    },
                ) {
                    artist.albums.firstOrNull()?.let { AlbumArt(it.toCover(), Modifier.fillMaxSize().blur(24.dp).graphicsLayer { alpha = 0.55f }) }
                    ArtistPhoto(artist.name, Modifier.fillMaxSize())
                }
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.35f to Color.Transparent, 1f to Color.Black)))
                Column(Modifier.align(Alignment.BottomStart).padding(start = 18.dp, bottom = 6.dp)) {
                    ZText(plural(artist.albums.size, "album") + " · " + plural(artist.songCount, "song"), Type.label, color = Palette.text2)
                    ZText(
                        artist.name.lowercase(),
                        Type.hero,
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Clip,
                        modifier = Modifier.fillMaxWidth().basicMarquee(
                            iterations = Int.MAX_VALUE,
                            animationMode = MarqueeAnimationMode.Immediately,
                            initialDelayMillis = 1500,
                            repeatDelayMillis = 2500,
                            velocity = 40.dp,
                        ),
                    )
                }
            }
        }
        item(key = "actions") {
            Column(Modifier.padding(horizontal = 18.dp)) {
                ActionRow {
                    ActionLink("play all", ZIcons.play, onClick = { z.playArtist(artist) }, accent = true)
                    ActionLink("shuffle", ZIcons.shuffle, onClick = { z.playArtist(artist, shuffle = true) })
                }
                ActionRow {
                    if (!special) ActionLink("smart dj", ZIcons.dj, onClick = { z.smartDj(artist) })
                    val pinned = z.store.isPinned(Ref.ARTIST, artist.key)
                    ActionLink(if (pinned) "unpin" else "pin", ZIcons.pin, onClick = { z.togglePin(Ref.ARTIST, artist.key, artist.name) })
                }
            }
        }
        item(key = "albumsLabel") { SectionLabel("albums", Modifier.padding(horizontal = 18.dp)) }
        item(key = "albums") {
            LazyRow(contentPadding = PaddingValues(horizontal = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                itemsIndexed(artist.albums, key = { _, a -> a.key }) { i, a -> AlbumTile(a, Modifier.featherIn(i), artSize = 150.dp) }
            }
        }
        if (related.isNotEmpty()) {
            item(key = "relatedLabel") { SectionLabel("related artists you have", Modifier.padding(horizontal = 18.dp)) }
            item(key = "related") {
                LazyRow(contentPadding = PaddingValues(horizontal = 18.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(related, key = { it.key }) { a -> ArtistTile(a, Modifier.width(130.dp)) }
                }
            }
        }
        item(key = "songsLabel") { SectionLabel("songs", Modifier.padding(horizontal = 18.dp)) }
        itemsIndexed(songs, key = { _, s -> s.key }) { i, s ->
            SongRow(s, nowKey, Modifier.padding(horizontal = 18.dp), detail = s.album) { z.play(songs, i, from = Ref(Ref.ARTIST, artist.key)) }
        }
    }
}

// ------------------------------------------------------------------ album

@Composable
fun AlbumScreen(key: String) {
    val z = LocalZoon.current
    val lib by ZoonApp.graph.library.state.collectAsStateWithLifecycle()
    val album = lib.albumByKey[key] ?: return MissingPage("album")
    val list = rememberLazyListState()
    val nowKey = rememberNowKey()
    val flip = remember { Animatable(-80f) }
    LaunchedEffect(album.key) { flip.animateTo(0f, tween(620, easing = ZoonEase)) }
    val multiDisc = album.songs.mapNotNull { it.disc }.toSet().size > 1

    LazyColumn(Modifier.fillMaxSize(), list, contentPadding = PaddingValues(bottom = LocalBottomInset.current + 24.dp)) {
        item(key = "header") {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val art = (maxWidth - 36.dp).coerceAtMost(380.dp)
                // A blurred wash of the cover behind the header.
                AlbumArt(album.toCover(), Modifier.matchParentSize().blur(50.dp).graphicsLayer { alpha = 0.45f })
                Box(Modifier.matchParentSize().background(Brush.verticalGradient(0f to Color(0x33000000), 1f to Color.Black)))
                Column(Modifier.statusBarsPadding().padding(start = 18.dp, end = 18.dp, top = 18.dp)) {
                    AlbumArt(
                        album.toCover(),
                        Modifier.size(art).graphicsLayer {
                            // Swings in on open, and tips back as the page scrolls.
                            rotationY = flip.value
                            val scroll = if (list.firstVisibleItemIndex == 0) list.firstVisibleItemScrollOffset.toFloat() else 600f
                            rotationX = (scroll / 30f).coerceAtMost(25f)
                            cameraDistance = 22f * density
                            shadowElevation = 24f
                        },
                        placeholderLabel = album.title,
                    )
                    Spacer(Modifier.height(16.dp))
                    ZText(album.title, Type.title, maxLines = 3)
                    ZText(
                        album.artist,
                        Type.item,
                        color = LocalAccent.current,
                        modifier = Modifier.padding(top = 4.dp).pressable {
                            if (album.artist != UNKNOWN_ARTIST && album.artist != VARIOUS_ARTISTS) z.openArtist(album.artistKey)
                        },
                    )
                    ZText(
                        listOfNotNull(album.year?.toString(), plural(album.songs.size, "song"), minutes(album.durationMs), album.genre.takeIf { it != "Unknown" }?.lowercase()).joinToString(" · "),
                        Type.sub, color = Palette.text3, modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
        item(key = "actions") {
            Column(Modifier.padding(horizontal = 18.dp)) {
                ActionRow {
                    ActionLink("play", ZIcons.play, onClick = { z.playAlbum(album) }, accent = true)
                    ActionLink("shuffle", ZIcons.shuffle, onClick = { z.playAlbum(album, shuffle = true) })
                    ActionLink("more", ZIcons.more, onClick = { z.albumMenu(album) })
                }
            }
        }
        item(key = "gap") { Spacer(Modifier.height(10.dp)) }
        itemsIndexed(album.songs, key = { _, s -> s.key }) { i, s ->
            val discBreak = multiDisc && (i == 0 || album.songs[i - 1].disc != s.disc)
            Column(Modifier.padding(horizontal = 18.dp)) {
                if (discBreak) SectionLabel("disc ${s.disc ?: 1}")
                SongRow(s, nowKey, Modifier.featherIn(i), number = s.track ?: (i + 1), detail = s.artist.takeIf { it != album.artist }, showDuration = true) {
                    z.playAlbum(album, start = i)
                }
            }
        }
    }
}

// ------------------------------------------------------------------ playlist

@Composable
fun PlaylistScreen(id: String) {
    val z = LocalZoon.current
    val graph = ZoonApp.graph
    val playlists by graph.playlists.collectAsStateWithLifecycle()
    val lib by graph.library.state.collectAsStateWithLifecycle()
    val p = playlists.firstOrNull { it.id == id } ?: return MissingPage("playlist")
    val songs = remember(p, lib.version) { p.songKeys.mapNotNull { lib.songByKey[it] } }
    val nowKey = rememberNowKey()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = LocalBottomInset.current + 24.dp)) {
        item(key = "title") {
            Column(Modifier.statusBarsPadding().padding(top = 14.dp)) {
                ZText(if (p.pcId != null) "playlist from your pc" else "playlist", Type.label, color = Palette.text2)
                ZText(p.name.lowercase(), Type.hero, maxLines = 2)
                ZText("${plural(songs.size, "song")} · ${minutes(songs.sumOf { it.durationMs })}", Type.sub, color = Palette.text3)
            }
        }
        item(key = "actions") {
            ActionRow {
                ActionLink("play", ZIcons.play, onClick = { z.playPlaylist(p) }, accent = true)
                ActionLink("shuffle", ZIcons.shuffle, onClick = { z.playPlaylist(p, shuffle = true) })
                ActionLink("more", ZIcons.more, onClick = { z.playlistMenu(p) })
            }
        }
        item(key = "gap") { Spacer(Modifier.height(10.dp)) }
        if (songs.isEmpty()) {
            item(key = "empty") { ZText("Add songs with a long press on any song, album or artist.", Type.body, color = Palette.text2) }
        }
        itemsIndexed(songs, key = { i, s -> "$i:${s.key}" }) { i, s ->
            SongRow(
                s, nowKey, Modifier.featherIn(i), detail = "${s.artist} · ${s.album}",
                onLongClick = {
                    z.songMenu(
                        s,
                        if (p.pcId == null) listOf(MenuAction("remove from playlist") {
                            z.store.editPlaylist(p.id) { pl -> pl.copy(songKeys = pl.songKeys.toMutableList().also { if (i < it.size) it.removeAt(i) }) }
                        }) else emptyList(),
                    )
                },
            ) { z.playPlaylist(p, start = i) }
        }
    }
}

// ------------------------------------------------------------------ genre

@Composable
fun GenreScreen(key: String) {
    val z = LocalZoon.current
    val lib by ZoonApp.graph.library.state.collectAsStateWithLifecycle()
    val genre = lib.genreByKey[key] ?: return MissingPage("genre")
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = LocalBottomInset.current + 24.dp)) {
        item(key = "title") {
            Column(Modifier.statusBarsPadding().padding(top = 14.dp)) {
                ZText("genre", Type.label, color = Palette.text2)
                ZText(genre.name.lowercase(), Type.hero, maxLines = 2)
                ZText("${plural(genre.albums.size, "album")} · ${plural(genre.songCount, "song")}", Type.sub, color = Palette.text3)
            }
        }
        item(key = "actions") {
            ActionRow {
                ActionLink("play", ZIcons.play, onClick = { z.playGenre(genre) }, accent = true)
                ActionLink("shuffle", ZIcons.shuffle, onClick = { z.playGenre(genre, shuffle = true) })
            }
        }
        item(key = "gap") { Spacer(Modifier.height(14.dp)) }
        val rows = genre.albums.chunked(2)
        itemsIndexed(rows, key = { _, r -> r.first().key }) { i, pair ->
            Row(Modifier.fillMaxWidth().padding(bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { a: Album -> AlbumTile(a, Modifier.weight(1f).featherIn(i)) }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}
