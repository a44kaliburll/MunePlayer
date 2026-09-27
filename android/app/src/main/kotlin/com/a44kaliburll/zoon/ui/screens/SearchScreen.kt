package com.a44kaliburll.zoon.ui.screens

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.a44kaliburll.zoon.ZoonApp
import com.a44kaliburll.zoon.data.Library
import com.a44kaliburll.zoon.data.toCover
import com.a44kaliburll.zoon.ui.LocalBottomInset
import com.a44kaliburll.zoon.ui.LocalZoon
import com.a44kaliburll.zoon.ui.components.AlbumArt
import com.a44kaliburll.zoon.ui.components.ZIcon
import com.a44kaliburll.zoon.ui.components.ZText
import com.a44kaliburll.zoon.ui.components.featherIn
import com.a44kaliburll.zoon.ui.components.pressable
import com.a44kaliburll.zoon.ui.theme.LocalAccent
import com.a44kaliburll.zoon.ui.theme.Palette
import com.a44kaliburll.zoon.ui.theme.Type
import com.a44kaliburll.zoon.ui.theme.ZIcons
import com.a44kaliburll.zoon.util.norm

private class Results(val q: String, val artists: List<com.a44kaliburll.zoon.data.Artist>, val albums: List<com.a44kaliburll.zoon.data.Album>, val songs: List<com.a44kaliburll.zoon.data.Song>)

private fun search(lib: Library, text: String): Results? {
    val q = norm(text)
    if (q.isEmpty()) return null
    // Matches at the start of a word rank above matches in the middle.
    fun score(s: String): Int {
        val n = norm(s)
        return when {
            n.startsWith(q) -> 0
            n.contains(" $q") -> 1
            n.contains(q) -> 2
            else -> -1
        }
    }
    fun <T> rank(items: List<T>, name: (T) -> String, limit: Int) =
        items.map { it to score(name(it)) }.filter { it.second >= 0 }.sortedBy { it.second }.take(limit).map { it.first }
    return Results(
        text,
        rank(lib.artists, { it.name }, 6),
        rank(lib.albums, { it.title + " " + it.artist }, 10),
        rank(lib.songs, { it.title + " " + it.artist }, 60),
    )
}

@Composable
fun SearchScreen() {
    val z = LocalZoon.current
    val lib by ZoonApp.graph.library.state.collectAsStateWithLifecycle()
    var text by rememberSaveable { mutableStateOf("") }
    val results = remember(text, lib.version) { search(lib, text) }
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val nowKey = rememberNowKey()
    val accent = LocalAccent.current
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZText("search", Type.pivot, modifier = Modifier.padding(start = 18.dp, top = 12.dp))
        Row(
            Modifier.padding(horizontal = 18.dp, vertical = 8.dp).fillMaxWidth().border(1.dp, Palette.line).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ZIcon(ZIcons.search, tint = Palette.text2)
            Spacer(Modifier.width(10.dp))
            Box(Modifier.weight(1f)) {
                if (text.isEmpty()) ZText("artist, album or song", Type.item, color = Palette.text3)
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    textStyle = Type.item.copy(color = Palette.text),
                    cursorBrush = SolidColor(accent),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
            }
            if (text.isNotEmpty()) ZIcon(ZIcons.close, tint = Palette.text2, modifier = Modifier.pressable { text = "" })
        }
        val r = results
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = LocalBottomInset.current + 24.dp)) {
            if (r == null) {
                item { ZText("Type to search your collection.", Type.body, color = Palette.text3, modifier = Modifier.padding(top = 12.dp)) }
                return@LazyColumn
            }
            if (r.artists.isEmpty() && r.albums.isEmpty() && r.songs.isEmpty()) {
                item { ZText("Nothing matches “${r.q}”.", Type.body, color = Palette.text3, modifier = Modifier.padding(top = 12.dp)) }
            }
            if (r.artists.isNotEmpty()) {
                item { SectionLabel("artists") }
                itemsIndexed(r.artists, key = { _, a -> "a" + a.key }) { i, a ->
                    ZText(a.name, Type.itemLarge, maxLines = 1, modifier = Modifier.fillMaxWidth().featherIn(i).pressable(onLongClick = { z.artistMenu(a) }) { z.openArtist(a.key) }.padding(vertical = 5.dp))
                }
            }
            if (r.albums.isNotEmpty()) {
                item { SectionLabel("albums") }
                items(r.albums, key = { "l" + it.key }) { a ->
                    Row(Modifier.fillMaxWidth().pressable(onLongClick = { z.albumMenu(a) }) { z.openAlbum(a) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        AlbumArt(a.toCover(), Modifier.size(52.dp))
                        Spacer(Modifier.width(12.dp))
                        Column {
                            ZText(a.title, Type.item, maxLines = 1)
                            ZText(a.artist, Type.sub, color = Palette.text3, maxLines = 1)
                        }
                    }
                }
            }
            if (r.songs.isNotEmpty()) {
                item { SectionLabel("songs") }
                itemsIndexed(r.songs, key = { _, s -> "s" + s.key }) { i, s ->
                    SongRow(s, nowKey, detail = "${s.artist} · ${s.album}") { z.play(r.songs, i) }
                }
            }
        }
    }
}
