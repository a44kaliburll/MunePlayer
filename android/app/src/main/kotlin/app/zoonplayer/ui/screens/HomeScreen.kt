package app.zoonplayer.ui.screens

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PageSize
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.zoonplayer.ZoonApp
import app.zoonplayer.data.Library
import app.zoonplayer.data.Playlist
import app.zoonplayer.data.Ref
import app.zoonplayer.data.toCover
import app.zoonplayer.ui.LocalBottomInset
import app.zoonplayer.ui.LocalZoon
import app.zoonplayer.ui.Screen
import app.zoonplayer.ui.components.AlbumArt
import app.zoonplayer.ui.components.ZText
import app.zoonplayer.ui.components.featherIn
import app.zoonplayer.ui.components.pressable
import app.zoonplayer.ui.components.rememberPulse
import app.zoonplayer.ui.theme.LocalAccent
import app.zoonplayer.ui.theme.Palette
import app.zoonplayer.ui.theme.Type

/**
 * The Zune HD home screen: a column of giant lowercase words, with quickplay (pins, history,
 * new) peeking in from the right. The backdrop and the huge "zoon" behind everything slide
 * at their own speeds as you swipe across, like a panorama.
 */
@Composable
fun HomeScreen() {
    val pager = rememberPagerState { 2 }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val full = maxWidth
        HomeBackdrop(pager)
        ZText(
            "zoon",
            Type.giant,
            color = Color.White.copy(alpha = 0.06f),
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Visible,
            modifier = Modifier.wrapContentWidth(Alignment.Start, unbounded = true).padding(top = 40.dp).graphicsLayer {
                translationX = -(pager.currentPage + pager.currentPageOffsetFraction) * full.toPx() * 0.3f - 12.dp.toPx()
            },
        )
        HorizontalPager(
            state = pager,
            pageSize = PageSize.Fixed(full * 0.84f),
            // Room after the last page so quickplay can snap to the left edge like the menu does.
            contentPadding = PaddingValues(end = full * 0.16f),
            beyondViewportPageCount = 1,
            modifier = Modifier.fillMaxSize(),
        ) { page ->
            if (page == 0) {
                HomeMenu()
            } else {
                // Quickplay is laid out full width even though its page is narrower, so it
                // peeks in beside the menu and fills the screen once you swipe over.
                Box(Modifier.fillMaxHeight().wrapContentWidth(Alignment.Start, unbounded = true).width(full)) { Quickplay(full) }
            }
        }
    }
}

