package com.a44kaliburll.zoon.ui.components

import android.os.SystemClock
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import com.a44kaliburll.zoon.playback.AudioLevels
import kotlin.math.max
import kotlinx.coroutines.delay

/** Zune/WP7 "decelerate" curve: quick start, long soft landing. */
val ZoonEase = CubicBezierEasing(0.1f, 0.9f, 0.2f, 1f)

/** When the current screen appeared (uptime ms); list items that show up right away feather in. */
val LocalScreenStart = compositionLocalOf { 0L }

/**
 * The feathered turnstile: items swing in on a hinge at the screen's left edge, one after
 * another. Only for items that are on screen when the page opens, not while scrolling.
 */
fun Modifier.featherIn(index: Int, delayMs: Long = 0): Modifier = composed {
    val start = LocalScreenStart.current
    val animate = remember { SystemClock.uptimeMillis() - start < 500 && index < 16 }
    if (!animate) return@composed this
    val p = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        delay(delayMs + index * 34L)
        p.animateTo(1f, tween(460, easing = ZoonEase))
    }
    graphicsLayer {
        val v = p.value
        rotationY = -72f * (1f - v)
        transformOrigin = TransformOrigin(0f, 0.5f)
        cameraDistance = 16f * density
        translationX = 36f * density * (1f - v)
        alpha = (v * 1.8f).coerceAtMost(1f)
    }
}

/** Seconds since this started running; frozen while [running] is false. */
@Composable
fun rememberLoopClock(running: Boolean = true): State<Float> {
    val t = remember { mutableFloatStateOf(0f) }
    LaunchedEffect(running) {
        if (!running) return@LaunchedEffect
        var last = -1L
        while (true) {
            withFrameNanos { now ->
                if (last > 0) t.floatValue += (now - last) / 1e9f
                last = now
            }
        }
    }
    return t
}

/**
 * How hard the music is hitting right now, 0..1: bass-weighted loudness from [AudioLevels],
 * auto-levelled so quiet songs still breathe. Drives the glows.
 */
@Composable
fun rememberPulse(levels: AudioLevels, active: Boolean): State<Float> {
    val out = remember { mutableFloatStateOf(0f) }
    LaunchedEffect(active) {
        if (!active) {
            val from = out.floatValue
            Animatable(from).animateTo(0f, tween(500)) { out.floatValue = value }
            return@LaunchedEffect
        }
        val buf = FloatArray(2)
        var peak = 0.06f
        var smooth = out.floatValue
        while (true) {
            withFrameNanos {
                levels.read(buf, System.nanoTime())
                val v = buf[1] * 0.7f + buf[0] * 0.3f
                peak = max(v, peak * 0.997f).coerceAtLeast(0.025f)
                val target = (v / peak).coerceIn(0f, 1f)
                smooth += (target - smooth) * (if (target > smooth) 0.5f else 0.09f)
                out.floatValue = smooth
            }
        }
    }
    return out
}
