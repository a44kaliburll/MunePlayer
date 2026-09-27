package com.a44kaliburll.zoon.ui.screens

import android.graphics.Bitmap
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.MarqueeAnimationMode
import androidx.compose.foundation.MarqueeSpacing
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import androidx.palette.graphics.Palette as ColorPalette
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.toBitmap
import com.a44kaliburll.zoon.ZoonApp
import com.a44kaliburll.zoon.data.Cover
import com.a44kaliburll.zoon.data.HATE
import com.a44kaliburll.zoon.data.LOVE
import com.a44kaliburll.zoon.data.Song
import com.a44kaliburll.zoon.data.UNKNOWN_ARTIST
import com.a44kaliburll.zoon.data.VARIOUS_ARTISTS
import com.a44kaliburll.zoon.data.toCover
import com.a44kaliburll.zoon.ui.LocalZoon
import com.a44kaliburll.zoon.ui.components.AlbumArt
import com.a44kaliburll.zoon.ui.components.CircleButton
import com.a44kaliburll.zoon.ui.components.EqBars
import com.a44kaliburll.zoon.ui.components.ZIcon
import com.a44kaliburll.zoon.ui.components.ZText
import com.a44kaliburll.zoon.ui.components.ZoonEase
import com.a44kaliburll.zoon.ui.components.pressable
import com.a44kaliburll.zoon.ui.components.rememberPulse
import com.a44kaliburll.zoon.ui.theme.LocalAccent
import com.a44kaliburll.zoon.ui.theme.Palette
import com.a44kaliburll.zoon.ui.theme.Type
import com.a44kaliburll.zoon.ui.theme.ZIcons
import com.a44kaliburll.zoon.util.fmtTime
import com.a44kaliburll.zoon.util.plural
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.abs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ------------------------------------------------------------------ mini player

/** The strip along the bottom: what's playing, a thin progress line, play/pause. Swipe to skip. */
@Composable
fun MiniPlayer(modifier: Modifier = Modifier) {
    val z = LocalZoon.current
    val state by z.player.state.collectAsStateWithLifecycle()
    val lib by ZoonApp.graph.library.state.collectAsStateWithLifecycle()
    val song = state.key?.let { lib.songByKey[it] }
    val accent = LocalAccent.current
    val scope = rememberCoroutineScope()
    val drag = remember { Animatable(0f) }
    AnimatedVisibility(
        song != null && !z.nav.nowPlaying,
        modifier = modifier,
        enter = slideInVertically(tween(360, easing = ZoonEase)) { it } + fadeIn(),
        exit = slideOutVertically(tween(260)) { it } + fadeOut(),
    ) {
        val s = song ?: return@AnimatedVisibility
        Column(Modifier.fillMaxWidth().background(Color(0xFF0B0B0B)).navigationBarsPadding()) {
            ProgressLine(state.durationMs, accent)
            Row(
                Modifier.fillMaxWidth().height(62.dp)
                    .pointerInput(Unit) {
                        detectHorizontalDragGestures(
                            onDragEnd = {
                                val v = drag.value
                                scope.launch {
                                    if (abs(v) > size.width * 0.22f) {
                                        if (v < 0) z.player.next() else z.player.previous()
                                    }
                                    drag.animateTo(0f, spring(dampingRatio = 0.7f))
                                }
                            },
                        ) { change, dx ->
                            change.consume()
                            scope.launch { drag.snapTo(drag.value + dx) }
                        }
                    }
                    .pressable(scaleTo = 0.985f) { z.nav.nowPlaying = true }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    Modifier.weight(1f).graphicsLayer {
                        translationX = drag.value
                        alpha = 1f - (abs(drag.value) / size.width).coerceIn(0f, 0.7f)
                    },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AlbumArt(s.toCover(), Modifier.size(44.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        ZText(s.title, Type.body, maxLines = 1)
                        ZText(s.artist, Type.sub, color = Palette.text3, maxLines = 1)
                    }
                }
                CircleButton(if (state.playWhenReady) ZIcons.pause else ZIcons.play, onClick = { z.player.toggle() }, size = 42.dp)
            }
        }
    }
}