@Composable
private fun HomeBackdrop(pager: PagerState) {
    val z = LocalZoon.current
    val graph = ZoonApp.graph
    val user by z.store.state.collectAsStateWithLifecycle()
    val lib by graph.library.state.collectAsStateWithLifecycle()
    val player by z.player.state.collectAsStateWithLifecycle()
    val song = player.key?.let { lib.songByKey[it] }
    val artistName = song?.albumArtist ?: user.history.firstNotNullOfOrNull { h ->
        when (h.type) {
            Ref.ARTIST, Ref.DJ -> lib.artistByKey[h.id]?.name
            Ref.ALBUM -> lib.albumByKey[h.id]?.artist
            else -> null
        }
    }
    val accent = LocalAccent.current
    val pulse by rememberPulse(graph.levels, player.isPlaying)
    val drift = rememberInfiniteTransition(label = "drift")
    val d by drift.animateFloat(0f, 1f, infiniteRepeatable(tween(18000, easing = LinearEasing), RepeatMode.Reverse), label = "d")

    Box(
        Modifier.fillMaxSize().graphicsLayer {
            translationX = -(pager.currentPage + pager.currentPageOffsetFraction) * size.width * 0.12f
            scaleX = 1.25f
            scaleY = 1.25f
        },
    ) {
        when {
            user.settings.background == "artist" && artistName != null -> {
                ArtistPhoto(artistName, Modifier.fillMaxSize().graphicsLayer { translationY = (d - 0.5f) * 40f }, alpha = 0.5f)
            }
            user.settings.background != "black" -> {
                // The Zune "wave": two soft colour blooms drifting across black.
                Canvas(Modifier.fillMaxSize().blur(60.dp)) {
                    drawCircle(
                        Brush.radialGradient(listOf(Palette.pink.copy(alpha = 0.55f), Color.Transparent), center = Offset(size.width * (0.2f + 0.5f * d), size.height * 0.3f), radius = size.width * 0.8f),
                        radius = size.width * 0.8f, center = Offset(size.width * (0.2f + 0.5f * d), size.height * 0.3f),
                    )
                    drawCircle(
                        Brush.radialGradient(listOf(Palette.orange.copy(alpha = 0.45f), Color.Transparent), center = Offset(size.width * (0.9f - 0.4f * d), size.height * 0.75f), radius = size.width * 0.7f),
                        radius = size.width * 0.7f, center = Offset(size.width * (0.9f - 0.4f * d), size.height * 0.75f),
                    )
                }
            }
        }
    }
    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Color(0xE6000000), Color(0x66000000), Color(0x99000000)))))
    // The glow along the bottom breathes with the music, like the desktop app's.
    Canvas(Modifier.fillMaxSize()) {
        val strength = if (player.isPlaying) 0.25f + 0.55f * pulse else 0.18f
        drawRect(
            Brush.radialGradient(
                listOf(accent.copy(alpha = strength), Color.Transparent),
                center = Offset(size.width * 0.5f, size.height * 1.05f),
                radius = size.width * (0.85f + 0.2f * pulse),
            ),
        )
    }
}

@Composable
private fun HomeMenu() {
    val z = LocalZoon.current
    val player by z.player.state.collectAsStateWithLifecycle()
    val items = buildList {
        add("music" to { z.nav.go(Screen.Music()) })
        if (player.hasQueue) add("now playing" to { z.nav.nowPlaying = true })
        add("smart dj" to { z.nav.go(Screen.SmartDj) })
        add("playlists" to { z.nav.go(Screen.Music(3)) })
        add("search" to { z.nav.go(Screen.Search) })
        add("sync" to { z.nav.go(Screen.Sync) })
        add("settings" to { z.nav.go(Screen.Settings) })
    }
    Column(
        Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState())
            .padding(start = 20.dp, top = 84.dp, bottom = LocalBottomInset.current + 24.dp),
    ) {
        items.forEachIndexed { i, (label, go) ->
            ZText(
                label,
                Type.menu,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Visible,
                modifier = Modifier.featherIn(i, delayMs = 140).pressable(scaleTo = 0.94f, onClick = go).padding(vertical = 3.dp),
            )
        }
    }
}

private data class Tile(val key: String, val ref: Ref, val title: String, val sub: String?)

private fun tileFor(ref: Ref, lib: Library, playlists: List<Playlist>): Tile? = when (ref.type) {
    Ref.ALBUM -> lib.albumByKey[ref.id]?.let { Tile("a" + it.key, ref, it.title, it.artist) }
    Ref.ARTIST -> lib.artistByKey[ref.id]?.let { Tile("r" + it.key, ref, it.name, "artist") }
    Ref.DJ -> lib.artistByKey[ref.id]?.let { Tile("d" + it.key, ref, it.name, "smart dj") }
    Ref.GENRE -> lib.genreByKey[ref.id]?.let { Tile("g" + it.key, ref, it.name, "genre") }
    Ref.PLAYLIST -> playlists.firstOrNull { it.id == ref.id }?.let { Tile("p" + it.id, ref, it.name, "playlist") }
    else -> null
}

