package app.muneplayer.ui.screens

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.muneplayer.MuneApp
import app.muneplayer.data.UNKNOWN_ARTIST
import app.muneplayer.data.VARIOUS_ARTISTS
import app.muneplayer.ui.LocalBottomInset
import app.muneplayer.ui.LocalMune
import app.muneplayer.ui.components.ActionLink
import app.muneplayer.ui.components.ZText
import app.muneplayer.ui.components.featherIn
import app.muneplayer.ui.theme.Palette
import app.muneplayer.ui.theme.Type
import app.muneplayer.ui.theme.ZIcons

/** Pick an artist and Smart DJ builds a mix around them. Most-played artists come first. */
@Composable
fun SmartDjScreen() {
    val z = LocalMune.current
    val lib by MuneApp.graph.library.state.collectAsStateWithLifecycle()
    val user by z.store.state.collectAsStateWithLifecycle()
    val artists = remember(lib.version, user.plays.size) {
        lib.artists.filter { it.name != UNKNOWN_ARTIST && it.name != VARIOUS_ARTISTS }
            .sortedByDescending { a -> a.songs.sumOf { user.plays[it.key] ?: 0 } * 10 + a.songCount }
    }
    LazyVerticalGrid(
        columns = GridCells.Fixed(2),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = LocalBottomInset.current + 24.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.statusBarsPadding().padding(top = 12.dp, bottom = 8.dp)) {
                ZText("smart dj", Type.pivot)
                ZText("Pick an artist. Mune mixes in related artists and similar music you have.", Type.body, color = Palette.text2)
            }
        }
        if (lib.loaded && artists.isEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) { EmptyCollection() }
        }
        itemsIndexed(artists, key = { _, a -> a.key }) { i, a ->
            ArtistTile(a, Modifier.featherIn(i), label = "smart dj") { z.smartDj(a) }
        }
    }
}

/** First run: the Mune gradient, a big "welcome", and the permissions the app needs. */
@Composable
fun WelcomeScreen(hasPermission: Boolean) {
    val z = LocalMune.current
    val graph = MuneApp.graph
    val perms = buildList {
        add(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        graph.library.permissionChanged()
        z.store.updateSettings { it.copy(welcomed = true) }
    }
    val flow = rememberInfiniteTransition(label = "welcome")
    val d by flow.animateFloat(0f, 1f, infiniteRepeatable(tween(9000, easing = LinearEasing), RepeatMode.Reverse), label = "d")
    Box(Modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize().blur(70.dp)) {
            drawCircle(
                Brush.radialGradient(listOf(Palette.pink, Color.Transparent), center = Offset(size.width * (0.1f + 0.6f * d), size.height * 0.25f), radius = size.width),
                radius = size.width, center = Offset(size.width * (0.1f + 0.6f * d), size.height * 0.25f),
            )
            drawCircle(
                Brush.radialGradient(listOf(Palette.orange, Color.Transparent), center = Offset(size.width * (0.95f - 0.5f * d), size.height * 0.8f), radius = size.width * 0.9f),
                radius = size.width * 0.9f, center = Offset(size.width * (0.95f - 0.5f * d), size.height * 0.8f),
            )
        }
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(24.dp),
            verticalArrangement = Arrangement.Bottom,
        ) {
            ZText("welcome", Type.hero.copy(fontSize = Type.hero.fontSize * 1.3f), modifier = Modifier.featherIn(0))
            Spacer(Modifier.height(10.dp))
            ZText(
                if (hasPermission) "Mune plays the music on your phone and syncs with Mune Player on your PC."
                else "Mune plays the music on your phone and syncs with Mune Player on your PC. First it needs your OK to see your music.",
                Type.item, color = Color(0xE6FFFFFF), modifier = Modifier.featherIn(1),
            )
            Spacer(Modifier.height(18.dp))
            ActionLink(if (hasPermission) "let's go" else "allow and start", ZIcons.play, onClick = { ask.launch(perms.toTypedArray()) }, modifier = Modifier.featherIn(2))
            if (!hasPermission) {
                ZText(
                    "If Android stops asking, turn on Music and audio for Mune in the app's settings.",
                    Type.sub, color = Color(0x99FFFFFF), modifier = Modifier.fillMaxWidth().padding(top = 10.dp).featherIn(3),
                )
            }
            Spacer(Modifier.height(30.dp))
        }
    }
}
