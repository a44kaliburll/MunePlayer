package app.muneplayer.ui.screens

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.muneplayer.MuneApp
import app.muneplayer.ui.LocalBottomInset
import app.muneplayer.ui.LocalMune
import app.muneplayer.ui.Screen
import app.muneplayer.ui.components.ActionLink
import app.muneplayer.ui.components.CircleButton
import app.muneplayer.ui.components.PivotHeader
import app.muneplayer.ui.components.PromptRequest
import app.muneplayer.ui.components.ZIcon
import app.muneplayer.ui.components.ZText
import app.muneplayer.ui.components.featherIn
import app.muneplayer.ui.components.pressable
import app.muneplayer.ui.theme.LocalAccent
import app.muneplayer.ui.theme.Palette
import app.muneplayer.ui.theme.Type
import app.muneplayer.ui.theme.ZIcons
import app.muneplayer.util.fmtTime
import app.muneplayer.util.plural
import app.muneplayer.youtube.YtCommand
import app.muneplayer.youtube.YtItem
import app.muneplayer.youtube.YtState
import coil3.compose.AsyncImage
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

// YouTube Music through YouTube's official APIs (youtube/YouTube.kt). Songs play in YouTube's own
// embedded player, with video; YouTube doesn't allow audio-only or background play in other apps,
// so the player pauses whenever Mune leaves the screen.

private val PIVOTS = listOf("search", "playlists", "liked")

private sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Done<T>(val value: T) : Load<T>
    data class Failed(val message: String) : Load<Nothing>
}

@Composable
private fun <T> rememberLoad(key: Any?, load: suspend () -> T): Load<T> {
    val state by produceState<Load<T>>(Load.Loading, key) {
        value = try {
            Load.Done(load())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Load.Failed(e.message ?: "Something went wrong.")
        }
    }
    return state
}

