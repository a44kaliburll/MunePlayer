package app.zoonplayer.ui.screens

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.zoonplayer.ZoonApp
import app.zoonplayer.sync.AutoSyncWorker
import app.zoonplayer.sync.Discovery
import app.zoonplayer.sync.PcClient
import app.zoonplayer.sync.PcHello
import app.zoonplayer.sync.PcInfo
import app.zoonplayer.sync.PcLink
import app.zoonplayer.sync.SyncService
import app.zoonplayer.sync.SyncState
import app.zoonplayer.ui.LocalBottomInset
import app.zoonplayer.ui.LocalZoon
import app.zoonplayer.ui.components.ActionLink
import app.zoonplayer.ui.components.ConfirmRequest
import app.zoonplayer.ui.components.LocalUi
import app.zoonplayer.ui.components.PromptRequest
import app.zoonplayer.ui.components.ZIcon
import app.zoonplayer.ui.components.ZText
import app.zoonplayer.ui.components.featherIn
import app.zoonplayer.ui.components.pressable
import app.zoonplayer.ui.theme.LocalAccent
import app.zoonplayer.ui.theme.Palette
import app.zoonplayer.ui.theme.Type
import app.zoonplayer.ui.theme.ZIcons
import app.zoonplayer.util.ago
import app.zoonplayer.util.plural
import kotlinx.coroutines.launch

/** Wireless sync with Zoon Player on the PC: find it, pair once with a code, then sync. */
@Composable
fun SyncScreen() {
    val graph = ZoonApp.graph
    val pc by graph.pc.pc.collectAsStateWithLifecycle()
    var allowed by remember { mutableStateOf(graph.pc.hasNetworkPermission()) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = graph.pc.hasNetworkPermission() }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = LocalBottomInset.current + 30.dp)) {
        item { PageTitle("sync", indent = false) }
        if (!allowed) {
            item {
                Column(Modifier.featherIn(0), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    ZText("let zoon find your pc", Type.title)
                    ZText(
                        "Android asks before apps talk to other devices on your Wi‑Fi. Allow “Nearby devices” so Zoon can reach Zoon Player on your PC. It's only used for syncing.",
                        Type.body, color = Palette.text2,
                    )
                    ActionLink("allow", ZIcons.wifi, onClick = {
                        if (Build.VERSION.SDK_INT >= 37) ask.launch(PcLink.LOCAL_NETWORK) else allowed = true
                    }, accent = true)
                }
            }
            return@LazyColumn
        }
        val p = pc
        if (p == null) item { PairFlow() } else item { PairedPanel(p) }
    }
}

// ------------------------------------------------------------------ pairing