@Composable
private fun ProgressLine(durationMs: Long, color: Color) {
    val player = LocalZoon.current.player
    var fraction by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(durationMs) {
        while (true) {
            withFrameNanos { }
            fraction = if (durationMs > 0) (player.positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
            delay(200)
        }
    }
    Canvas(Modifier.fillMaxWidth().height(2.dp)) {
        drawRect(Color(0x22FFFFFF))
        drawRect(color, size = Size(size.width * fraction, size.height))
    }
}

// ------------------------------------------------------------------ now playing

/**
 * Now playing, Zune HD style: the artist's photo fills the screen and drifts, their name
 * scrolls past in enormous letters, the album art flips when the album changes, and the
 * glow at the bottom pulses with the music. Controls fade away after a few seconds; tap to
 * bring them back. Swipe the art to skip, swipe down (or back) to close.
 */
@Composable
fun NowPlayingOverlay() {
    val z = LocalZoon.current
    val open = z.nav.nowPlaying
    val progress = remember { Animatable(0f) }
    LaunchedEffect(open) {
        progress.animateTo(if (open) 1f else 0f, tween(if (open) 460 else 340, easing = ZoonEase))
    }
    PredictiveBackHandler(enabled = open && !z.nav.queueOpen) { events ->
        try {
            events.collect { e -> progress.snapTo(1f - e.progress * 0.35f) }
            z.nav.nowPlaying = false
        } catch (e: CancellationException) {
            progress.animateTo(1f, tween(200))
        }
    }
    if (progress.value <= 0.001f) return
    Box(
        Modifier.fillMaxSize().graphicsLayer {
            val p = progress.value
            translationY = (1f - p) * size.height * 0.28f
            alpha = p.coerceIn(0f, 1f)
            val sc = 0.9f + 0.1f * p
            scaleX = sc
            scaleY = sc
        },
    ) {
        NowPlayingContent()
        QueuePanel()
    }
}

@Composable
private fun NowPlayingContent() {
    val z = LocalZoon.current
    val graph = ZoonApp.graph
    val state by z.player.state.collectAsStateWithLifecycle()
    val lib by graph.library.state.collectAsStateWithLifecycle()
    val user by z.store.state.collectAsStateWithLifecycle()
    val song = state.key?.let { lib.songByKey[it] }
    val accent = LocalAccent.current
    val glow = rememberArtColor(song?.toCover(), accent)
    val pulse by rememberPulse(graph.levels, state.isPlaying && z.nav.nowPlaying)
    var controls by remember { mutableStateOf(true) }
    var touch by remember { mutableIntStateOf(0) }
    val controlsAlpha by animateFloatAsState(if (controls) 1f else 0f, tween(500), label = "controls")
    val scope = rememberCoroutineScope()
    val dragDown = remember { Animatable(0f) }

    // Zune HD dimmed its controls after a while so only the art and the names remained.
    LaunchedEffect(controls, touch, state.isPlaying) {
        if (controls && state.isPlaying) {
            delay(7000)
            controls = false
        }
    }
    val view = LocalView.current
    DisposableEffect(user.settings.keepScreenOn) {
        view.keepScreenOn = user.settings.keepScreenOn
        onDispose { view.keepScreenOn = false }
    }

    Box(
        Modifier.fillMaxSize().background(Color.Black)
            .pointerInput(Unit) {
                detectTapGestures {
                    controls = !controls
                    touch++
                }
            }
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragEnd = {
                        scope.launch {
                            if (dragDown.value > size.height * 0.18f) z.nav.nowPlaying = false
                            dragDown.animateTo(0f, spring(dampingRatio = 0.8f))
                        }
                    },
                ) { change, dy ->
                    change.consume()
                    scope.launch { dragDown.snapTo((dragDown.value + dy).coerceAtLeast(0f)) }
                }
            }
            .graphicsLayer { translationY = dragDown.value * 0.6f },
    ) {
        if (song == null) {
            Column(Modifier.align(Alignment.Center).padding(24.dp)) {
                ZText("nothing playing", Type.title)
                ZText("Pick something from your collection.", Type.body, color = Palette.text2)
            }
            return@Box
        }
        Backdrop(song, glow, pulse, user.settings.background != "black")
        GiantWords(song)
        BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            val w = maxWidth
            val h = maxHeight
            val landscape = w > h
            if (landscape) {
                Row(Modifier.fillMaxSize().padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
                    ArtCard(song, (h - 40.dp).coerceAtMost(420.dp), glow, pulse, user.ratings[song.key])
                    Spacer(Modifier.width(28.dp))
                    Column(Modifier.weight(1f)) {
                        SongInfo(song, state.index, state.count)
                        Spacer(Modifier.height(16.dp))
                        Controls(state.durationMs, state.playWhenReady, state.shuffle, state.repeat, song, user.ratings[song.key], 1f) { touch++ }
                    }
                }
            } else {
                Column(Modifier.fillMaxSize().padding(horizontal = 22.dp)) {
                    TopBar(state.index, state.count, controlsAlpha)
                    Spacer(Modifier.weight(1f))
                    ArtCard(song, (w - 44.dp).coerceAtMost(420.dp), glow, pulse, user.ratings[song.key], idle = 1f - controlsAlpha)
                    Spacer(Modifier.height(22.dp))
                    SongInfo(song, state.index, state.count)
                    Spacer(Modifier.height(14.dp))
                    Controls(state.durationMs, state.playWhenReady, state.shuffle, state.repeat, song, user.ratings[song.key], controlsAlpha) {
                        controls = true
                        touch++
                    }
                    Spacer(Modifier.height(10.dp))
                }
            }
        }
        // While the controls are hidden, the first tap anywhere only wakes them up.
        if (!controls) {
            Box(
                Modifier.fillMaxSize().pointerInput(Unit) {
                    detectTapGestures {
                        controls = true
                        touch++
                    }
                },
            )
        }
    }
}

