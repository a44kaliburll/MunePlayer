package app.muneplayer.ui

import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.muneplayer.AppGraph
import app.muneplayer.ui.components.LocalScreenStart
import app.muneplayer.ui.components.LocalUi
import app.muneplayer.ui.components.Overlays
import app.muneplayer.ui.components.UiHost
import app.muneplayer.ui.components.MuneEase
import app.muneplayer.ui.screens.AlbumScreen
import app.muneplayer.ui.screens.ArtistScreen
import app.muneplayer.ui.screens.GenreScreen
import app.muneplayer.ui.screens.HomeScreen
import app.muneplayer.ui.screens.MiniPlayer
import app.muneplayer.ui.screens.MusicScreen
import app.muneplayer.ui.screens.NowPlayingOverlay
import app.muneplayer.ui.screens.PlaylistScreen
import app.muneplayer.ui.screens.SearchScreen
import app.muneplayer.ui.screens.SettingsScreen
import app.muneplayer.ui.screens.SmartDjScreen
import app.muneplayer.ui.screens.SyncScreen
import app.muneplayer.ui.screens.WelcomeScreen
import app.muneplayer.ui.screens.YouTubeHomeScreen
import app.muneplayer.ui.screens.YouTubePlayerScreen
import app.muneplayer.ui.screens.YouTubePlaylistScreen
import app.muneplayer.ui.screens.YouTubeSetupScreen
import app.muneplayer.ui.theme.MuneTheme
import kotlin.math.abs

/** Space to leave at the bottom of scrolling pages (mini player + navigation bar). */
val LocalBottomInset = compositionLocalOf { 0.dp }

@Composable
fun MuneRoot(graph: AppGraph, nav: Nav) {
    val user by graph.store.state.collectAsStateWithLifecycle()
    val lib by graph.library.state.collectAsStateWithLifecycle()
    val permission by graph.library.permission.collectAsStateWithLifecycle()
    val playerState by graph.player.state.collectAsStateWithLifecycle()
    val ui = remember { UiHost() }
    val actions = remember { MuneActions(graph, nav, ui) }

    // "Resume where I left off": put the last queue back, paused.
    val restored = remember { mutableStateOf(false) }
    LaunchedEffect(lib.loaded, playerState.connected) {
        if (restored.value || !lib.loaded || !playerState.connected) return@LaunchedEffect
        restored.value = true
        val session = graph.store.data.session
        if (user.settings.resume && session != null && !playerState.hasQueue) graph.player.restore(session, lib.songByKey)
    }

    val navBar = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val inset: Dp = navBar + if (playerState.hasQueue) 72.dp else 12.dp

    MuneTheme(Color(user.settings.accent)) {
        CompositionLocalProvider(LocalUi provides ui, LocalMune provides actions, LocalBottomInset provides inset) {
            // Registered first so the overlays' and now playing's own back handlers win.
            BackHandler(enabled = nav.stack.size > 1) { nav.back() }
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                if (!permission || !user.settings.welcomed) {
                    WelcomeScreen(permission)
                } else {
                    Screens(nav)
                    // Lists scroll under a soft shade instead of colliding with the clock and battery.
                    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
                    Box(
                        Modifier.fillMaxWidth().height(top + 20.dp)
                            .background(Brush.verticalGradient(0f to Color(0xE6000000), 0.55f to Color(0xA0000000), 1f to Color.Transparent)),
                    )
                    MiniPlayer(Modifier.align(Alignment.BottomCenter))
                    NowPlayingOverlay()
                }
                Overlays(ui)
            }
        }
    }
}

@Composable
private fun Screens(nav: Nav) {
    val holder = rememberSaveableStateHolder()
    // Forget scroll positions of pages that were closed.
    LaunchedEffect(Unit) {
        snapshotFlow { nav.stack.size }.collect {
            val gone = nav.dropped.toList()
            nav.dropped.clear()
            gone.forEach { holder.removeState(it) }
        }
    }
    AnimatedContent(
        targetState = nav.top,
        transitionSpec = { fadeIn(tween(260, delayMillis = 70)) togetherWith fadeOut(tween(170)) using SizeTransform(clip = false) },
        contentKey = { it.id },
        label = "screens",
    ) { entry ->
        // The WP7/Zune turnstile: pages swing on a hinge at the left edge of the screen.
        val t by transition.animateFloat(transitionSpec = { tween(400, easing = MuneEase) }, label = "turn") { s ->
            when (s) {
                EnterExitState.PreEnter -> 1f
                EnterExitState.Visible -> 0f
                EnterExitState.PostExit -> -1f
            }
        }
        val forward = nav.forward
        val started = remember(entry.id) { SystemClock.uptimeMillis() }
        Box(
            Modifier.fillMaxSize().graphicsLayer {
                rotationY = if (t >= 0f) t * (if (forward) -62f else 38f) else -t * (if (forward) 38f else -62f)
                transformOrigin = TransformOrigin(0f, 0.5f)
                cameraDistance = 18f * density
                alpha = 1f - abs(t) * abs(t)
            },
        ) {
            CompositionLocalProvider(LocalScreenStart provides started) {
                holder.SaveableStateProvider(entry.id) { ScreenContent(entry.screen) }
            }
        }
    }
}

@Composable
private fun ScreenContent(screen: Screen) {
    when (screen) {
        Screen.Home -> HomeScreen()
        is Screen.Music -> MusicScreen(screen.page)
        is Screen.ArtistPage -> ArtistScreen(screen.key)
        is Screen.AlbumPage -> AlbumScreen(screen.key)
        is Screen.PlaylistPage -> PlaylistScreen(screen.id)
        is Screen.GenrePage -> GenreScreen(screen.key)
        Screen.Search -> SearchScreen()
        Screen.Settings -> SettingsScreen()
        Screen.Sync -> SyncScreen()
        Screen.SmartDj -> SmartDjScreen()
        is Screen.YouTubeHome -> YouTubeHomeScreen(screen.page, screen.query)
        is Screen.YouTubePlaylist -> YouTubePlaylistScreen(screen.id, screen.title)
        Screen.YouTubePlayer -> YouTubePlayerScreen()
        Screen.YouTubeSetup -> YouTubeSetupScreen()
    }
}
