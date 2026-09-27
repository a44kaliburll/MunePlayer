package app.muneplayer.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.muneplayer.MuneApp
import app.muneplayer.data.Library
import app.muneplayer.ui.LocalBottomInset
import app.muneplayer.ui.LocalMune
import app.muneplayer.ui.Screen
import app.muneplayer.ui.components.ActionLink
import app.muneplayer.ui.components.JumpRequest
import app.muneplayer.ui.components.LocalUi
import app.muneplayer.ui.components.PivotHeader
import app.muneplayer.ui.components.ZText
import app.muneplayer.ui.components.featherIn
import app.muneplayer.ui.components.pressable
import app.muneplayer.ui.theme.Palette
import app.muneplayer.ui.theme.Type
import app.muneplayer.ui.theme.ZIcons
import app.muneplayer.util.letterOf
import app.muneplayer.util.plural
import kotlinx.coroutines.launch

private val PIVOTS = listOf("artists", "albums", "songs", "playlists", "genres")

/** Collection > music: the pivot of artists, albums, songs, playlists and genres. */
@Composable
fun MusicScreen(initialPage: Int) {
    val pager = rememberPagerState(initialPage) { PIVOTS.size }
    val lib by MuneApp.graph.library.state.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Spacer(Modifier.height(14.dp))
        PivotHeader(PIVOTS, pager)
        HorizontalPager(pager, Modifier.weight(1f), beyondViewportPageCount = 1) { page ->
            if (lib.loaded && lib.isEmpty && page != 3) {
                EmptyCollection()
            } else {
                when (page) {
                    0 -> ArtistsList(lib)
                    1 -> AlbumsGrid(lib)
                    2 -> SongsList(lib)
                    3 -> PlaylistsList()
                    else -> GenresList(lib)
                }
            }
        }
    }
}

/** Rows of a lettered list: jump tiles, then the items under each letter. */
private sealed interface LRow<out T> {
    data class Header(val letter: Char) : LRow<Nothing>
    data class Item<T>(val value: T) : LRow<T>
}

private fun <T> lettered(items: List<T>, name: (T) -> String): List<LRow<T>> {
    val out = ArrayList<LRow<T>>(items.size + 27)
    var last: Char? = null
    for (it in items) {
        val l = letterOf(name(it))
        if (l != last) {
            out += LRow.Header(l)
            last = l
        }
        out += LRow.Item(it)
    }
    return out
}

@Composable
private fun <T> jumpTo(rows: List<LRow<T>>, state: LazyListState, offset: Int = 0): (Char) -> Unit {
    val scope = rememberCoroutineScope()
    return { letter ->
        val i = rows.indexOfFirst { it is LRow.Header && it.letter == letter }
        if (i >= 0) scope.launch { state.animateScrollToItem(i + offset) }
    }
}

@Composable
private fun listPadding() = PaddingValues(start = 18.dp, end = 18.dp, top = 6.dp, bottom = LocalBottomInset.current + 24.dp)

