package com.a44kaliburll.zoon.ui.theme

import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp
import com.a44kaliburll.zoon.R

/** Selawik: Microsoft's open-source stand-in for Segoe, the family Zune's "Zegoe" came from. */
val Selawik = FontFamily(
    Font(R.font.selawik_light, FontWeight.Light),
    Font(R.font.selawik_semilight, FontWeight(350)),
    Font(R.font.selawik_regular, FontWeight.Normal),
    Font(R.font.selawik_semibold, FontWeight.SemiBold),
    Font(R.font.selawik_bold, FontWeight.Bold),
)

private val tight = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.Both)

private fun style(size: Int, weight: FontWeight, line: Float = size * 1.12f, spacing: Float = 0f) = TextStyle(
    fontFamily = Selawik,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = line.sp,
    letterSpacing = spacing.sp,
    lineHeightStyle = tight,
)

/** Zune HD type ramp: huge light lowercase headers, big list items, small grey details. */
object Type {
    val giant = style(150, FontWeight.Light, 150f, -6f)
    val menu = style(60, FontWeight.Light, 64f, -2f)
    val pivot = style(50, FontWeight.Light, 56f, -1.5f)
    val hero = style(58, FontWeight.Light, 60f, -2f)
    val title = style(34, FontWeight.Light, 38f, -0.8f)
    val itemLarge = style(30, FontWeight.Light, 36f, -0.5f)
    val item = style(20, FontWeight(350), 25f)
    val body = style(16, FontWeight.Normal, 21f)
    val sub = style(14, FontWeight.Normal, 18f)
    val small = style(12, FontWeight.Normal, 15f)
    val label = style(14, FontWeight.SemiBold, 18f, 0.3f)
    val number = style(64, FontWeight.Light, 64f, 2f)
}

object Palette {
    val bg = Color(0xFF000000)
    val text = Color(0xFFFFFFFF)
    val text2 = Color(0xB3FFFFFF)
    val text3 = Color(0x73FFFFFF)
    val text4 = Color(0x40FFFFFF)
    val line = Color(0x24FFFFFF)
    val panel = Color(0xFF111111)
    val pink = Color(0xFFF10E9C)
    val orange = Color(0xFFEA4E1F)
    val brand = Brush.linearGradient(listOf(pink, orange))
}

/** Accent colours: Zune magenta first, then the Smart DJ tints from the desktop app. */
val Accents = listOf(
    "magenta" to 0xFFE3007BL,
    "orange" to 0xFFF09609L,
    "lime" to 0xFF9BBF2AL,
    "blue" to 0xFF1BA1E2L,
    "purple" to 0xFFA05AFFL,
    "teal" to 0xFF00ABA9L,
    "red" to 0xFFE51400L,
    "gold" to 0xFFD8C100L,
)

val LocalAccent = staticCompositionLocalOf { Color(0xFFE3007B) }

@Composable
fun ZoonTheme(accent: Color, content: @Composable () -> Unit) {
    CompositionLocalProvider(
        LocalAccent provides accent,
        LocalTextSelectionColors provides TextSelectionColors(handleColor = accent, backgroundColor = accent.copy(alpha = 0.35f)),
        content = content,
    )
}
