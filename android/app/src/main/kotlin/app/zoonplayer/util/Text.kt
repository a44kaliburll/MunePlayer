package app.zoonplayer.util

import android.icu.text.Collator
import android.icu.text.RuleBasedCollator
import java.security.MessageDigest
import java.text.Normalizer
import java.util.Locale

private val SPACES = Regex("\\s+")
private val THE = Regex("^\\s*the\\s+", RegexOption.IGNORE_CASE)
private val LEADING = Regex("^[^\\p{L}\\p{N}]+")
private val UNSAFE = Regex("[<>:\"/\\\\|?*\\x00-\\x1f]")

/** Case- and space-insensitive comparison key (same as the desktop app's norm()). */
fun norm(s: String?): String =
    Normalizer.normalize(s ?: "", Normalizer.Form.NFKC).trim().replace(SPACES, " ").lowercase(Locale.ROOT)

/** "The Beatles" sorts under B, like Zune. */
fun sortName(s: String): String = s.replace(THE, "").replace(LEADING, "")

/** Locale-aware, accent/case-insensitive, "track 2" before "track 10". Frozen, so thread-safe. */
val nameCollator: Collator = (Collator.getInstance() as RuleBasedCollator).apply {
    strength = Collator.PRIMARY
    numericCollation = true
}.freeze()

fun <T> byName(get: (T) -> String): Comparator<T> = Comparator { a, b -> nameCollator.compare(sortName(get(a)), sortName(get(b))) }

/** First 12 hex characters of SHA-1: the same ids the desktop app uses. */
fun hash12(s: String): String {
    val d = MessageDigest.getInstance("SHA-1").digest(s.toByteArray(Charsets.UTF_8))
    val sb = StringBuilder(40)
    for (b in d) sb.append("%02x".format(b))
    return sb.substring(0, 12)
}

/** Jump-list letter for a name: a-z, or '#' for everything else. */
fun letterOf(name: String): Char {
    val first = sortName(name).firstOrNull() ?: return '#'
    val base = Normalizer.normalize(first.toString(), Normalizer.Form.NFD).first().lowercaseChar()
    return if (base in 'a'..'z') base else '#'
}

fun fmtTime(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

fun plural(n: Int, word: String, many: String = word + "s") = "$n ${if (n == 1) word else many}"

/** A name that is safe as a file or folder name on Android's shared storage. */
fun safeFileName(s: String, fallback: String): String {
    val cleaned = s.replace(UNSAFE, "").trim().trimEnd('.', ' ').take(90)
    return cleaned.ifEmpty { fallback }
}

fun ago(ts: Long, now: Long = System.currentTimeMillis()): String {
    if (ts <= 0) return "never"
    val m = ((now - ts) / 60000).toInt()
    return when {
        m < 1 -> "just now"
        m < 60 -> "${plural(m, "minute")} ago"
        m < 60 * 24 -> "${plural(m / 60, "hour")} ago"
        else -> "${plural(m / (60 * 24), "day")} ago"
    }
}
