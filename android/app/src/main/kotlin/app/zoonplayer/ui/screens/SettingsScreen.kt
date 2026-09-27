package app.zoonplayer.ui.screens

import android.content.Intent
import android.net.Uri
import android.provider.Settings as AndroidSettings
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.zoonplayer.BuildConfig
import app.zoonplayer.ZoonApp
import app.zoonplayer.data.Settings
import app.zoonplayer.ui.LocalBottomInset
import app.zoonplayer.ui.LocalZoon
import app.zoonplayer.ui.Screen
import app.zoonplayer.ui.components.PromptRequest
import app.zoonplayer.ui.components.ZIcon
import app.zoonplayer.ui.components.ZText
import app.zoonplayer.ui.components.featherIn
import app.zoonplayer.ui.components.pressable
import app.zoonplayer.ui.theme.Accents
import app.zoonplayer.ui.theme.LocalAccent
import app.zoonplayer.ui.theme.Palette
import app.zoonplayer.ui.theme.Type
import app.zoonplayer.ui.theme.ZIcons
import app.zoonplayer.util.plural

/** The Zune HD / WP7 toggle: an outlined track that fills with the accent, and a tall white thumb. */
@Composable
fun ZoonSwitch(on: Boolean, modifier: Modifier = Modifier) {
    val accent = LocalAccent.current
    val fill by animateColorAsState(if (on) accent else Color.Transparent, label = "fill")
    val x by animateDpAsState(if (on) 44.dp else 0.dp, spring(dampingRatio = 0.62f, stiffness = 700f), label = "thumb")
    Box(modifier.size(width = 58.dp, height = 30.dp), contentAlignment = Alignment.CenterStart) {
        Box(Modifier.fillMaxWidth().height(22.dp).border(2.dp, Palette.text).padding(4.dp).background(fill))
        Box(Modifier.offset(x = x).size(width = 14.dp, height = 30.dp).background(Palette.text))
    }
}

@Composable
fun ToggleRow(label: String, sub: String?, on: Boolean, modifier: Modifier = Modifier, onToggle: (Boolean) -> Unit) {
    Row(
        modifier.fillMaxWidth().pressable(scaleTo = 0.985f) { onToggle(!on) }.padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 14.dp)) {
            ZText(label, Type.item)
            if (sub != null) ZText(sub, Type.sub, color = Palette.text3)
        }
        Column(horizontalAlignment = Alignment.End) {
            ZoonSwitch(on)
            ZText(if (on) "on" else "off", Type.small, color = Palette.text3, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit) {
    val accent = LocalAccent.current
    Row(Modifier.fillMaxWidth().pressable(onClick = onClick).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(22.dp).border(2.dp, if (selected) accent else Palette.text2), contentAlignment = Alignment.Center) {
            if (selected) Box(Modifier.size(10.dp).background(accent))
        }
        Spacer(Modifier.width(14.dp))
        ZText(label, Type.item, color = if (selected) Palette.text else Palette.text2)
    }
}

