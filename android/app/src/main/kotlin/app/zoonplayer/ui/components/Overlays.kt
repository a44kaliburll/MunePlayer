package app.zoonplayer.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import app.zoonplayer.data.Cover
import app.zoonplayer.ui.theme.LocalAccent
import app.zoonplayer.ui.theme.Palette
import app.zoonplayer.ui.theme.Type
import kotlinx.coroutines.delay

class MenuAction(val label: String, val icon: ImageVector? = null, val run: () -> Unit)
class MenuRequest(val title: String, val subtitle: String?, val cover: Cover?, val actions: List<MenuAction>)
class JumpRequest(val available: Set<Char>, val onPick: (Char) -> Unit)
class PromptRequest(val title: String, val initial: String, val confirm: String, val onConfirm: (String) -> Unit)
class ConfirmRequest(val title: String, val text: String, val confirm: String, val onConfirm: () -> Unit)

/** App-wide overlays: the long-press flyout, the jump grid, prompts, confirmations and toasts. */
class UiHost {
    var menu by mutableStateOf<MenuRequest?>(null)
    var jump by mutableStateOf<JumpRequest?>(null)
    var prompt by mutableStateOf<PromptRequest?>(null)
    var confirm by mutableStateOf<ConfirmRequest?>(null)
    var toastText by mutableStateOf<String?>(null)
        private set
    var toastId by mutableIntStateOf(0)
        private set

    fun toast(text: String) {
        toastText = text
        toastId++
    }

    val anyOpen get() = menu != null || jump != null || prompt != null || confirm != null

    fun closeTop(): Boolean = when {
        confirm != null -> { confirm = null; true }
        prompt != null -> { prompt = null; true }
        jump != null -> { jump = null; true }
        menu != null -> { menu = null; true }
        else -> false
    }
}

val LocalUi = staticCompositionLocalOf<UiHost> { error("UiHost not provided") }

private val JUMP_LETTERS = listOf('#') + ('a'..'z').toList()

@Composable
fun BoxScope.Overlays(host: UiHost) {
    BackHandler(enabled = host.anyOpen) { host.closeTop() }
    Scrim(visible = host.anyOpen) { host.closeTop() }
    MenuPanel(host)
    JumpGrid(host)
    PromptPanel(host)
    ConfirmPanel(host)
    Toast(host)
}

@Composable
private fun Scrim(visible: Boolean, onTap: () -> Unit) {
    AnimatedVisibility(visible, enter = fadeIn(tween(180)), exit = fadeOut(tween(220))) {
        Box(
            Modifier.fillMaxSize().background(Color(0xD0000000))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onTap),
        )
    }
}

@Composable
private fun <T : Any> rememberLast(value: T?): T? {
    val last = remember { mutableStateOf(value) }
    if (value != null) last.value = value
    return last.value
}

