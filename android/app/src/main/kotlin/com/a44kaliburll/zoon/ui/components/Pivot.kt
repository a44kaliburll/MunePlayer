package com.a44kaliburll.zoon.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.PagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.a44kaliburll.zoon.ui.theme.Palette
import com.a44kaliburll.zoon.ui.theme.Type
import kotlin.math.abs
import kotlin.math.floor
import kotlinx.coroutines.launch

/**
 * Zune HD pivot headers: giant lowercase words in a row. The current one sits at the left
 * edge in white, the rest trail off the right side in grey, and the row slides with your
 * finger as you swipe between lists.
 */
@Composable
fun PivotHeader(titles: List<String>, pager: PagerState, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    Layout(
        modifier = modifier.fillMaxWidth().padding(start = 18.dp),
        content = {
            titles.forEachIndexed { i, title ->
                ZText(
                    title,
                    Type.pivot,
                    maxLines = 1,
                    softWrap = false,
                    modifier = Modifier
                        .graphicsLayer {
                            val f = pager.currentPage + pager.currentPageOffsetFraction
                            val d = abs(i - f).coerceAtMost(1f)
                            alpha = 1f - 0.62f * d
                        }
                        .pressable(scaleTo = 0.95f) { scope.launch { pager.animateScrollToPage(i) } },
                    color = Palette.text,
                )
            }
        },
    ) { measurables, constraints ->
        val placeables = measurables.map { it.measure(Constraints()) }
        val gap = 22.dp.roundToPx()
        val xs = IntArray(placeables.size)
        var x = 0
        placeables.forEachIndexed { i, p ->
            xs[i] = x
            x += p.width + gap
        }
        val height = placeables.maxOfOrNull { it.height } ?: 0
        layout(constraints.maxWidth, height) {
            val f = (pager.currentPage + pager.currentPageOffsetFraction).coerceIn(0f, (titles.size - 1).toFloat())
            val i0 = floor(f).toInt().coerceIn(0, titles.lastIndex)
            val i1 = (i0 + 1).coerceAtMost(titles.lastIndex)
            val shift = xs[i0] + (xs[i1] - xs[i0]) * (f - i0)
            placeables.forEachIndexed { i, p -> p.placeRelative((xs[i] - shift).toInt(), 0) }
        }
    }
}