@Composable
fun SettingsScreen() {
    val z = LocalZoon.current
    val graph = ZoonApp.graph
    val user by z.store.state.collectAsStateWithLifecycle()
    val lib by graph.library.state.collectAsStateWithLifecycle()
    val pc by graph.pc.pc.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val s = user.settings
    fun set(fn: (Settings) -> Settings) = z.store.updateSettings(fn)

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = LocalBottomInset.current + 30.dp)) {
        item { PageTitle("settings", indent = false) }

        item { SectionLabel("accent colour") }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.featherIn(0)) {
                Accents.chunked(4).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        row.forEach { (name, argb) ->
                            val selected = s.accent == argb
                            Column(Modifier.weight(1f)) {
                                Box(
                                    Modifier.fillMaxWidth().aspectRatio(1.5f).background(Color(argb))
                                        .then(if (selected) Modifier.border(3.dp, Palette.text) else Modifier)
                                        .pressable(scaleTo = 0.92f) { set { it.copy(accent = argb) } },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (selected) ZIcon(ZIcons.check, size = 26.dp)
                                }
                                ZText(name, Type.small, color = if (selected) Palette.text else Palette.text3, modifier = Modifier.padding(top = 3.dp))
                            }
                        }
                    }
                }
            }
        }

        item { SectionLabel("background") }
        item {
            Column(Modifier.featherIn(1)) {
                ChoiceRow("artist photos", s.background == "artist") { set { it.copy(background = "artist") } }
                ChoiceRow("zoon glow", s.background == "gradient") { set { it.copy(background = "gradient") } }
                ChoiceRow("black", s.background == "black") { set { it.copy(background = "black") } }
            }
        }

        item { SectionLabel("playback") }
        item {
            Column(Modifier.featherIn(2)) {
                ToggleRow("resume where I left off", "Reopen with the same now playing list.", s.resume) { v -> set { it.copy(resume = v) } }
                ToggleRow("keep the screen on", "While now playing is open.", s.keepScreenOn) { v -> set { it.copy(keepScreenOn = v) } }
            }
        }

        item { SectionLabel("online") }
        item {
            Column(Modifier.featherIn(3)) {
                ZText(
                    "The Zune service is gone, so these use Deezer and iTunes Search instead. Only artist and album names are sent.",
                    Type.sub, color = Palette.text3, modifier = Modifier.padding(bottom = 4.dp),
                )
                ToggleRow("artist photos", "The big pictures behind now playing and artist pages.", s.artistPhotos) { v -> set { it.copy(artistPhotos = v) } }
                ToggleRow("find missing album art", null, s.onlineArt) { v -> set { it.copy(onlineArt = v) } }
                ToggleRow("related artists for smart dj", null, s.related) { v -> set { it.copy(related = v) } }
            }
        }

        item { SectionLabel("sync") }
        item {
            Row(
                Modifier.fillMaxWidth().featherIn(4).pressable { z.nav.go(Screen.Sync) }.padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ZIcon(ZIcons.pc, tint = LocalAccent.current)
                Spacer(Modifier.width(12.dp))
                Column {
                    ZText("wireless sync", Type.item)
                    ZText(pc?.let { "paired with ${it.name}" } ?: "not paired with a pc", Type.sub, color = Palette.text3)
                }
            }
        }
        item {
            val shown = s.phoneName.ifBlank { graph.pc.deviceName }
            Row(
                Modifier.fillMaxWidth().featherIn(4).pressable {
                    z.ui.prompt = PromptRequest("phone name (your pc shows this)", shown, "save") { name ->
                        set { it.copy(phoneName = name.trim().take(40)) }
                    }
                }.padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ZIcon(ZIcons.phone, tint = LocalAccent.current)
                Spacer(Modifier.width(12.dp))
                Column {
                    ZText("phone name", Type.item)
                    ZText(shown, Type.sub, color = Palette.text3)
                }
            }
        }

        item { SectionLabel("about") }
        item {
            Column(Modifier.featherIn(5), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ZText("zoon player ${BuildConfig.VERSION_NAME}", Type.item)
                ZText("${plural(lib.songs.size, "song")} · ${plural(lib.albums.size, "album")} · ${plural(lib.artists.size, "artist")}", Type.sub, color = Palette.text2)
                ZText(
                    "Your own music, in the style of the Zune HD. Not affiliated with Microsoft; Zune is a trademark of Microsoft Corporation.",
                    Type.sub, color = Palette.text3,
                )
                ZText(
                    "Selawik font © Microsoft, SIL Open Font License. Media3, Coil and OkHttp under the Apache License 2.0. Artist data from Deezer.",
                    Type.sub, color = Palette.text3,
                )
                ZText(
                    "app permissions",
                    Type.item,
                    color = LocalAccent.current,
                    modifier = Modifier.padding(top = 6.dp).pressable {
                        context.startActivity(
                            Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    },
                )
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}