private fun openUrl(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

private fun listPadding(bottom: androidx.compose.ui.unit.Dp) = PaddingValues(start = 18.dp, end = 18.dp, top = 6.dp, bottom = bottom + 24.dp)

/** A 16:9 YouTube thumbnail, big enough to start playback (YouTube asks for at least 120 x 70 px). */
@Composable
private fun Thumb(url: String?) {
    Box(Modifier.size(width = 112.dp, height = 63.dp).background(Palette.panel)) {
        if (url != null) AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

@Composable
private fun YtRow(v: YtItem, playing: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val accent = LocalAccent.current
    Row(modifier.fillMaxWidth().pressable(onClick = onClick).padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Thumb(v.thumb)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            ZText(v.title, Type.item, color = if (playing) accent else Palette.text, maxLines = 2)
            ZText(listOfNotNull(v.artist.ifEmpty { null }, v.duration?.let { fmtTime(it * 1000L) }).joinToString(" · "), Type.sub, color = Palette.text3, maxLines = 1)
        }
    }
}

@Composable
private fun Message(text: String, error: Boolean = false) {
    ZText(text, Type.body, color = if (error) LocalAccent.current else Palette.text3, modifier = Modifier.padding(top = 12.dp))
}

/** Songs from YouTube; tapping one plays the list from there in the player screen. */
@Composable
private fun YtList(load: Load<List<YtItem>>, empty: String) {
    val z = LocalMune.current
    val yt = MuneApp.graph.youtube
    val queue by yt.queue.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = listPadding(LocalBottomInset.current)) {
        when (load) {
            Load.Loading -> item { Message("loading…") }
            is Load.Failed -> item { Message(load.message, error = true) }
            is Load.Done -> {
                if (load.value.isEmpty()) item { Message(empty) }
                itemsIndexed(load.value, key = { i, v -> "$i:${v.id}" }) { i, v ->
                    YtRow(v, playing = queue?.current?.id == v.id, modifier = Modifier.featherIn(i)) {
                        yt.play(load.value, i)
                        z.nav.go(Screen.YouTubePlayer)
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------ youtube: search / playlists / liked
@Composable
fun YouTubeHomeScreen(initialPage: Int, query: String?) {
    val st by MuneApp.graph.youtube.state.collectAsStateWithLifecycle()
    if (!st.signedIn) {
        YouTubeNotReady(st)
        return
    }
    val pager = rememberPagerState(initialPage) { PIVOTS.size }
    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        ZText("youtube music", Type.label, color = Palette.text2, modifier = Modifier.padding(start = 20.dp, top = 14.dp))
        PivotHeader(PIVOTS, pager)
        HorizontalPager(pager, Modifier.weight(1f), beyondViewportPageCount = 1) { page ->
            when (page) {
                0 -> SearchPage(query)
                1 -> PlaylistsPage()
                else -> YtList(rememberLoad("liked") { MuneApp.graph.youtube.liked() }, "Songs you like on YouTube or YouTube Music show up here.")
            }
        }
    }
}

@Composable
private fun YouTubeNotReady(st: YtState) {
    val z = LocalMune.current
    Column(Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 18.dp)) {
        PageTitle("youtube", indent = false)
        ZText(
            "Search YouTube Music and play your playlists and liked songs here, with video, in YouTube's own player. " +
                if (st.configured) "Sign in with your Google account to start." else "It takes a one-time setup with your own free Google Cloud project.",
            Type.body, color = Palette.text2, modifier = Modifier.padding(top = 8.dp),
        )
        ActionLink(if (st.configured) "sign in" else "set up", ZIcons.settings, onClick = { z.nav.go(Screen.YouTubeSetup) }, accent = true, modifier = Modifier.padding(top = 18.dp))
    }
}

@Composable
private fun SearchPage(initial: String?) {
    val yt = MuneApp.graph.youtube
    val accent = LocalAccent.current
    val focusManager = LocalFocusManager.current
    var text by rememberSaveable { mutableStateOf(initial ?: yt.lastQuery) }
    var submitted by rememberSaveable { mutableStateOf(initial ?: yt.lastQuery) }
    val results = rememberLoad(submitted) { if (submitted.isBlank()) emptyList() else yt.search(submitted).also { yt.lastQuery = submitted } }
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.padding(horizontal = 18.dp, vertical = 8.dp).fillMaxWidth().border(1.dp, Palette.line).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ZIcon(ZIcons.search, tint = Palette.text2)
            Spacer(Modifier.width(10.dp))
            Box(Modifier.weight(1f)) {
                if (text.isEmpty()) ZText("search youtube music", Type.item, color = Palette.text3)
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    textStyle = Type.item.copy(color = Palette.text),
                    cursorBrush = SolidColor(accent),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = {
                        submitted = text.trim()
                        focusManager.clearFocus()
                    }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (submitted.isBlank()) {
            ZText(
                "Songs and music videos from YouTube Music. Each search uses 100 of your Google project's 10,000 daily YouTube units.",
                Type.body, color = Palette.text3, modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp),
            )
        } else {
            YtList(results, "Nothing on YouTube Music for “$submitted”.")
        }
    }
}

@Composable
private fun PlaylistsPage() {
    val z = LocalMune.current
    val load = rememberLoad("playlists") { MuneApp.graph.youtube.playlists() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = listPadding(LocalBottomInset.current)) {
        when (load) {
            Load.Loading -> item { Message("loading…") }
            is Load.Failed -> item { Message(load.message, error = true) }
            is Load.Done -> {
                if (load.value.isEmpty()) item { Message("You don't have any playlists on YouTube yet.") }
                itemsIndexed(load.value, key = { _, p -> p.id }) { i, p ->
                    Row(
                        Modifier.fillMaxWidth().featherIn(i).pressable { z.nav.go(Screen.YouTubePlaylist(p.id, p.title)) }.padding(vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Thumb(p.thumb)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            ZText(p.title, Type.item, maxLines = 2)
                            p.count?.let { ZText(plural(it, "video"), Type.sub, color = Palette.text3) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun YouTubePlaylistScreen(id: String, title: String) {
    Column(Modifier.fillMaxSize()) {
        PageTitle(title.lowercase())
        YtList(rememberLoad(id) { MuneApp.graph.youtube.playlist(id) }, "This playlist is empty, or its videos are private.")
    }
}

// ------------------------------------------------------------ the player
/** Called from the player page (see playerPage). Kept by name in proguard-rules.pro. */
class YtBridge(
    private val main: Handler,
    private val state: (Int) -> Unit,
    private val error: (Int) -> Unit,
    private val time: (Double, Double) -> Unit,
) {
    @JavascriptInterface
    fun onState(s: Int) {
        main.post { state(s) }
    }

    @JavascriptInterface
    fun onError(code: Int) {
        main.post { error(code) }
    }

    @JavascriptInterface
    fun onTime(position: Double, duration: Double) {
        main.post { time(position, duration) }
    }
}

/** YouTube's IFrame Player API in a page of its own, reporting back through the Mune bridge. */
private fun playerPage(videoId: String) = """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{position:absolute;top:0;left:0;width:100%;height:100%}</style></head>
<body><div id="p"></div><script>
var player;
function onYouTubeIframeAPIReady(){player=new YT.Player('p',{width:'100%',height:'100%',videoId:${JSONObject.quote(videoId)},playerVars:{autoplay:1,playsinline:1,rel:0},events:{onStateChange:function(e){Mune.onState(e.data)},onError:function(e){Mune.onError(e.data)}}});
setInterval(function(){if(player&&player.getCurrentTime)Mune.onTime(player.getCurrentTime()||0,player.getDuration()||0);},500);}
function load(id){if(player&&player.loadVideoById)player.loadVideoById(id);}
function play(){if(player&&player.playVideo)player.playVideo();}
function pause(){if(player&&player.pauseVideo)player.pauseVideo();}
function stop(){if(player&&player.stopVideo)player.stopVideo();}
function seek(s){if(player&&player.seekTo)player.seekTo(s,true);}
</script><script src="https://www.youtube.com/iframe_api"></script></body></html>"""

/** Lets the screen drive the player page. */
private class YtWeb {
    var view: WebView? = null

    private fun js(code: String) {
        view?.evaluateJavascript(code, null)
    }

    fun play() = js("play()")
    fun pause() = js("pause()")
    fun stop() = js("stop()")
    fun seek(seconds: Double) = js("seek($seconds)")
    fun load(id: String) = js("load(${JSONObject.quote(id)})")
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun YouTubePlayerView(
    videoId: String,
    web: YtWeb,
    munePlaying: Boolean,
    onState: (Int) -> Unit,
    onTime: (Double, Double) -> Unit,
    onError: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state by rememberUpdatedState(onState)
    val time by rememberUpdatedState(onTime)
    val failed by rememberUpdatedState(onError)
    var shown by remember { mutableStateOf(videoId) }

    LaunchedEffect(videoId) {
        if (videoId != shown) {
            web.load(videoId)
            shown = videoId
        }
    }
    // Mune's own music pauses YouTube (and YouTube starting pauses Mune: see onState).
    LaunchedEffect(munePlaying) {
        if (munePlaying) web.pause()
    }
    // No background play: pause whenever Mune leaves the screen.
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_PAUSE -> {
                    web.pause()
                    web.view?.onPause()
                }
                Lifecycle.Event.ON_RESUME -> web.view?.onResume()
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    AndroidView(
        factory = { ctx ->
            WebView(ctx).apply {
                setBackgroundColor(android.graphics.Color.BLACK)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                addJavascriptInterface(YtBridge(Handler(Looper.getMainLooper()), { s -> state(s) }, { c -> failed(c) }, { p, d -> time(p, d) }), "Mune")
                // YouTube identifies apps that embed its player by the Referer: https://<app id>.
                loadDataWithBaseURL("https://${ctx.packageName}/", playerPage(videoId), "text/html", "utf-8", null)
                web.view = this
            }
        },
        onRelease = {
            web.view = null
            it.destroy()
        },
        modifier = modifier,
    )
}

/** Elapsed and remaining time over a thin bar; tap the bar to jump. */
@Composable
private fun YtProgress(position: Double, duration: Double, onSeek: (Double) -> Unit, modifier: Modifier = Modifier) {
    val accent = LocalAccent.current
    val fraction = if (duration > 0) (position / duration).toFloat().coerceIn(0f, 1f) else 0f
    Column(modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth().height(24.dp).pointerInput(duration) {
                detectTapGestures { o -> if (duration > 0) onSeek(duration * (o.x / size.width).coerceIn(0f, 1f)) }
            },
            contentAlignment = Alignment.CenterStart,
        ) {
            Box(Modifier.fillMaxWidth().height(3.dp).background(Palette.line))
            Box(Modifier.fillMaxWidth(fraction).height(3.dp).background(accent))
        }
        Row(Modifier.fillMaxWidth()) {
            ZText(fmtTime((position * 1000).toLong()), Type.small, color = Palette.text3)
            Spacer(Modifier.weight(1f))
            if (duration > 0) ZText("-" + fmtTime(((duration - position).coerceAtLeast(0.0) * 1000).toLong()), Type.small, color = Palette.text3)
        }
    }
}

@Composable
fun YouTubePlayerScreen() {
    val z = LocalMune.current
    val yt = MuneApp.graph.youtube
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val queue by yt.queue.collectAsStateWithLifecycle()
    val player by z.player.state.collectAsStateWithLifecycle()
    val web = remember { YtWeb() }
    // YouTube's player states: -1 not started, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
    var state by remember { mutableIntStateOf(-1) }
    var position by remember { mutableDoubleStateOf(0.0) }
    var duration by remember { mutableDoubleStateOf(0.0) }
    val q = queue
    val v = q?.current
    if (q == null || v == null) {
        Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
            PageTitle("youtube", indent = false)
            Message("Nothing is playing from YouTube.")
        }
        return
    }

    fun toggle() = if (state == 1 || state == 3) web.pause() else web.play()
    // Like the Zune: back to the start of the song, or to the one before if it has only just started.
    fun previous() = if (position > 3 || (yt.queue.value?.index ?: 0) == 0) web.seek(0.0) else yt.step(-1)
    fun stop() {
        web.stop()
        z.nav.back()
    }

    LaunchedEffect(v.id) {
        position = 0.0
        duration = (v.duration ?: 0).toDouble()
    }
    // Headset, Bluetooth and the system's media controls drive YouTube while this screen is in front.
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { owner, _ -> yt.active.value = owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            yt.active.value = false
        }
    }
    LaunchedEffect(Unit) {
        yt.remote.collect { cmd ->
            when (cmd) {
                YtCommand.Toggle -> toggle()
                YtCommand.Play -> web.play()
                YtCommand.Pause -> web.pause()
                YtCommand.Next -> yt.step(1)
                YtCommand.Previous -> previous()
                YtCommand.Stop -> stop()
            }
        }
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        YouTubePlayerView(
            videoId = v.id,
            web = web,
            munePlaying = player.isPlaying,
            onState = { s ->
                state = s
                if (s == 1 && z.player.state.value.isPlaying) z.player.pause() // YouTube started: pause Mune's own music
                if (s == 0) yt.step(1) // ended: next in the list
            },
            onTime = { p, d ->
                position = p
                if (d > 0) duration = d
            },
            onError = { code ->
                z.ui.toast(if (code == 101 || code == 150) "That song's owner doesn't let it play outside YouTube." else "YouTube couldn't play that song (error $code).")
                scope.launch {
                    delay(1500)
                    yt.step(1)
                }
            },
            modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f),
        )
        LazyColumn(Modifier.fillMaxSize(), contentPadding = listPadding(LocalBottomInset.current)) {
            item {
                Column(Modifier.padding(top = 10.dp)) {
                    ZText(v.title, Type.item, maxLines = 3)
                    ZText(v.artist, Type.sub, color = Palette.text3, maxLines = 1)
                    YtProgress(position, duration, onSeek = { web.seek(it) }, modifier = Modifier.padding(top = 12.dp))
                    Row(
                        Modifier.fillMaxWidth().padding(top = 10.dp),
                        horizontalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val playing = state == 1 || state == 3
                        CircleButton(ZIcons.previous, onClick = { previous() }, size = 50.dp, modifier = Modifier.semantics { contentDescription = "previous" })
                        CircleButton(
                            if (playing) ZIcons.pause else ZIcons.play, onClick = { toggle() }, size = 66.dp, filled = true,
                            modifier = Modifier.semantics { contentDescription = if (playing) "pause" else "play" },
                        )
                        CircleButton(
                            ZIcons.next, onClick = { yt.step(1) }, size = 50.dp, tint = if (q.index < q.items.size - 1) Palette.text else Palette.text3,
                            modifier = Modifier.semantics { contentDescription = "next" },
                        )
                        CircleButton(ZIcons.stop, onClick = { stop() }, size = 50.dp, modifier = Modifier.semantics { contentDescription = "stop" })
                    }
                    ActionLink(
                        "open in youtube music", null,
                        onClick = {
                            web.pause()
                            openUrl(context, "https://music.youtube.com/watch?v=${Uri.encode(v.id)}")
                        },
                        accent = true, modifier = Modifier.padding(top = 14.dp),
                    )
                    ZText(
                        "Playing from YouTube. Other apps can't play YouTube as audio only or in the background, so it pauses when you leave this screen.",
                        Type.small, color = Palette.text3, modifier = Modifier.padding(top = 10.dp),
                    )
                }
            }
            if (q.items.size > 1) {
                item { SectionLabel("the list") }
                itemsIndexed(q.items, key = { i, it -> "$i:${it.id}" }) { i, item ->
                    YtRow(item, playing = i == q.index) { yt.play(q.items, i) }
                }
            }
        }
    }
}

// ------------------------------------------------------------ setup and sign-in
@Composable
fun YouTubeSetupScreen() {
    val z = LocalMune.current
    val graph = MuneApp.graph
    val yt = graph.youtube
    val st by yt.state.collectAsStateWithLifecycle()
    val pc by graph.pc.pc.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val accent = LocalAccent.current
    var openWhenReady by remember { mutableStateOf(false) }
    // Open google.com/device once the code for a sign-in just started arrives.
    LaunchedEffect(st.signin?.code) {
        val s = st.signin
        if (openWhenReady && s != null) {
            openWhenReady = false
            openUrl(context, s.url)
        }
    }
    val fail: (Throwable) -> Unit = { z.ui.toast(it.message ?: "Something went wrong.") }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = LocalBottomInset.current + 30.dp)) {
        item { PageTitle("youtube music", indent = false) }
        val signin = st.signin
        when {
            !st.configured -> {
                item {
                    ZText(
                        "Search YouTube Music and play your YouTube playlists and liked songs here, with video, in YouTube's own player. Mune reaches YouTube through your own free Google Cloud project, set up once.",
                        Type.body, color = Palette.text2,
                    )
                }
                val paired = pc
                if (paired != null) {
                    item {
                        ActionLink("use the setup from ${paired.name}", ZIcons.pc, onClick = {
                            scope.launch {
                                runCatching { graph.pc.client().youtubeClient() }
                                    .onSuccess { (id, secret) -> runCatching { yt.configure(id, secret) }.onFailure(fail) }
                                    .onFailure(fail)
                            }
                        }, accent = true, modifier = Modifier.padding(top = 16.dp))
                    }
                }
                item { SectionLabel(if (paired != null) "or set it up here" else "set up") }
                item {
                    ZText(
                        "1. At console.cloud.google.com, create a project and enable the YouTube Data API v3.\n" +
                            "2. In Google Auth Platform, set the app up as External. Under Audience, add yourself as a test user, or choose Publish app so the sign-in doesn't expire every 7 days.\n" +
                            "3. Under Clients, create a client of the type TVs and Limited Input devices, then enter its ID and secret here.",
                        Type.sub, color = Palette.text2,
                    )
                }
                item {
                    ActionLink("enter the client id and secret", ZIcons.edit, onClick = {
                        z.ui.prompt = PromptRequest("client ID (ends in .apps.googleusercontent.com)", "", "next") { id ->
                            z.ui.prompt = PromptRequest("client secret", "", "save") { secret -> runCatching { yt.configure(id, secret) }.onFailure(fail) }
                        }
                    }, modifier = Modifier.padding(top = 14.dp))
                }
            }
            signin != null -> {
                item {
                    ZText("On this phone or any computer, go to ${signin.url.removePrefix("https://")}, sign in to Google and enter this code:", Type.body, color = Palette.text2)
                }
                item { ZText(signin.code, Type.title, color = Palette.text, modifier = Modifier.padding(vertical = 14.dp)) }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(26.dp)) {
                        ActionLink("open the page", null, onClick = { openUrl(context, signin.url) }, accent = true)
                        ActionLink("cancel", null, onClick = { yt.cancelSignIn() })
                    }
                }
            }
            st.signedIn -> {
                item { ZText("signed in" + (st.channel?.let { " as $it" } ?: ""), Type.item) }
                item { ActionLink("open youtube", ZIcons.play, onClick = { z.nav.go(Screen.YouTubeHome()) }, accent = true, modifier = Modifier.padding(top = 14.dp)) }
                item { ActionLink("sign out", null, onClick = { yt.signOut() }, modifier = Modifier.padding(top = 10.dp)) }
            }
            else -> {
                item { ZText("Sign in with the Google account you use for YouTube Music.", Type.body, color = Palette.text2) }
                item {
                    ActionLink("sign in with google", null, onClick = {
                        openWhenReady = true
                        yt.startSignIn()
                    }, accent = true, modifier = Modifier.padding(top = 14.dp))
                }
                item { ZText("google client ${st.clientId}", Type.small, color = Palette.text3, modifier = Modifier.padding(top = 18.dp)) }
                item { ActionLink("remove client", null, onClick = { yt.removeClient() }, modifier = Modifier.padding(top = 4.dp)) }
            }
        }
        st.error?.let { item { ZText(it, Type.sub, color = accent, modifier = Modifier.padding(top = 14.dp)) } }
        item {
            Column(Modifier.padding(top = 26.dp)) {
                ZText(
                    "This uses YouTube API Services. By signing in you agree to the YouTube Terms of Service; see also the Google Privacy Policy. The sign-in stays on this phone, and you can remove Mune's access from your Google Account at any time.",
                    Type.small, color = Palette.text3,
                )
                Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    ActionLink("terms", null, onClick = { openUrl(context, "https://www.youtube.com/t/terms") })
                    ActionLink("privacy", null, onClick = { openUrl(context, "https://policies.google.com/privacy") })
                    ActionLink("remove access", null, onClick = { openUrl(context, "https://myaccount.google.com/connections") })
                }
            }
        }
    }
}
