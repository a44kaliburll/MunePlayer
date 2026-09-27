package com.a44kaliburll.zoon.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** Thin line icons in the spirit of the Zune HD's glyphs (drawn white, tinted when shown). */
object ZIcons {
    private fun icon(name: String, stroke: String? = null, fill: String? = null, width: Float = 1.7f): ImageVector {
        val b = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
        if (fill != null) b.addPath(pathData = addPathNodes(fill), fill = SolidColor(Color.White))
        if (stroke != null) {
            b.addPath(
                pathData = addPathNodes(stroke),
                stroke = SolidColor(Color.White),
                strokeLineWidth = width,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        return b.build()
    }

    val play = icon("play", fill = "M9 6.5 L18 12 L9 17.5 Z")
    val pause = icon("pause", fill = "M7.5 6h3v12h-3z M13.5 6h3v12h-3z")
    val next = icon("next", fill = "M6.5 6.5 L14 12 L6.5 17.5 Z M15.5 6.5h2v11h-2z")
    val previous = icon("previous", fill = "M17.5 6.5 L10 12 L17.5 17.5 Z M6.5 6.5h2v11h-2z")
    val shuffle = icon("shuffle", stroke = "M3.5 7.5h3c3.5 0 5.5 9 9.5 9h4 M17.5 14l2.5 2.5-2.5 2.5 M3.5 16.5h3c1.3 0 2.3-1 3.1-2.4 M13.2 9.9c.8-1.4 1.8-2.4 3-2.4h3.8 M17.5 5l2.5 2.5-2.5 2.5")
    val repeat = icon("repeat", stroke = "M4.5 11V9.5a2.5 2.5 0 0 1 2.5-2.5h12 M16.5 4.5 19 7l-2.5 2.5 M19.5 13v1.5a2.5 2.5 0 0 1-2.5 2.5H5 M7.5 19.5 5 17l2.5-2.5")
    val repeatOne = icon("repeatOne", stroke = "M4.5 11V9.5a2.5 2.5 0 0 1 2.5-2.5h12 M16.5 4.5 19 7l-2.5 2.5 M19.5 13v1.5a2.5 2.5 0 0 1-2.5 2.5H5 M7.5 19.5 5 17l2.5-2.5 M11.3 10.8l1.2-.8v4.6")
    val heart = icon("heart", stroke = "M12 19.5s-7.2-4.5-7.2-10A4.1 4.1 0 0 1 12 6.8a4.1 4.1 0 0 1 7.2 2.7c0 5.5-7.2 10-7.2 10z")
    val heartFilled = icon("heartFilled", fill = "M12 19.5s-7.2-4.5-7.2-10A4.1 4.1 0 0 1 12 6.8a4.1 4.1 0 0 1 7.2 2.7c0 5.5-7.2 10-7.2 10z")
    val heartBroken = icon("heartBroken", stroke = "M12 19.5s-7.2-4.5-7.2-10A4.1 4.1 0 0 1 12 6.8a4.1 4.1 0 0 1 7.2 2.7c0 5.5-7.2 10-7.2 10z M12 6.8l-1.6 3.4 2.6 2-1.6 3.6")
    val search = icon("search", stroke = "M10.5 4.5a6 6 0 1 0 0 12 6 6 0 1 0 0-12z M15 15l4.5 4.5")
    val queue = icon("queue", stroke = "M4 6.5h16 M4 11.5h16 M4 16.5h9 M16.5 14.5v5.5 M16.5 14.5l3.5 2.2-3.5 2.2", width = 1.6f)
    val sync = icon("sync", stroke = "M19.5 11A7.5 7.5 0 0 0 6 6.6 M4.5 4v4h4 M4.5 13A7.5 7.5 0 0 0 18 17.4 M19.5 20v-4h-4")
    val dj = icon("dj", stroke = "M12 3.5v4 M12 16.5v4 M3.5 12h4 M16.5 12h4 M6 6l2.8 2.8 M15.2 15.2 18 18 M6 18l2.8-2.8 M15.2 8.8 18 6")
    val more = icon("more", fill = "M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3z M12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3z M19 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 1 1 0-3z")
    val plus = icon("plus", stroke = "M12 5v14 M5 12h14")
    val check = icon("check", stroke = "M5 12.5l4.5 4.5L19 7.5", width = 2f)
    val close = icon("close", stroke = "M6 6l12 12 M18 6 6 18")
    val pin = icon("pin", stroke = "M8.5 4h7 M10 4v5.5L7 14h10l-3-4.5V4 M12 14v6.5")
    val back = icon("back", stroke = "M15 5l-7 7 7 7")
    val down = icon("down", stroke = "M6 9l6 6 6-6")
    val settings = icon("settings", stroke = "M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 1 0 0-6.4z M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1")
    val note = icon("note", stroke = "M9 17.5V6.5l10-2v11 M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z M19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z")
    val pc = icon("pc", stroke = "M3.5 5h17v11h-17z M9 20h6 M12 16v4")
    val phone = icon("phone", stroke = "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2")
    val trash = icon("trash", stroke = "M5 7h14 M10 7V4.5h4V7 M7 7l1 13h8l1-13")
    val edit = icon("edit", stroke = "M4 20h4L19 9l-4-4L4 16z")
    val wifi = icon("wifi", stroke = "M2.5 9a14 14 0 0 1 19 0 M5.5 12.5a9.5 9.5 0 0 1 13 0 M8.5 16a5 5 0 0 1 7 0 M12 19.5h.01", width = 1.8f)
}