@Composable
private fun TopBar(index: Int, count: Int, alpha: Float) {
    val z = LocalZoon.current
    Row(Modifier.fillMaxWidth().padding(top = 10.dp).graphicsLayer { this.alpha = 0.35f + 0.65f * alpha }, verticalAlignment = Alignment.CenterVertically) {
        ZIcon(ZIcons.down, tint = Palette.text2, modifier = Modifier.pressable { z.nav.nowPlaying = false })
        Spacer(Modifier.width(10.dp))
        ZText("now playing", Type.label, color = Palette.text2)
        if (count > 0) ZText("  ${index + 1} of $count", Type.label, color = Palette.text3)
        Spacer(Modifier.weight(1f))
        ZIcon(ZIcons.queue, tint = Palette.text, modifier = Modifier.pressable { z.nav.queueOpen = true })
    }
}

/** The dominant, lively colour of the album art, for the glow. */
@Composable
private fun rememberArtColor(cover: Cover?, fallback: Color): Color {
    val context = LocalContext.current
    val color by produceState(fallback, cover?.albumKey) {
        if (cover == null) return@produceState
        value = withContext(Dispatchers.Default) {
            runCatching {
                val req = ImageRequest.Builder(context).data(cover).size(96).allowHardware(false).build()
                val bmp: Bitmap = ZoonApp.graph.imageLoader.execute(req).image?.toBitmap() ?: return@runCatching fallback
                val p = ColorPalette.from(bmp).generate()
                val argb = p.getVibrantColor(p.getLightVibrantColor(p.getDominantColor(fallback.toArgb())))
                Color(argb)
            }.getOrDefault(fallback)
        }
    }
    val anim by androidx.compose.animation.animateColorAsState(color, tween(900), label = "glow")
    return anim
}