@Composable
private fun ArtistsList(lib: Library) {
    val z = LocalMune.current
    val ui = LocalUi.current
    val state = rememberLazyListState()
    val rows = remember(lib.version) { lettered(lib.artists) { it.name } }
    val letters = remember(rows) { rows.filterIsInstance<LRow.Header>().map { it.letter }.toSet() }
    val jump = jumpTo(rows, state)
    LazyColumn(Modifier.fillMaxSize(), state, contentPadding = listPadding()) {
        itemsIndexed(rows, key = { _, r -> if (r is LRow.Header) "h${r.letter}" else "a${(r as LRow.Item).value.key}" }) { i, r ->
            when (r) {
                is LRow.Header -> LetterTile(r.letter, Modifier.featherIn(i)) { ui.jump = JumpRequest(letters, jump) }
                is LRow.Item -> {
                    val a = r.value
                    Column(Modifier.fillMaxWidth().featherIn(i).pressable(onLongClick = { z.artistMenu(a) }) { z.openArtist(a.key) }.padding(vertical = 6.dp)) {
                        ZText(a.name, Type.itemLarge, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun AlbumsGrid(lib: Library) {
    val ui = LocalUi.current
    val state: LazyGridState = rememberLazyGridState()
    val scope = rememberCoroutineScope()
    val rows = remember(lib.version) { lettered(lib.albums) { it.title } }
    val letters = remember(rows) { rows.filterIsInstance<LRow.Header>().map { it.letter }.toSet() }
    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        state = state,
        modifier = Modifier.fillMaxSize(),
        contentPadding = listPadding(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        rows.forEachIndexed { i, r ->
            when (r) {
                is LRow.Header -> item(key = "h${r.letter}", span = { GridItemSpan(maxLineSpan) }) {
                    LetterTile(r.letter, Modifier.featherIn(i)) {
                        ui.jump = JumpRequest(letters) { letter ->
                            val idx = rows.indexOfFirst { it is LRow.Header && it.letter == letter }
                            if (idx >= 0) scope.launch { state.animateScrollToItem(idx) }
                        }
                    }
                }
                is LRow.Item -> item(key = "a${r.value.key}") { AlbumTile(r.value, Modifier.featherIn(i)) }
            }
        }
    }
}

@Composable
private fun SongsList(lib: Library) {
    val z = LocalMune.current
    val ui = LocalUi.current
    val state = rememberLazyListState()
    val nowKey = rememberNowKey()
    val rows = remember(lib.version) { lettered(lib.songs) { it.title } }
    val letters = remember(rows) { rows.filterIsInstance<LRow.Header>().map { it.letter }.toSet() }
    val index = remember(lib.version) { lib.songs.withIndex().associate { it.value.key to it.index } }
    val jump = jumpTo(rows, state, offset = 1)
    LazyColumn(Modifier.fillMaxSize(), state, contentPadding = listPadding()) {
        item(key = "shuffle") {
            ActionLink("shuffle all (${lib.songs.size})", ZIcons.shuffle, onClick = { z.play(lib.songs, shuffle = true, open = true) }, accent = true, modifier = Modifier.featherIn(0))
        }
        itemsIndexed(rows, key = { _, r -> if (r is LRow.Header) "h${r.letter}" else "s${(r as LRow.Item).value.key}" }) { i, r ->
            when (r) {
                is LRow.Header -> LetterTile(r.letter, Modifier.featherIn(i + 1)) { ui.jump = JumpRequest(letters, jump) }
                is LRow.Item -> SongRow(r.value, nowKey, Modifier.featherIn(i + 1), detail = "${r.value.artist} · ${r.value.album}") {
                    z.play(lib.songs, index[r.value.key] ?: 0)
                }
            }
        }
    }
}

@Composable
private fun PlaylistsList() {
    val z = LocalMune.current
    val playlists by MuneApp.graph.playlists.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = listPadding()) {
        item(key = "new") { ActionLink("new playlist", ZIcons.plus, onClick = { z.newPlaylist() }, accent = true, modifier = Modifier.featherIn(0)) }
        if (playlists.isEmpty()) {
            item(key = "none") {
                ZText("Make playlists here, or sync them from your PC.", Type.body, color = Palette.text2, modifier = Modifier.padding(top = 12.dp).featherIn(1))
            }
        }
        itemsIndexed(playlists, key = { _, p -> p.id }) { i, p ->
            Column(Modifier.fillMaxWidth().featherIn(i + 1).pressable(onLongClick = { z.playlistMenu(p) }) { z.nav.go(Screen.PlaylistPage(p.id)) }.padding(vertical = 7.dp)) {
                ZText(p.name, Type.itemLarge, maxLines = 1)
                ZText(
                    plural(p.songKeys.size, "song") + if (p.pcId != null) " · from your pc" else "",
                    Type.sub, color = Palette.text3,
                )
            }
        }
    }
}

@Composable
private fun GenresList(lib: Library) {
    val z = LocalMune.current
    LazyColumn(Modifier.fillMaxSize(), contentPadding = listPadding()) {
        itemsIndexed(lib.genres, key = { _, g -> g.key }) { i, g ->
            Column(Modifier.fillMaxWidth().featherIn(i).pressable { z.nav.go(Screen.GenrePage(g.key)) }.padding(vertical = 7.dp)) {
                ZText(g.name.lowercase(), Type.itemLarge, maxLines = 1)
                ZText("${plural(g.albums.size, "album")} · ${plural(g.songCount, "song")}", Type.sub, color = Palette.text3)
            }
        }
    }
}
