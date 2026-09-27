package app.zoonplayer.data

import android.util.AtomicFile
import android.util.Log
import app.zoonplayer.util.norm
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

data class ArtistInfo(val id: Long, val name: String, val picture: String?, val fans: Int)

/**
 * Stand-in for the retired Zune Marketplace data, like the desktop app: artist photos and
 * related artists from Deezer, missing covers from Deezer then iTunes. No keys; only artist
 * and album names are sent, and every answer (including "not found") is cached.
 */
class Online(
    private val http: OkHttpClient,
    private val file: File,
    private val scope: CoroutineScope,
    private val settings: () -> Settings,
) {
    private val gate = Mutex()
    private var last = 0L
    private val artists = ConcurrentHashMap<String, JSONObject>()
    private val related = ConcurrentHashMap<String, JSONObject>()
    private val albums = ConcurrentHashMap<String, JSONObject>()
    private val inflight = ConcurrentHashMap<String, Deferred<ArtistInfo?>>()
    private var saveJob: Job? = null

    init {
        load()
    }

    /** Big artist photo URL for now playing and artist pages (null when off or unknown). */
    suspend fun artistPhoto(name: String): String? = if (settings().artistPhotos) artist(name)?.picture else null

    /** Cached photo URL without touching the network (for first frames). */
    fun cachedPhoto(name: String): String? =
        if (settings().artistPhotos) artists[norm(name)]?.optString("picture")?.takeIf { it.isNotEmpty() } else null

    suspend fun artist(name: String): ArtistInfo? {
        if (name.isBlank() || name.equals(UNKNOWN_ARTIST, true) || name.equals(VARIOUS_ARTISTS, true)) return null
        val key = norm(name)
        artists[key]?.let { hit ->
            if (hit.has("id") || System.currentTimeMillis() - hit.optLong("t") < RETRY_MISS_MS) return hit.toInfo()
        }
        val job = inflight.getOrPut(key) {
            scope.async(Dispatchers.IO) { lookupArtist(name, key) }
        }
        return try {
            job.await()
        } finally {
            inflight.remove(key, job)
        }
    }

    private suspend fun lookupArtist(name: String, key: String): ArtistInfo? {
        val body = try {
            json("https://api.deezer.com/search/artist?q=${enc(name)}&limit=15")
        } catch (e: Exception) {
            Log.i(TAG, "artist lookup failed: ${e.message}")
            return null // don't cache network failures
        }
        // Deezer ranks obscure namesakes first (a 13-fan "Queen" before the band), so take the
        // most-followed artist whose name matches exactly.
        val data = body.optJSONArray("data") ?: JSONArray()
        val best = (0 until data.length()).map { data.getJSONObject(it) }
            .filter { simple(it.optString("name")) == simple(name) }
            .maxByOrNull { it.optInt("nb_fan") }
        val hit = JSONObject().put("t", System.currentTimeMillis())
        if (best != null) {
            val pic = best.optString("picture_xl").takeIf { it.isNotEmpty() && !it.contains("/artist//") }
            hit.put("id", best.optLong("id")).put("name", best.optString("name")).put("fans", best.optInt("nb_fan"))
            if (pic != null) hit.put("picture", pic)
        }
        artists[key] = hit
        save()
        return hit.toInfo()
    }

    /** Names of artists Deezer considers related (for Smart DJ and the artist page). */
    suspend fun related(name: String): List<String> {
        if (!settings().related) return emptyList()
        val key = norm(name)
        related[key]?.let { hit ->
            if (System.currentTimeMillis() - hit.optLong("t") < RETRY_MISS_MS) return hit.optJSONArray("names").strings()
        }
        val a = artist(name) ?: return emptyList()
        val names = try {
            val body = json("https://api.deezer.com/artist/${a.id}/related?limit=40")
            val d = body.optJSONArray("data") ?: JSONArray()
            (0 until d.length()).map { d.getJSONObject(it).optString("name") }.filter { it.isNotEmpty() }
        } catch (e: Exception) {
            return emptyList()
        }
        related[key] = JSONObject().put("t", System.currentTimeMillis()).put("names", JSONArray(names))
        save()
        return names
    }

    /** A cover image URL for an album with no art of its own. */
    suspend fun albumCoverUrl(artist: String, album: String): String? {
        if (!settings().onlineArt) return null
        val key = "${norm(artist)}|${norm(album)}"
        albums[key]?.let { hit ->
            val url = hit.optString("url")
            if (url.isNotEmpty() || System.currentTimeMillis() - hit.optLong("t") < RETRY_MISS_MS) return url.ifEmpty { null }
        }
        var url: String? = null
        var failed = false
        try {
            url = deezerAlbum(artist, album)
        } catch (e: Exception) {
            failed = true
        }
        if (url == null) {
            try {
                url = itunesAlbum(artist, album)
                failed = false
            } catch (e: Exception) {
            }
        }
        if (url == null && failed) return null
        albums[key] = JSONObject().put("t", System.currentTimeMillis()).apply { if (url != null) put("url", url) }
        save()
        return url
    }

    private suspend fun deezerAlbum(artist: String, album: String): String? {
        val bare = album.replace(BRACKETS, " ").replace(Regex("\\s+"), " ").trim().ifEmpty { album }
        val q = if (artist != VARIOUS_ARTISTS && artist != UNKNOWN_ARTIST) "$artist $bare" else bare
        val body = json("https://api.deezer.com/search/album?q=${enc(q)}&limit=10")
        val data = body.optJSONArray("data") ?: return null
        val best = (0 until data.length()).map { data.getJSONObject(it) }
            .map { it to score(it.optString("title"), it.optJSONObject("artist")?.optString("name"), album, artist) }
            .filter { it.second > 0 }
            .maxByOrNull { it.second }?.first ?: return null
        val url = best.optString("cover_xl").ifEmpty { best.optString("cover_big") }
        return url.takeIf { it.isNotEmpty() && !it.contains("/cover//") && !it.endsWith("/images/cover/") }
    }

    private suspend fun itunesAlbum(artist: String, album: String): String? {
        val term = "${if (artist != VARIOUS_ARTISTS) artist else ""} $album".trim()
        val body = json("https://itunes.apple.com/search?term=${enc(term)}&entity=album&media=music&limit=10")
        val data = body.optJSONArray("results") ?: return null
        val best = (0 until data.length()).map { data.getJSONObject(it) }
            .map { it to score(it.optString("collectionName"), it.optString("artistName"), album, artist) }
            .filter { it.second > 0 }
            .maxByOrNull { it.second }?.first ?: return null
        return best.optString("artworkUrl100").takeIf { it.isNotEmpty() }?.replace(Regex("/\\d+x\\d+bb\\."), "/600x600bb.")
    }

    /** Download a URL's bytes (album covers). */
    suspend fun download(url: String): ByteArray = withContext(Dispatchers.IO) {
        http.newCall(Request.Builder().url(url).header("User-Agent", UA).build()).execute().use { res ->
            if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
            res.body.bytes()
        }
    }

    private suspend fun json(url: String): JSONObject = withContext(Dispatchers.IO) {
        gate.withLock {
            val wait = last + 160 - System.currentTimeMillis()
            if (wait > 0) delay(wait)
            last = System.currentTimeMillis()
        }
        http.newCall(Request.Builder().url(url).header("User-Agent", UA).header("Accept", "application/json").build()).execute().use { res ->
            if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
            val body = JSONObject(res.body.string())
            if (body.has("error")) throw IOException("API error ${body.opt("error")}")
            body
        }
    }

    private fun save() {
        saveJob?.cancel()
        saveJob = scope.launch(Dispatchers.IO) {
            delay(1500)
            val o = JSONObject()
                .put("artists", JSONObject(artists as Map<*, *>))
                .put("related", JSONObject(related as Map<*, *>))
                .put("albums", JSONObject(albums as Map<*, *>))
            val af = AtomicFile(file)
            val out = af.startWrite()
            try {
                out.write(o.toString().toByteArray(Charsets.UTF_8))
                af.finishWrite(out)
            } catch (e: Exception) {
                af.failWrite(out)
            }
        }
    }

    private fun load() {
        if (!file.exists()) return
        try {
            val o = JSONObject(String(AtomicFile(file).readFully(), Charsets.UTF_8))
            o.optJSONObject("artists")?.let { a -> a.keys().forEach { k -> a.optJSONObject(k)?.let { artists[k] = it } } }
            o.optJSONObject("related")?.let { a -> a.keys().forEach { k -> a.optJSONObject(k)?.let { related[k] = it } } }
            o.optJSONObject("albums")?.let { a -> a.keys().forEach { k -> a.optJSONObject(k)?.let { albums[k] = it } } }
        } catch (e: Exception) {
            Log.w(TAG, "online cache unreadable", e)
        }
    }

    private fun JSONObject.toInfo(): ArtistInfo? =
        if (!has("id")) null else ArtistInfo(optLong("id"), optString("name"), optString("picture").ifEmpty { null }, optInt("fans"))

    private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }

    companion object {
        private const val TAG = "Online"
        private const val UA = "ZoonPlayer/1.0 (Android music player)"
        private const val RETRY_MISS_MS = 14L * 24 * 3600 * 1000
        private val BRACKETS = Regex("\\(.*?\\)|\\[.*?]")
        private val NON_WORD = Regex("[^\\p{L}\\p{N}]+")

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

        /** Loose title key: drops bracketed qualifiers and punctuation. */
        fun simple(s: String?): String = norm(s).replace(BRACKETS, " ").replace(NON_WORD, " ").trim()

        private fun score(candTitle: String, candArtist: String?, album: String, artist: String): Int {
            val a = simple(album)
            val c = simple(candTitle)
            if (a.isEmpty() || c.isEmpty()) return -1
            var s = when {
                c == a -> 3
                c.startsWith(a) || a.startsWith(c) -> 2
                c.contains(a) || a.contains(c) -> 1
                else -> return -1
            }
            if (artist != VARIOUS_ARTISTS && artist != UNKNOWN_ARTIST) {
                val x = simple(artist)
                val y = simple(candArtist)
                s += when {
                    x == y -> 2
                    x.isNotEmpty() && y.isNotEmpty() && (y.contains(x) || x.contains(y)) -> 1
                    else -> return -1
                }
            }
            return s
        }
    }
}