@Composable
private fun Backdrop(song: Song, glow: Color, pulse: Float, photos: Boolean) {
    val drift = rememberInfiniteTransition(label = "kenburns")
    val k by drift.animateFloat(0f, 1f, infiniteRepeatable(tween(24000, easing = LinearEasing), RepeatMode.Reverse), label = "k")
    val online = ZoonApp.graph.online
    val artist = song.albumArtist
    val photo by produceState(if (photos) online.cachedPhoto(artist) else null, artist, photos) {
        value = if (photos && artist != UNKNOWN_ARTIST && artist != VARIOUS_ARTISTS) online.artistPhoto(artist) else null
    }
    AnimatedContent(targetState = photo to song.albumKey, transitionSpec = { fadeIn(tween(1200)) togetherWith fadeOut(tween(1200)) }, label = "backdrop") { (url, _) ->
        Box(
            Modifier.fillMaxSize().graphicsLayer {
                // Ken Burns: a slow push-in and pan across the photo.
                val s = 1.1f + 0.14f * k
                scaleX = s
                scaleY = s
                translationX = (k - 0.5f) * 70f * density
                translationY = (0.5f - k) * 26f * density
            },
        ) {
            if (url != null) {
                AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, alpha = 0.78f, modifier = Modifier.fillMaxSize())
            } else {
                AlbumArt(song.toCover(), Modifier.fillMaxSize().blur(38.dp).graphicsLayer { alpha = 0.55f })
            }
        }
    }
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color(0x66000000), 0.35f to Color(0x33000000), 0.62f to Color(0xAA000000), 1f to Color(0xF2000000))))
    Canvas(Modifier.fillMaxSize()) {
        drawRect(
            Brush.radialGradient(
                listOf(glow.copy(alpha = 0.22f + 0.5f * pulse), Color.Transparent),
                center = Offset(size.width * 0.5f, size.height * 1.02f),
                radius = size.width * (0.8f + 0.35f * pulse),
            ),
        )
    }
}

/** The artist, album and title drifting past at enormous sizes, like the Zune HD. */
@Composable
private fun GiantWords(song: Song) {
    AnimatedContent(targetState = song, transitionSpec = { fadeIn(tween(900, 300)) togetherWith fadeOut(tween(500)) }, contentKey = { it.key }, label = "words") { s ->
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val h = maxHeight
            MarqueeWords(s.albumArtist.lowercase(), 150.sp, 0.2f, 36.dp, Modifier.offset(y = 64.dp))
            MarqueeWords(s.album.lowercase(), 86.sp, 0.1f, 22.dp, Modifier.offset(y = h * 0.43f), reverse = true)
            MarqueeWords(s.title.lowercase(), 64.sp, 0.14f, 48.dp, Modifier.offset(y = h * 0.64f))
        }
    }
}

@Composable
private fun MarqueeWords(text: String, size: TextUnit, alpha: Float, speed: Dp, modifier: Modifier = Modifier, reverse: Boolean = false) {
    val line = List(4) { text }.joinToString("      ")
    val content = @Composable {
        ZText(
            line,
            Type.giant.copy(fontSize = size, lineHeight = size, letterSpacing = (-size.value * 0.03f).sp),
            color = Color.White.copy(alpha = alpha),
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Clip,
            modifier = modifier.fillMaxWidth().basicMarquee(
                iterations = Int.MAX_VALUE,
                animationMode = MarqueeAnimationMode.Immediately,
                repeatDelayMillis = 0,
                initialDelayMillis = 0,
                spacing = MarqueeSpacing(80.dp),
                velocity = speed,
            ),
        )
    }
    if (reverse) CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) { content() } else content()
}

