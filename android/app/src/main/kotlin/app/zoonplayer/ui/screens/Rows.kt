package app.zoonplayer.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import app.zoonplayer.ZoonApp
import app.zoonplayer.data.Album
import app.zoonplayer.data.Artist
import app.zoonplayer.data.HATE
import app.zoonplayer.data.LOVE
import app.zoonplayer.data.Song
import app.zoonplayer.data.toCover
import app.zoonplayer.ui.LocalZoon
import app.zoonplayer.ui.Screen
import app.zoonplayer.ui.components.ActionLink
import app.zoonplayer.ui.components.AlbumArt
import app.zoonplayer.ui.components.EqBars
import app.zoonplayer.ui.components.ZIcon
import app.zoonplayer.ui.components.ZText
import app.zoonplayer.ui.components.pressable
import app.zoonplayer.ui.theme.LocalAccent
import app.zoonplayer.ui.theme.Palette
import app.zoonplayer.ui.theme.Type
import app.zoonplayer.ui.theme.ZIcons
import app.zoonplayer.util.fmtTime

/** The key of the song that's playing (read once per list, not per row). */
@Composable
fun rememberNowKey(): String? {
    val state by LocalZoon.current.player.state.collectAsStateWithLifecycle()
    return state.key
}

@Composable
fun rememberIsPlaying(): Boolean {
    val state by LocalZoon.current.player.state.collectAsStateWithLifecycle()
    return state.isPlaying
}

/** A page's big lowercase title. Pass indent = false inside lists that already pad their content. */
@Composable
fun PageTitle(text: String, modifier: Modifier = Modifier, indent: Boolean = true) {
    ZText(
        text, Type.pivot,
        modifier = modifier.statusBarsPadding().padding(start = if (indent) 18.dp else 0.dp, top = 12.dp, bottom = 4.dp),
        maxLines = 1, softWrap = false, overflow = TextOverflow.Clip,
    )
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    ZText(text, Type.label, color = Palette.text2, modifier = modifier.padding(top = 22.dp, bottom = 8.dp))
}

/** A song in a list: title, then artist/album in grey; the playing song glows in the accent colour. */
@Composable
fun SongRow(
    song: Song,
    nowKey: String?,
    modifier: Modifier = Modifier,
    number: Int? = null,
    detail: String? = "${song.artist}",
    showDuration: Boolean = false,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    val z = LocalZoon.current
    val user by z.store.state.collectAsStateWithLifecycle()
    val playing = song.key == nowKey
    val accent = LocalAccent.current
    val rating = user.ratings[song.key]
    Row(
        modifier.fillMaxWidth().pressable(onLongClick = onLongClick ?: { z.songMenu(song) }, onClick = onClick).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (number != null) {
            ZText(number.toString(), Type.item, color = if (playing) accent else Palette.text3, modifier = Modifier.width(36.dp))
        }
        Column(Modifier.weight(1f)) {
            ZText(song.title, Type.item, color = if (playing) accent else Palette.text, maxLines = 1)
            if (detail != null) ZText(detail, Type.sub, color = Palette.text3, maxLines = 1)
        }
        if (rating == LOVE) ZIcon(ZIcons.heartFilled, tint = accent, size = 16.dp, modifier = Modifier.padding(start = 8.dp))
        if (rating == HATE) ZIcon(ZIcons.heartBroken, tint = Palette.text3, size = 16.dp, modifier = Modifier.padding(start = 8.dp))
        if (playing) {
            Spacer(Modifier.width(10.dp))
            EqBars(rememberIsPlaying())
        }
        if (showDuration && song.durationMs > 0) {
            ZText(fmtTime(song.durationMs), Type.sub, color = Palette.text3, modifier = Modifier.padding(start = 12.dp))
        }
    }
}

/** Windows Phone-style jump tile: tap to see the whole alphabet. */
@Composable
fun LetterTile(letter: Char, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val accent = LocalAccent.current
    Box(modifier.padding(top = 10.dp, bottom = 6.dp)) {
        Box(
            Modifier.size(46.dp).border(1.6.dp, accent).pressable(scaleTo = 0.9f, onClick = onClick),
            contentAlignment = Alignment.BottomStart,
        ) {
            ZText(letter.toString(), Type.title.copy(fontSize = Type.title.fontSize * 0.9f), color = accent, modifier = Modifier.padding(start = 6.dp, bottom = 2.dp))
        }
    }
}

@Composable
fun AlbumTile(album: Album, modifier: Modifier = Modifier, artSize: Dp? = null) {
    val z = LocalZoon.current
    Column(modifier.pressable(onLongClick = { z.albumMenu(album) }) { z.openAlbum(album) }) {
        AlbumArt(album.toCover(), if (artSize != null) Modifier.size(artSize) else Modifier.fillMaxWidth().aspectRatio(1f), placeholderLabel = album.title)
        Spacer(Modifier.height(6.dp))
        ZText(album.title, Type.body, maxLines = 1, modifier = if (artSize != null) Modifier.width(artSize) else Modifier)
        ZText(album.artist, Type.sub, color = Palette.text3, maxLines = 1, modifier = if (artSize != null) Modifier.width(artSize) else Modifier)
    }
}

/** An artist's big Deezer photo (when online photos are on). */
@Composable
fun ArtistPhoto(name: String, modifier: Modifier = Modifier, alpha: Float = 1f) {
    val online = ZoonApp.graph.online
    val url by produceState(online.cachedPhoto(name), name) { value = online.artistPhoto(name) }
    if (url != null) {
        AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, alpha = alpha, modifier = modifier)
    }
}

/** Square artist tile: photo (or the first album's art) with the name over a shade. */
@Composable
fun ArtistTile(artist: Artist, modifier: Modifier = Modifier, label: String? = null, onClick: (() -> Unit)? = null) {
    val z = LocalZoon.current
    Box(
        modifier.aspectRatio(1f).background(Color(0xFF1A1A1A))
            .pressable(onLongClick = { z.artistMenu(artist) }) { onClick?.invoke() ?: z.openArtist(artist.key) },
    ) {
        artist.albums.firstOrNull()?.let { AlbumArt(it.toCover(), Modifier.fillMaxSize()) }
        ArtistPhoto(artist.name, Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Color(0xCC000000))))
        Column(Modifier.align(Alignment.BottomStart).padding(10.dp)) {
            if (label != null) ZText(label, Type.small, color = LocalAccent.current)
            ZText(artist.name, Type.item, maxLines = 2)
        }
    }
}

@Composable
fun EmptyCollection(modifier: Modifier = Modifier) {
    val z = LocalZoon.current
    Column(modifier.padding(horizontal = 22.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ZText("your collection is empty", Type.title)
        ZText(
            "Sync music from Zoon Player on your PC over Wi‑Fi, or copy songs into the Music folder on your phone. They show up here on their own.",
            Type.body, color = Palette.text2,
        )
        ActionLink("sync with my pc", ZIcons.sync, onClick = { z.nav.go(Screen.Sync) }, accent = true)
    }
}

@Composable
fun MissingPage(what: String) {
    Column(Modifier.fillMaxSize().statusBarsPadding().padding(22.dp)) {
        ZText(what, Type.title)
        ZText("It isn't in your collection anymore.", Type.body, color = Palette.text2)
    }
}