@Composable
private fun Quickplay(width: Dp) {
    val z = LocalZoon.current
    val graph = ZoonApp.graph
    val lib by graph.library.state.collectAsStateWithLifecycle()
    val user by z.store.state.collectAsStateWithLifecycle()
    val playlists by graph.playlists.collectAsStateWithLifecycle()
    val pins = user.pins.mapNotNull { tileFor(it, lib, playlists) }
    val history = user.history.mapNotNull { tileFor(it, lib, playlists) }.take(9)
    val new = lib.albums.sortedByDescending { it.added }.take(9).map { Tile("n" + it.key, Ref(Ref.ALBUM, it.key), it.title, it.artist) }

    Column(
        Modifier.width(width).fillMaxHeight().statusBarsPadding().verticalScroll(rememberScrollState())
            .padding(start = 18.dp, end = 18.dp, top = 30.dp, bottom = LocalBottomInset.current + 24.dp),
    ) {
        ZText("quickplay", Type.pivot, maxLines = 1)
        if (lib.loaded && lib.isEmpty) {
            EmptyCollection(Modifier.padding(start = 0.dp))
            return@Column
        }
        if (pins.isNotEmpty()) TileGroup("pins", pins, lib)
        if (history.isNotEmpty()) TileGroup("history", history, lib)
        if (new.isNotEmpty()) TileGroup("new", new, lib)
    }
}

@Composable
private fun TileGroup(title: String, tiles: List<Tile>, lib: Library) {
    SectionLabel(title)
    tiles.chunked(3).forEachIndexed { row, chunk ->
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            chunk.forEachIndexed { col, t -> QuickTile(t, lib, Modifier.weight(1f).featherIn(row * 3 + col, 200)) }
            repeat(3 - chunk.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}

@Composable
private fun QuickTile(t: Tile, lib: Library, modifier: Modifier) {
    val z = LocalZoon.current
    val accent = LocalAccent.current
    val open: () -> Unit = {
        when (t.ref.type) {
            Ref.ALBUM -> z.nav.go(Screen.AlbumPage(t.ref.id))
            Ref.ARTIST -> z.nav.go(Screen.ArtistPage(t.ref.id))
            Ref.DJ -> lib.artistByKey[t.ref.id]?.let { z.smartDj(it) }
            Ref.GENRE -> z.nav.go(Screen.GenrePage(t.ref.id))
            Ref.PLAYLIST -> z.nav.go(Screen.PlaylistPage(t.ref.id))
        }
    }
    val menu: () -> Unit = {
        when (t.ref.type) {
            Ref.ALBUM -> lib.albumByKey[t.ref.id]?.let { z.albumMenu(it) }
            Ref.ARTIST, Ref.DJ -> lib.artistByKey[t.ref.id]?.let { z.artistMenu(it) }
            Ref.PLAYLIST -> ZoonApp.graph.playlists.value.firstOrNull { it.id == t.ref.id }?.let { z.playlistMenu(it) }
            else -> z.togglePin(t.ref.type, t.ref.id, t.title)
        }
    }
    Box(modifier.aspectRatio(1f).background(Color(0xFF1A1A1A)).pressable(onLongClick = menu, onClick = open)) {
        when (t.ref.type) {
            Ref.ALBUM -> lib.albumByKey[t.ref.id]?.let { AlbumArt(it.toCover(), Modifier.fillMaxSize(), placeholderLabel = it.title) }
            Ref.ARTIST, Ref.DJ -> lib.artistByKey[t.ref.id]?.let { a ->
                a.albums.firstOrNull()?.let { AlbumArt(it.toCover(), Modifier.fillMaxSize()) }
                ArtistPhoto(a.name, Modifier.fillMaxSize())
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.4f to Color.Transparent, 1f to Color(0xCC000000))))
                Column(Modifier.align(Alignment.BottomStart).padding(7.dp)) {
                    if (t.ref.type == Ref.DJ) ZText("smart dj", Type.small, color = accent)
                    ZText(a.name, Type.sub, maxLines = 2)
                }
            }
            else -> Box(Modifier.fillMaxSize().background(accent).padding(8.dp)) {
                ZText(t.title, Type.body, maxLines = 3)
                ZText(t.sub ?: "", Type.small, color = Color(0xCCFFFFFF), modifier = Modifier.align(Alignment.BottomStart))
            }
        }
    }
}