/** Album art on a coloured glow. Flips over when the album changes; drag sideways to skip. */
@Composable
private fun ArtCard(song: Song, size: Dp, glow: Color, pulse: Float, rating: String?, idle: Float = 0f) {
    val z = LocalZoon.current
    val scope = rememberCoroutineScope()
    val drag = remember { Animatable(0f) }
    val flip = remember { Animatable(0f) }
    var shown by remember { mutableStateOf(song.toCover()) }
    LaunchedEffect(song.albumKey) {
        val next = song.toCover()
        if (next.albumKey == shown.albumKey) {
            shown = next
            return@LaunchedEffect
        }
        flip.animateTo(90f, tween(180))
        shown = next
        flip.snapTo(-90f)
        flip.animateTo(0f, tween(420, easing = ZoonEase))
    }
    // A heart that blooms over the art when you love a song.
    val heart = remember { Animatable(0f) }
    LaunchedEffect(rating) {
        if (rating == LOVE) {
            heart.snapTo(0.01f)
            heart.animateTo(1f, tween(700))
            heart.snapTo(0f)
        }
    }
    Box(
        Modifier.size(size).graphicsLayer {
            // Idle: the art shrinks into the corner and the artist photo takes over, like the Zune HD.
            transformOrigin = TransformOrigin(0f, 0f)
            val sc = 1f - 0.45f * idle
            scaleX = sc
            scaleY = sc
            translationY = -idle * 24f * density
        },
        contentAlignment = Alignment.Center,
    ) {
        // A soft halo in the art's own colour that swells with the beat.
        Canvas(Modifier.requiredSize(size * 1.7f)) {
            val c = glow.copy(alpha = 0.28f + 0.42f * pulse)
            drawRect(
                Brush.radialGradient(
                    0f to c, 0.42f to c.copy(alpha = c.alpha * 0.55f), 1f to Color.Transparent,
                    center = center, radius = this.size.minDimension / 2f,
                ),
            )
        }
        Box(
            Modifier.fillMaxSize()
                .pointerInput(song.key) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            val v = drag.value
                            scope.launch {
                                val w = this@pointerInput.size.width
                                if (abs(v) > w * 0.25f) {
                                    drag.animateTo(if (v < 0) -w * 1.1f else w * 1.1f, tween(180))
                                    if (v < 0) z.player.next() else z.player.previous()
                                    drag.snapTo(if (v < 0) w * 0.6f else -w * 0.6f)
                                }
                                drag.animateTo(0f, spring(dampingRatio = 0.75f, stiffness = 300f))
                            }
                        },
                    ) { change, dx ->
                        change.consume()
                        scope.launch { drag.snapTo(drag.value + dx) }
                    }
                }
                .graphicsLayer {
                    translationX = drag.value
                    rotationY = flip.value + (drag.value / size.toPx()) * -38f
                    cameraDistance = 26f * density
                    val beat = 1f + 0.012f * pulse
                    scaleX = beat
                    scaleY = beat
                    shadowElevation = 36f
                    ambientShadowColor = glow
                    spotShadowColor = glow
                },
        ) {
            AlbumArt(shown, Modifier.fillMaxSize(), placeholderLabel = song.album)
            if (heart.value > 0f) {
                val h = heart.value
                ZIcon(
                    ZIcons.heartFilled,
                    tint = LocalAccent.current,
                    size = size * 0.4f,
                    modifier = Modifier.align(Alignment.Center).graphicsLayer {
                        scaleX = 0.4f + 1.1f * h
                        scaleY = 0.4f + 1.1f * h
                        alpha = if (h < 0.5f) h * 2f else (1f - h) * 2f
                    },
                )
            }
        }
    }
}

