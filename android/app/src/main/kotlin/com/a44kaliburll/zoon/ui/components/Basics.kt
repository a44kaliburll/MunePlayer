package com.a44kaliburll.zoon.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.a44kaliburll.zoon.data.Cover
import com.a44kaliburll.zoon.ui.theme.LocalAccent
import com.a44kaliburll.zoon.ui.theme.Palette
import com.a44kaliburll.zoon.ui.theme.Type
import com.a44kaliburll.zoon.ui.theme.ZIcons

@Composable
fun ZText(
    text: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
    color: Color = Palette.text,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Ellipsis,
    align: TextAlign? = null,
    softWrap: Boolean = true,
) {
    BasicText(
        text = text,
        modifier = modifier,
        style = if (align != null) style.copy(color = color, textAlign = align) else style.copy(color = color),
        maxLines = maxLines,
        overflow = overflow,
        softWrap = softWrap,
    )
}

/**
 * Tap and long-press without Material ripples: pressed items dip slightly, the way Zune HD
 * list items tilted under your finger.
 */
fun Modifier.pressable(
    onLongClick: (() -> Unit)? = null,
    scaleTo: Float = 0.965f,
    onClick: () -> Unit,
): Modifier = composed {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val haptics = LocalHapticFeedback.current
    val scale by animateFloatAsState(if (pressed) scaleTo else 1f, spring(dampingRatio = 0.55f, stiffness = 900f), label = "press")
    this
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
        }
        .combinedClickable(
            interactionSource = source,
            indication = null,
            onLongClick = onLongClick?.let { l ->
                {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    l()
                }
            },
            onClick = onClick,
        )
}

@Composable
fun ZIcon(icon: ImageVector, modifier: Modifier = Modifier, tint: Color = Palette.text, size: Dp = 24.dp) {
    Image(
        painter = rememberVectorPainter(icon),
        contentDescription = null,
        modifier = modifier.size(size),
        colorFilter = ColorFilter.tint(tint),
    )
}

/** The Zune HD's round, outlined transport buttons. */
@Composable
fun CircleButton(
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 52.dp,
    iconSize: Dp = size * 0.46f,
    tint: Color = Palette.text,
    filled: Boolean = false,
    ring: Color = Palette.text.copy(alpha = 0.85f),
) {
    Box(
        modifier
            .size(size)
            .pressable(scaleTo = 0.9f, onClick = onClick)
            .clip(CircleShape)
            .then(if (filled) Modifier.background(ring) else Modifier.border(1.6.dp, ring, CircleShape)),
        contentAlignment = Alignment.Center,
    ) {
        ZIcon(icon, tint = if (filled) Palette.bg else tint, size = iconSize)
    }
}

/** A lowercase text action with a small icon, like "play all" / "shuffle" on the Zune HD. */
@Composable
fun ActionLink(text: String, icon: ImageVector?, onClick: () -> Unit, modifier: Modifier = Modifier, accent: Boolean = false) {
    val color = if (accent) LocalAccent.current else Palette.text
    Row(
        modifier.pressable(onClick = onClick).padding(vertical = 8.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) {
            Box(Modifier.size(30.dp).border(1.4.dp, color, CircleShape), contentAlignment = Alignment.Center) {
                ZIcon(icon, tint = color, size = 16.dp)
            }
        }
        ZText(text, Type.item, color = color, maxLines = 1)
    }
}

/** Album art with a Zune-style placeholder (accent gradient and a note) while loading or missing. */
@Composable
fun AlbumArt(cover: Cover?, modifier: Modifier = Modifier, placeholderLabel: String? = null) {
    val accent = LocalAccent.current
    Box(modifier.clip(androidx.compose.ui.graphics.RectangleShape)) {
        Box(
            Modifier.fillMaxSize().background(
                Brush.linearGradient(listOf(accent.copy(alpha = 0.55f).compositeOverBlack(), Color(0xFF1A1A1A))),
            ),
            contentAlignment = Alignment.Center,
        ) {
            if (placeholderLabel != null) {
                ZText(placeholderLabel.lowercase(), Type.sub, color = Palette.text2, maxLines = 3, modifier = Modifier.padding(10.dp).width(200.dp))
            } else {
                ZIcon(ZIcons.note, tint = Palette.text3, size = 34.dp)
            }
        }
        if (cover != null) {
            AsyncImage(model = cover, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
    }
}

fun Color.compositeOverBlack(): Color = Color(red * alpha, green * alpha, blue * alpha, 1f)

/** Three bouncing bars next to whatever is playing. */
@Composable
fun EqBars(playing: Boolean, modifier: Modifier = Modifier, color: Color = LocalAccent.current) {
    val t = rememberLoopClock(playing)
    androidx.compose.foundation.Canvas(modifier.size(16.dp)) {
        val w = size.width / 5f
        val phases = floatArrayOf(0f, 1.7f, 3.1f)
        for (i in 0..2) {
            val h = if (playing) (0.35f + 0.65f * (0.5f + 0.5f * kotlin.math.sin(t.value * (5.5f + i) + phases[i]))) else 0.3f
            val bh = size.height * h
            drawRect(color, topLeft = androidx.compose.ui.geometry.Offset(i * 2 * w, size.height - bh), size = androidx.compose.ui.geometry.Size(w * 1.2f, bh))
        }
    }
}