@Composable
private fun BoxScope.MenuPanel(host: UiHost) {
    val req = rememberLast(host.menu)
    AnimatedVisibility(
        host.menu != null,
        modifier = Modifier.align(Alignment.BottomCenter),
        enter = slideInVertically(tween(320, easing = ZoonEase)) { it / 2 } + fadeIn(tween(200)),
        exit = slideOutVertically(tween(220)) { it / 3 } + fadeOut(tween(180)),
    ) {
        if (req == null) return@AnimatedVisibility
        Column(
            Modifier.fillMaxWidth().background(Color(0xFF141414)).navigationBarsPadding()
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
                .padding(start = 22.dp, end = 22.dp, top = 22.dp, bottom = 18.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (req.cover != null) {
                    AlbumArt(req.cover, Modifier.size(58.dp))
                    Spacer(Modifier.width(14.dp))
                }
                Column(Modifier.weight(1f)) {
                    ZText(req.title, Type.item, maxLines = 2)
                    if (req.subtitle != null) ZText(req.subtitle, Type.sub, color = Palette.text3, maxLines = 1)
                }
            }
            Spacer(Modifier.height(14.dp))
            Column(Modifier.verticalScroll(rememberScrollState())) {
                req.actions.forEachIndexed { i, a ->
                    ZText(
                        a.label,
                        Type.title.copy(fontSize = Type.title.fontSize * 0.82f),
                        modifier = Modifier.fillMaxWidth().featherIn(i).pressable {
                            host.menu = null
                            a.run()
                        }.padding(vertical = 9.dp),
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun BoxScope.JumpGrid(host: UiHost) {
    val req = rememberLast(host.jump)
    val accent = LocalAccent.current
    AnimatedVisibility(host.jump != null, enter = fadeIn(tween(150)), exit = fadeOut(tween(150)), modifier = Modifier.matchParentSize()) {
        if (req == null) return@AnimatedVisibility
        LazyVerticalGrid(
            columns = GridCells.Fixed(4),
            modifier = Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            itemsIndexed(JUMP_LETTERS) { i, letter ->
                val on = letter in req.available
                val pop = remember { Animatable(0f) }
                LaunchedEffect(Unit) {
                    delay(i * 12L)
                    pop.animateTo(1f, tween(260, easing = ZoonEase))
                }
                Box(
                    Modifier.aspectRatio(1f)
                        .graphicsLayer {
                            scaleX = 0.6f + 0.4f * pop.value
                            scaleY = 0.6f + 0.4f * pop.value
                            alpha = pop.value
                        }
                        .background(if (on) accent else Color(0xFF1C1C1C))
                        .then(
                            if (on) Modifier.pressable {
                                host.jump = null
                                req.onPick(letter)
                            } else Modifier,
                        ),
                    contentAlignment = Alignment.BottomStart,
                ) {
                    ZText(letter.toString(), Type.title, color = if (on) Palette.text else Palette.text4, modifier = Modifier.padding(start = 8.dp, bottom = 4.dp))
                }
            }
        }
    }
}

@Composable
private fun BoxScope.PromptPanel(host: UiHost) {
    val req = rememberLast(host.prompt)
    AnimatedVisibility(
        host.prompt != null,
        modifier = Modifier.align(Alignment.TopCenter),
        enter = slideInVertically(tween(300, easing = ZoonEase)) { -it } + fadeIn(),
        exit = slideOutVertically(tween(200)) { -it } + fadeOut(),
    ) {
        if (req == null) return@AnimatedVisibility
        var text by remember(req) { mutableStateOf(req.initial) }
        val focus = remember { FocusRequester() }
        val accent = LocalAccent.current
        LaunchedEffect(req) { runCatching { focus.requestFocus() } }
        Column(Modifier.fillMaxWidth().background(Color(0xFF141414)).statusBarsPadding().imePadding().padding(22.dp)) {
            ZText(req.title, Type.label, color = Palette.text2)
            Spacer(Modifier.height(10.dp))
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                textStyle = Type.title.copy(color = Palette.text),
                cursorBrush = SolidColor(accent),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    host.prompt = null
                    req.onConfirm(text)
                }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).border(1.dp, Palette.line).padding(12.dp),
            )
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                ActionLink(req.confirm, null, onClick = {
                    host.prompt = null
                    req.onConfirm(text)
                }, accent = true)
                ActionLink("cancel", null, onClick = { host.prompt = null })
            }
        }
    }
}

@Composable
private fun BoxScope.ConfirmPanel(host: UiHost) {
    val req = rememberLast(host.confirm)
    AnimatedVisibility(
        host.confirm != null,
        modifier = Modifier.align(Alignment.Center),
        enter = fadeIn(tween(180)) + slideInVertically(tween(300, easing = ZoonEase)) { it / 6 },
        exit = fadeOut(tween(150)),
    ) {
        if (req == null) return@AnimatedVisibility
        Column(Modifier.fillMaxWidth().padding(20.dp).background(Color(0xFF161616)).padding(22.dp)) {
            ZText(req.title, Type.title)
            Spacer(Modifier.height(8.dp))
            ZText(req.text, Type.body, color = Palette.text2)
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                ActionLink(req.confirm, null, onClick = {
                    host.confirm = null
                    req.onConfirm()
                }, accent = true)
                ActionLink("cancel", null, onClick = { host.confirm = null })
            }
        }
    }
}

@Composable
private fun BoxScope.Toast(host: UiHost) {
    val text = host.toastText
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(host.toastId) {
        if (host.toastId == 0) return@LaunchedEffect
        visible = true
        delay(2600)
        visible = false
    }
    AnimatedVisibility(
        visible && text != null,
        modifier = Modifier.align(Alignment.TopCenter),
        enter = slideInVertically(tween(280, easing = ZoonEase)) { -it } + fadeIn(),
        exit = slideOutVertically(tween(220)) { -it } + fadeOut(),
    ) {
        Box(Modifier.fillMaxWidth().background(Color(0xF0161616)).statusBarsPadding().padding(horizontal = 20.dp, vertical = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(width = 3.dp, height = 22.dp).background(LocalAccent.current))
                Spacer(Modifier.width(12.dp))
                ZText(text ?: "", Type.body, maxLines = 3)
            }
        }
    }
}