@Composable
private fun SongInfo(song: Song, index: Int, count: Int) {
    val z = LocalZoon.current
    AnimatedContent(
        targetState = song,
        contentKey = { it.key },
        transitionSpec = { (fadeIn(tween(350, 120)) + slideInVertically(tween(420, easing = ZoonEase)) { it / 3 }) togetherWith fadeOut(tween(160)) },
        label = "info",
    ) { s ->
        Column {
            ZText(s.title, Type.title, maxLines = 2)
            ZText(
                s.artist,
                Type.item,
                color = LocalAccent.current,
                maxLines = 1,
                modifier = Modifier.pressable {
                    if (s.albumArtist != UNKNOWN_ARTIST && s.albumArtist != VARIOUS_ARTISTS) {
                        z.nav.nowPlaying = false
                        z.openArtist(s.artistKey)
                    }
                },
            )
            ZText(
                s.album,
                Type.body,
                color = Palette.text2,
                maxLines = 1,
                modifier = Modifier.pressable {
                    z.lib.albumByKey[s.albumKey]?.let {
                        z.nav.nowPlaying = false
                        z.openAlbum(it)
                    }
                },
            )
        }
    }
}

@Composable
private fun Controls(
    durationMs: Long,
    playing: Boolean,
    shuffle: Boolean,
    repeat: Int,
    song: Song,
    rating: String?,
    alpha: Float,
    poke: () -> Unit,
) {
    val z = LocalZoon.current
    val accent = LocalAccent.current
    Column(Modifier.fillMaxWidth().graphicsLayer { this.alpha = alpha }) {
        SeekBar(durationMs, accent, poke)
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            CircleButton(ZIcons.previous, { poke(); z.player.previous() }, size = 58.dp)
            CircleButton(if (playing) ZIcons.pause else ZIcons.play, { poke(); z.player.toggle() }, size = 82.dp, iconSize = 34.dp)
            CircleButton(ZIcons.next, { poke(); z.player.next() }, size = 58.dp)
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            SmallToggle(ZIcons.shuffle, shuffle, "shuffle") { poke(); z.player.setShuffle(!shuffle) }
            SmallToggle(if (repeat == Player.REPEAT_MODE_ONE) ZIcons.repeatOne else ZIcons.repeat, repeat != Player.REPEAT_MODE_OFF, "repeat") { poke(); z.player.cycleRepeat() }
            SmallToggle(
                when (rating) {
                    LOVE -> ZIcons.heartFilled
                    HATE -> ZIcons.heartBroken
                    else -> ZIcons.heart
                },
                rating == LOVE,
                when (rating) {
                    LOVE -> "loved"
                    HATE -> "disliked"
                    else -> "love"
                },
            ) {
                poke()
                z.store.cycleRating(song)
            }
            SmallToggle(ZIcons.dj, false, "smart dj") {
                poke()
                z.lib.artistByKey[song.artistKey]?.let { z.smartDj(it) }
            }
            SmallToggle(ZIcons.queue, false, "up next") {
                poke()
                z.nav.queueOpen = true
            }
        }
    }
}

@Composable
private fun SmallToggle(icon: androidx.compose.ui.graphics.vector.ImageVector, on: Boolean, label: String, onClick: () -> Unit) {
    val accent = LocalAccent.current
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.pressable(scaleTo = 0.88f, onClick = onClick).padding(4.dp)) {
        ZIcon(icon, tint = if (on) accent else Palette.text, size = 24.dp)
        ZText(label, Type.small, color = if (on) accent else Palette.text3, maxLines = 1)
    }
}