@Composable
private fun PairFlow() {
    val graph = ZoonApp.graph
    val context = LocalContext.current
    val ui = LocalUi.current
    val scope = rememberCoroutineScope()
    var searching by remember { mutableStateOf(false) }
    var found by remember { mutableStateOf<List<PcHello>>(emptyList()) }
    var chosen by remember { mutableStateOf<PcHello?>(null) }
    var searches by remember { mutableIntStateOf(0) }

    LaunchedEffect(searches) {
        searching = true
        found = runCatching { Discovery.find(context) }.getOrDefault(emptyList())
        searching = false
    }

    val pick = chosen
    AnimatedContent(pick, transitionSpec = { fadeIn(tween(300)) togetherWith fadeOut(tween(200)) }, label = "pair") { target ->
        if (target != null) {
            CodeEntry(target, onBack = { chosen = null })
            return@AnimatedContent
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ZText("sync with your pc", Type.title, modifier = Modifier.featherIn(0))
            ZText(
                "On your PC, open Zoon Player, go to settings › phone, turn on wireless sync and choose “pair a phone”. Your PC shows up here.",
                Type.body, color = Palette.text2, modifier = Modifier.featherIn(1),
            )
            SectionLabel(if (searching) "looking for your pc…" else if (found.isEmpty()) "no pcs found" else "pcs on your wi‑fi")
            if (searching) SearchingBar()
            found.forEachIndexed { i, h ->
                Row(
                    Modifier.fillMaxWidth().featherIn(i).pressable { chosen = h }.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ZIcon(ZIcons.pc, tint = LocalAccent.current, size = 34.dp)
                    Spacer(Modifier.width(14.dp))
                    Column {
                        ZText(h.name, Type.itemLarge, maxLines = 1)
                        ZText(if (h.pairing) "${h.host} · ready to pair" else h.host, Type.sub, color = if (h.pairing) LocalAccent.current else Palette.text3)
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                ActionLink("look again", ZIcons.sync, onClick = { if (!searching) searches++ })
                ActionLink("type the address", ZIcons.edit, onClick = {
                    ui.prompt = PromptRequest("pc address (shown in zoon player's phone settings)", "", "connect") { text ->
                        val addr = Discovery.parseAddress(text) ?: return@PromptRequest ui.toast("That doesn't look like an address")
                        scope.launch {
                            runCatching { PcClient(graph.http, addr.first, addr.second, null).hello() }
                                .onSuccess { chosen = it }
                                .onFailure { ui.toast("Couldn't reach ${addr.first}: ${it.message}") }
                        }
                    }
                })
            }
            ZText(
                "Both need to be on the same Wi‑Fi. The first time, Windows asks whether Zoon Player may use the network; choose Allow.",
                Type.sub, color = Palette.text3, modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}

@Composable
private fun SearchingBar() {
    val accent = LocalAccent.current
    val t by app.zoonplayer.ui.components.rememberLoopClock(true)
    Canvas(Modifier.fillMaxWidth().height(3.dp)) {
        // Zune's marching dots.
        for (i in 0..4) {
            val phase = ((t * 0.45f + i * 0.08f) % 1.2f)
            val x = size.width * (phase * phase)
            drawRect(accent, topLeft = androidx.compose.ui.geometry.Offset(x, 0f), size = Size(4.dp.toPx(), size.height))
        }
    }
}

/** Six big digits and a keypad, like setting up a Zune on a new PC. */
@Composable
private fun CodeEntry(pc: PcHello, onBack: () -> Unit) {
    val graph = ZoonApp.graph
    val context = LocalContext.current
    val ui = LocalUi.current
    val scope = rememberCoroutineScope()
    val accent = LocalAccent.current
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit(c: String) {
        busy = true
        error = null
        scope.launch {
            runCatching { PcClient(graph.http, pc.host, pc.port, null).pair(c, graph.pc.phoneId, graph.pc.phoneName) }
                .onSuccess { (token, hello) ->
                    graph.pc.set(PcInfo(hello.id.ifEmpty { pc.id }, hello.name.ifEmpty { pc.name }, pc.host, pc.port, token, System.currentTimeMillis()))
                    AutoSyncWorker.schedule(context, graph.store.data.settings.autoSync)
                    ui.toast("Paired with ${pc.name}. Syncing your music…")
                    SyncService.start(context)
                }
                .onFailure {
                    error = it.message ?: "Pairing didn't work"
                    code = ""
                }
            busy = false
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        ZText("enter the code", Type.title)
        ZText("It's on ${pc.name}, under settings › phone › pair a phone.", Type.body, color = Palette.text2)
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (i in 0 until 6) {
                val filled = i < code.length
                val cur = i == code.length && !busy
                Box(
                    Modifier.weight(1f).aspectRatio(0.8f).border(if (cur) 2.dp else 1.dp, if (cur) accent else Palette.line),
                    contentAlignment = Alignment.Center,
                ) {
                    if (filled) ZText(code[i].toString(), Type.title.copy(fontSize = Type.title.fontSize * 1.2f))
                }
            }
        }
        if (error != null) ZText(error!!, Type.body, color = accent)
        if (busy) ZText("pairing…", Type.body, color = Palette.text2)
        // Keypad
        val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "⌫")
        keys.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { k ->
                    Box(
                        Modifier.weight(1f).height(62.dp).background(Color(0xFF161616)).pressable(scaleTo = 0.92f) {
                            if (busy) return@pressable
                            when (k) {
                                "back" -> onBack()
                                "⌫" -> code = code.dropLast(1)
                                else -> if (code.length < 6) {
                                    code += k
                                    if (code.length == 6) submit(code)
                                }
                            }
                        },
                        contentAlignment = Alignment.Center,
                    ) {
                        ZText(k, if (k.length == 1) Type.title else Type.item, color = if (k == "back") Palette.text2 else Palette.text)
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ paired

@Composable
private fun PairedPanel(pc: PcInfo) {
    val z = LocalZoon.current
    val graph = ZoonApp.graph
    val ui = LocalUi.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by graph.sync.state.collectAsStateWithLifecycle()
    val user by z.store.state.collectAsStateWithLifecycle()
    val collection by graph.sync.pcLibrary.collectAsStateWithLifecycle()
    val settings = user.settings
    val accent = LocalAccent.current
    val synced = remember(graph.manifest.version.collectAsStateWithLifecycle().value) { graph.manifest.count }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.featherIn(0)) {
            ZIcon(ZIcons.pc, tint = accent, size = 40.dp)
            Spacer(Modifier.width(14.dp))
            Column {
                ZText(pc.name, Type.title, maxLines = 1)
                ZText("${plural(synced, "song")} from your pc · last synced ${ago(pc.lastSync)}", Type.sub, color = Palette.text3)
            }
        }
        Spacer(Modifier.height(10.dp))
        when (val s = state) {
            is SyncState.Running -> SyncProgress(s)
            else -> {
                ActionLink("sync now", ZIcons.sync, onClick = { SyncService.start(context) }, accent = true)
                when (s) {
                    is SyncState.Done -> ZText(
                        buildString {
                            append("Sync complete ${ago(s.at)}: ")
                            append(if (s.added > 0) "added ${plural(s.added, "song")}" else "everything is up to date")
                            if (s.removed > 0) append(", removed ${s.removed}")
                            append(".")
                            if (s.failed.isNotEmpty()) append(" ${s.failed.size} couldn't be copied: ${s.failed.first()}")
                        },
                        Type.body, color = Palette.text2,
                    )
                    is SyncState.Failed -> ZText(s.message, Type.body, color = accent)
                    else -> {}
                }
            }
        }

        SectionLabel("what to sync")
        ToggleRow("all music", "Everything in your collection on the PC.", settings.syncAll) { v -> z.store.updateSettings { it.copy(syncAll = v) } }
        if (!settings.syncAll) {
            val c = collection
            if (c == null) {
                LaunchedEffect(Unit) { runCatching { graph.sync.browse() }.onFailure { ui.toast(it.message ?: "Couldn't read your PC's collection") } }
                ZText("Reading your PC's collection…", Type.body, color = Palette.text2)
            } else {
                val albums = c.albums.values.sortedWith(compareBy({ it.artist.lowercase() }, { it.title.lowercase() }))
                ZText("${settings.syncAlbums.size} of ${albums.size} albums chosen", Type.sub, color = Palette.text3)
                albums.forEach { a ->
                    val on = a.id in settings.syncAlbums
                    Row(
                        Modifier.fillMaxWidth().pressable {
                            z.store.updateSettings { st -> st.copy(syncAlbums = if (on) st.syncAlbums - a.id else st.syncAlbums + a.id) }
                        }.padding(vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(22.dp).border(2.dp, if (on) accent else Palette.text2).background(if (on) accent else Color.Transparent), contentAlignment = Alignment.Center) {
                            if (on) ZIcon(ZIcons.check, size = 16.dp)
                        }
                        Spacer(Modifier.width(14.dp))
                        Column {
                            ZText(a.title, Type.item, maxLines = 1)
                            ZText("${a.artist} · ${plural(a.trackIds.size, "song")}", Type.sub, color = Palette.text3, maxLines = 1)
                        }
                    }
                }
                if (c.playlists.isNotEmpty()) {
                    SectionLabel("playlists")
                    c.playlists.forEach { pl ->
                        val on = pl.id in settings.syncPlaylists
                        ToggleRow(pl.name, plural(pl.trackIds.size, "song"), on) { v ->
                            z.store.updateSettings { st -> st.copy(syncPlaylists = if (v) st.syncPlaylists + pl.id else st.syncPlaylists - pl.id) }
                        }
                    }
                }
            }
        }

        SectionLabel("options")
        ToggleRow("sync while charging", "Like a Zune HD: when your phone is charging on Wi‑Fi, it checks in with your PC about once an hour.", settings.autoSync) { v ->
            z.store.updateSettings { it.copy(autoSync = v) }
            AutoSyncWorker.schedule(context, v)
        }
        ToggleRow("remove what's gone from the pc", "Songs you delete or stop syncing on the PC come off the phone too. Only songs Zoon copied are touched.", settings.removeDeleted) { v ->
            z.store.updateSettings { it.copy(removeDeleted = v) }
        }

        SectionLabel("this pc")
        ZText("${pc.host}:${pc.port} · paired ${ago(pc.paired)}", Type.sub, color = Palette.text3)
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            ActionLink("forget this pc", ZIcons.close, onClick = {
                ui.confirm = ConfirmRequest(
                    "forget ${pc.name}?",
                    "Zoon stops syncing with it. Songs already on your phone stay; pair again any time.",
                    "forget",
                ) {
                    graph.pc.set(null)
                    AutoSyncWorker.schedule(context, false)
                }
            })
        }
        ActionLink("remove synced songs from this phone", ZIcons.trash, onClick = {
            ui.confirm = ConfirmRequest(
                "remove synced songs?",
                "Deletes the ${plural(synced, "song")} Zoon copied from your PC. Your PC's collection isn't touched.",
                "remove",
            ) {
                scope.launch {
                    graph.sync.removeAllSynced()
                    ui.toast("Removed the synced songs")
                }
            }
        })
    }
}

@Composable
private fun SyncProgress(s: SyncState.Running) {
    val accent = LocalAccent.current
    val context = LocalContext.current
    val target = when {
        s.phase == "copying" && s.totalBytes > 0 -> s.bytes.toFloat() / s.totalBytes
        s.phase == "copying" && s.total > 0 -> s.done.toFloat() / s.total
        s.phase == "art" -> 1f
        else -> 0f
    }
    val fraction by animateFloatAsState(target.coerceIn(0f, 1f), tween(400), label = "sync")
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ZText("${(fraction * 100).toInt()}%", Type.giant.copy(fontSize = Type.giant.fontSize * 0.62f, lineHeight = Type.giant.lineHeight * 0.62f), color = accent)
        ZText(
            when (s.phase) {
                "connecting" -> "connecting to your pc…"
                "reading" -> "reading your collection…"
                "art" -> "getting album art…"
                else -> "copying ${s.done + 1} of ${s.total}"
            },
            Type.item,
        )
        if (s.title != null) ZText(s.title, Type.body, color = Palette.text2, maxLines = 1)
        Canvas(Modifier.fillMaxWidth().height(4.dp).padding(top = 0.dp)) {
            drawRect(Color(0x22FFFFFF))
            drawRect(accent, size = Size(size.width * fraction, size.height))
        }
        ActionLink("stop", ZIcons.close, onClick = {
            context.startService(android.content.Intent(context, SyncService::class.java).setAction("app.zoonplayer.CANCEL_SYNC"))
        })
    }
}