@Composable
private fun SeekBar(durationMs: Long, accent: Color, poke: () -> Unit) {
    val player = LocalZoon.current.player
    var pos by remember { mutableLongStateOf(player.positionMs) }
    var scrub by remember { mutableStateOf<Float?>(null) }
    LaunchedEffect(Unit) {
        while (true) {
            withFrameNanos { }
            pos = player.positionMs
        }
    }
    val frac = scrub ?: if (durationMs > 0) (pos.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
    Column {
        Canvas(
            Modifier.fillMaxWidth().height(30.dp)
                .pointerInput(durationMs) {
                    detectTapGestures { o ->
                        poke()
                        if (durationMs > 0) player.seekTo((o.x / size.width * durationMs).toLong())
                    }
                }
                .pointerInput(durationMs) {
                    detectHorizontalDragGestures(
                        onDragStart = { o -> scrub = (o.x / size.width).coerceIn(0f, 1f); poke() },
                        onDragEnd = {
                            scrub?.let { if (durationMs > 0) player.seekTo((it * durationMs).toLong()) }
                            scrub = null
                        },
                        onDragCancel = { scrub = null },
                    ) { change, _ ->
                        change.consume()
                        scrub = (change.position.x / size.width).coerceIn(0f, 1f)
                    }
                },
        ) {
            val y = size.height / 2
            drawLine(Color(0x33FFFFFF), Offset(0f, y), Offset(size.width, y), strokeWidth = 3.dp.toPx(), cap = StrokeCap.Round)
            drawLine(accent, Offset(0f, y), Offset(size.width * frac, y), strokeWidth = 3.dp.toPx(), cap = StrokeCap.Round)
            drawCircle(accent.copy(alpha = 0.35f), radius = (if (scrub != null) 14 else 9).dp.toPx(), center = Offset(size.width * frac, y))
            drawCircle(Color.White, radius = (if (scrub != null) 7 else 5).dp.toPx(), center = Offset(size.width * frac, y))
        }
        Row(Modifier.fillMaxWidth()) {
            ZText(fmtTime((frac * durationMs).toLong()), Type.small, color = Palette.text2)
            Spacer(Modifier.weight(1f))
            ZText("-" + fmtTime(durationMs - (frac * durationMs).toLong()), Type.small, color = Palette.text2)
        }
    }
}

// ------------------------------------------------------------------ up next

@Composable
private fun QueuePanel() {
    val z = LocalZoon.current
    val state by z.player.state.collectAsStateWithLifecycle()
    val lib by ZoonApp.graph.library.state.collectAsStateWithLifecycle()
    val keys = remember(state.queueVersion, state.connected) { z.player.queueKeys() }
    val list = rememberLazyListState()
    androidx.activity.compose.BackHandler(enabled = z.nav.queueOpen) { z.nav.queueOpen = false }
    LaunchedEffect(z.nav.queueOpen) {
        if (z.nav.queueOpen && state.index > 0) list.scrollToItem((state.index - 1).coerceAtLeast(0))
    }
    AnimatedVisibility(
        z.nav.queueOpen,
        enter = slideInVertically(tween(380, easing = ZoonEase)) { it } + fadeIn(),
        exit = slideOutVertically(tween(260)) { it } + fadeOut(),
    ) {
        Column(Modifier.fillMaxSize().background(Color(0xF5080808)).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                ZText("up next", Type.pivot, modifier = Modifier.weight(1f))
                ZIcon(ZIcons.close, modifier = Modifier.pressable { z.nav.queueOpen = false })
            }
            ZText(plural(keys.size, "song"), Type.sub, color = Palette.text3, modifier = Modifier.padding(start = 20.dp, bottom = 6.dp))
            LazyColumn(Modifier.fillMaxSize(), list, contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 24.dp)) {
                itemsIndexed(keys, key = { i, k -> "$i:$k" }) { i, k ->
                    val s = lib.songByKey[k] ?: return@itemsIndexed
                    val current = i == state.index
                    Row(
                        Modifier.fillMaxWidth()
                            .pressable(onLongClick = {
                                z.songMenu(s, listOf(com.a44kaliburll.zoon.ui.components.MenuAction("remove from now playing") { z.player.remove(i) }))
                            }) { z.player.jumpTo(i) }
                            .padding(vertical = 7.dp)
                            .graphicsLayer { alpha = if (i < state.index) 0.45f else 1f },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AlbumArt(s.toCover(), Modifier.size(44.dp))
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            ZText(s.title, Type.body, color = if (current) LocalAccent.current else Palette.text, maxLines = 1)
                            ZText(s.artist, Type.sub, color = Palette.text3, maxLines = 1)
                        }
                        if (current) EqBars(state.isPlaying)
                    }
                }
            }
        }
    }
}
