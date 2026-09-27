package app.zoonplayer.youtube

import android.util.AtomicFile
import app.zoonplayer.BuildConfig
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

/** A song or music video on YouTube. */
data class YtItem(val id: String, val title: String, val artist: String, val thumb: String?, val duration: Int?)

data class YtPlaylist(val id: String, val title: String, val count: Int?, val thumb: String?)

/** A device sign-in in progress: the code to enter at [url]. */
data class YtSignin(val code: String, val url: String, val expires: Long)

data class YtState(
    val configured: Boolean = false,
    val clientId: String? = null,
    val signedIn: Boolean = false,
    val channel: String? = null,
    val signin: YtSignin? = null,
    val error: String? = null,
)

/** What the YouTube player screen plays: a list and a position in it. */
data class YtQueue(val items: List<YtItem>, val index: Int) {
    val current: YtItem? get() = items.getOrNull(index)
}

class YtError(message: String) : IOException(message)

private class OAuthError(val code: String?, message: String) : IOException(message)

/**
 * YouTube Music through YouTube's official APIs, as in the desktop app (server/youtube.js): the
 * person's own Google OAuth client ("TVs and Limited Input devices"), Google's device sign-in (a
 * code approved at google.com/device), and the YouTube Data API for search, playlists and liked
 * songs. Songs play in YouTube's embedded player (YouTubePlayerScreen), with video. The sign-in
 * lives in youtube.json, which is kept out of backups.
 */
class YouTube(private val http: OkHttpClient, private val file: File, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(YtState())
    val state: StateFlow<YtState> = _state

    /** The list the player screen is playing from. */
    val queue = MutableStateFlow<YtQueue?>(null)

    /** The music page reopens on the last search (cached, so it costs no quota). */
    var lastQuery = ""

    private var clientId: String? = null
    private var clientSecret: String? = null
    private var refresh: String? = null
    private var channel: String? = null
    private var access: String? = null
    private var accessExpires = 0L
    private var signin: YtSignin? = null
    private var signinJob: Job? = null
    private var error: String? = null
    private val cache = ConcurrentHashMap<String, Pair<Long, Any>>()

    init {
        load()
        publish()
    }

    fun play(items: List<YtItem>, index: Int) {
        queue.value = YtQueue(items, index)
    }

    fun step(by: Int) {
        val q = queue.value ?: return
        val i = q.index + by
        if (i in q.items.indices) queue.value = q.copy(index = i)
    }

    // ------------------------------------------------------------ client and sign-in
    fun configure(id: String, secret: String) {
        val cid = id.trim()
        val csecret = secret.trim()
        if (!CLIENT_ID.matches(cid)) throw YtError("That isn't a Google OAuth client ID (they end in \".apps.googleusercontent.com\").")
        if (csecret.isEmpty() || csecret.any { it.isWhitespace() }) throw YtError("Paste the client secret as well.")
        if (cid != clientId) forget()
        clientId = cid
        clientSecret = csecret
        error = null
        save()
        publish()
    }

    fun removeClient() {
        signOut()
        clientId = null
        clientSecret = null
        save()
        publish()
    }

    fun startSignIn() {
        val id = clientId
        val secret = clientSecret
        if (id == null || secret == null) {
            error = "Add your Google OAuth client first."
            return publish()
        }
        cancelSignIn()
        error = null
        signinJob = scope.launch {
            try {
                val r = form("device/code", mapOf("client_id" to id, "scope" to SCOPE))
                val code = YtSignin(
                    r.getString("user_code"),
                    r.optString("verification_url").ifEmpty { r.optString("verification_uri") },
                    System.currentTimeMillis() + r.optLong("expires_in", 1800) * 1000,
                )
                signin = code
                publish()
                val device = r.getString("device_code")
                var interval = maxOf(5, r.optInt("interval", 5)) * 1000L
                while (isActive) {
                    delay(interval)
                    if (System.currentTimeMillis() > code.expires) {
                        error = "The sign-in code expired. Try again."
                        break
                    }
                    try {
                        keep(form("token", mapOf("client_id" to id, "client_secret" to secret, "device_code" to device, "grant_type" to DEVICE_GRANT)))
                        channel = runCatching { channelTitle() }.getOrNull()
                        save()
                        break
                    } catch (e: OAuthError) {
                        when (e.code) {
                            "authorization_pending", null -> Unit // not yet, or a network hiccup
                            "slow_down" -> interval += 5000
                            else -> {
                                error = e.message
                                break
                            }
                        }
                    }
                }
            } catch (e: OAuthError) {
                error = e.message
            } finally {
                signin = null
                publish()
            }
        }
    }

    fun cancelSignIn() {
        signinJob?.cancel()
        signinJob = null
        signin = null
        publish()
    }

    fun signOut() {
        val r = refresh
        cancelSignIn()
        forget()
        error = null
        save()
        publish()
        if (r != null) scope.launch { runCatching { form("revoke", mapOf("token" to r)) } }
    }

    private fun forget() {
        refresh = null
        channel = null
        access = null
        cache.clear()
    }

    private fun publish() {
        _state.value = YtState(clientId != null && clientSecret != null, clientId, refresh != null, channel, signin, error)
    }

    private suspend fun form(endpoint: String, params: Map<String, String>): JSONObject = withContext(Dispatchers.IO) {
        val body = FormBody.Builder().apply { params.forEach { (k, v) -> add(k, v) } }.build()
        val req = Request.Builder().url("${BuildConfig.GOOGLE_OAUTH}/$endpoint").post(body).build()
        val res = try {
            http.newCall(req).execute()
        } catch (e: IOException) {
            throw OAuthError(null, "Couldn't reach Google. Check the internet connection.")
        }
        res.use {
            val j = runCatching { JSONObject(it.body.string()) }.getOrDefault(JSONObject())
            if (it.isSuccessful) return@withContext j
            val code = j.optString("error").ifEmpty { j.optString("error_code") }.ifEmpty { "http_${it.code}" }
            throw OAuthError(code, oauthMessage(code, j.optString("error_description"), it.code))
        }
    }

    private fun keep(t: JSONObject) {
        access = t.getString("access_token")
        accessExpires = System.currentTimeMillis() + (maxOf(120, t.optInt("expires_in", 3600)) - 60) * 1000L
        t.optString("refresh_token").takeIf { it.isNotEmpty() }?.let { refresh = it }
    }

    private suspend fun token(): String {
        access?.takeIf { System.currentTimeMillis() < accessExpires }?.let { return it }
        val r = refresh ?: throw YtError("Sign in to YouTube Music first (settings › youtube music).")
        try {
            keep(form("token", mapOf("client_id" to clientId.orEmpty(), "client_secret" to clientSecret.orEmpty(), "refresh_token" to r, "grant_type" to "refresh_token")))
            return access!!
        } catch (e: OAuthError) {
            if (e.code == "invalid_grant" || e.code == "invalid_client") {
                forget()
                error = "Google signed Zoon out of YouTube (the sign-in expired or was removed). Sign in again."
                save()
                publish()
                throw YtError(error!!)
            }
            throw YtError(e.message ?: "Couldn't sign in to YouTube")
        }
    }

    // ------------------------------------------------------------ YouTube Data API
    private suspend fun get(resource: String, params: Map<String, String>): JSONObject = withContext(Dispatchers.IO) {
        val url = "${BuildConfig.YOUTUBE_API}/$resource".toHttpUrl().newBuilder().apply { params.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        repeat(2) { attempt ->
            val req = Request.Builder().url(url).header("Authorization", "Bearer ${token()}").header("Accept", "application/json").build()
            val res = try {
                http.newCall(req).execute()
            } catch (e: IOException) {
                throw YtError("Couldn't reach YouTube. Check the internet connection.")
            }
            res.use {
                if (it.code == 401 && attempt == 0) {
                    access = null
                    return@repeat
                }
                val j = runCatching { JSONObject(it.body.string()) }.getOrDefault(JSONObject())
                if (it.isSuccessful) return@withContext j
                val reason = j.optJSONObject("error")?.optJSONArray("errors")?.optJSONObject(0)?.optString("reason")
                throw YtError(
                    when (reason) {
                        "quotaExceeded", "dailyLimitExceeded" -> "Your Google project has used up today's YouTube quota. It resets at midnight Pacific time."
                        "accessNotConfigured", "SERVICE_DISABLED" -> "The YouTube Data API v3 isn't enabled in your Google Cloud project."
                        else -> "YouTube answered: ${j.optJSONObject("error")?.optString("message")?.ifEmpty { null } ?: it.code}"
                    },
                )
            }
        }
        throw YtError("YouTube didn't accept the sign-in. Try signing in again.")
    }

    private suspend fun pages(resource: String, params: Map<String, String>, take: (List<JSONObject>) -> Int) {
        var pageToken: String? = null
        repeat(MAX_PAGES) {
            val r = get(resource, params + ("maxResults" to "50") + (pageToken?.let { mapOf("pageToken" to it) } ?: emptyMap()))
            if (take(r.optJSONArray("items").objects()) >= MAX_ITEMS) return
            pageToken = r.optString("nextPageToken").ifEmpty { return }
        }
    }

    private suspend fun channelTitle(): String? =
        get("channels", mapOf("part" to "snippet", "mine" to "true")).optJSONArray("items").objects().firstOrNull()
            ?.optJSONObject("snippet")?.optString("title")

    /** Full details (for durations) in the order given; videos that are gone or can't be embedded drop out. */
    private suspend fun videos(ids: List<String>): List<YtItem> {
        val found = HashMap<String, JSONObject>()
        for (chunk in ids.chunked(50)) {
            val r = get("videos", mapOf("part" to "snippet,contentDetails,status", "id" to chunk.joinToString(","), "maxResults" to "50"))
            for (v in r.optJSONArray("items").objects()) if (v.optJSONObject("status")?.optBoolean("embeddable", true) != false) found[v.optString("id")] = v
        }
        return ids.mapNotNull { id -> found[id]?.let { toItem(it) } }
    }

    @Suppress("UNCHECKED_CAST")
    private suspend fun <T : Any> cached(key: String, load: suspend () -> T): T {
        cache[key]?.let { (at, v) -> if (System.currentTimeMillis() - at < CACHE_MS) return v as T }
        return load().also { cache[key] = System.currentTimeMillis() to it }
    }

    /** Costs 100 of the Google project's 10,000 daily quota units; everything else here costs 1 per page. */
    suspend fun search(q: String): List<YtItem> = cached("s:$q") {
        val r = get("search", mapOf("part" to "snippet", "q" to q, "type" to "video", "videoCategoryId" to MUSIC, "videoEmbeddable" to "true", "maxResults" to "25"))
        videos(r.optJSONArray("items").objects().mapNotNull { it.optJSONObject("id")?.optString("videoId")?.ifEmpty { null } })
    }

    suspend fun playlists(): List<YtPlaylist> = cached("playlists") {
        val out = ArrayList<YtPlaylist>()
        pages("playlists", mapOf("part" to "snippet,contentDetails", "mine" to "true")) { page ->
            for (p in page) {
                val s = p.optJSONObject("snippet")
                out += YtPlaylist(p.optString("id"), s?.optString("title").orEmpty(), p.optJSONObject("contentDetails")?.optInt("itemCount"), thumbOf(s))
            }
            out.size
        }
        out
    }

    suspend fun playlist(id: String): List<YtItem> = cached("l:$id") {
        val ids = ArrayList<String>()
        pages("playlistItems", mapOf("part" to "contentDetails", "playlistId" to id)) { page ->
            for (it in page) it.optJSONObject("contentDetails")?.optString("videoId")?.ifEmpty { null }?.let(ids::add)
            ids.size
        }
        videos(ids.take(MAX_ITEMS))
    }

    /** Liked videos in YouTube's Music category (likes in YouTube Music land there too). */
    suspend fun liked(): List<YtItem> = cached("liked") {
        val out = ArrayList<YtItem>()
        pages("videos", mapOf("part" to "snippet,contentDetails,status", "myRating" to "like")) { page ->
            for (v in page) {
                val music = v.optJSONObject("snippet")?.optString("categoryId") == MUSIC
                if (music && v.optJSONObject("status")?.optBoolean("embeddable", true) != false) out += toItem(v)
            }
            out.size
        }
        out.take(MAX_ITEMS)
    }

    // ------------------------------------------------------------ youtube.json
    private fun load() {
        runCatching {
            if (!file.exists()) return
            val o = JSONObject(String(AtomicFile(file).readFully()))
            clientId = o.optString("clientId").ifEmpty { null }
            clientSecret = o.optString("clientSecret").ifEmpty { null }
            refresh = o.optString("refresh").ifEmpty { null }
            channel = o.optString("channel").ifEmpty { null }
        }
    }

    private fun save() {
        val af = AtomicFile(file)
        val out = af.startWrite()
        try {
            out.write(
                JSONObject().put("clientId", clientId).put("clientSecret", clientSecret).put("refresh", refresh).put("channel", channel)
                    .toString().toByteArray(),
            )
            af.finishWrite(out)
        } catch (e: Exception) {
            af.failWrite(out)
        }
    }

    companion object {
        private const val SCOPE = "https://www.googleapis.com/auth/youtube.readonly"
        private const val DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
        private const val MUSIC = "10" // YouTube's Music video category
        private const val MAX_ITEMS = 200
        private const val MAX_PAGES = 20
        private const val CACHE_MS = 10 * 60 * 1000L
        private val CLIENT_ID = Regex("""^[\w.-]+\.apps\.googleusercontent\.com$""")
        private val ISO = Regex("""^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$""")

        /** "PT1H2M3S" -> 3723 */
        fun isoSeconds(d: String?): Int? {
            val m = ISO.matchEntire(d ?: return null) ?: return null
            val (days, h, min, s) = m.destructured
            return (days.toIntOrNull() ?: 0) * 86400 + (h.toIntOrNull() ?: 0) * 3600 + (min.toIntOrNull() ?: 0) * 60 + (s.toIntOrNull() ?: 0)
        }

        private fun thumbOf(snippet: JSONObject?): String? {
            val t = snippet?.optJSONObject("thumbnails") ?: return null
            return (t.optJSONObject("medium") ?: t.optJSONObject("high") ?: t.optJSONObject("default"))?.optString("url")?.ifEmpty { null }
        }

        /** "Queen - Topic" (YouTube Music's automatic artist channels) -> "Queen". */
        private fun toItem(v: JSONObject): YtItem {
            val s = v.optJSONObject("snippet")
            return YtItem(
                v.optString("id"),
                s?.optString("title").orEmpty(),
                s?.optString("channelTitle").orEmpty().removeSuffix(" - Topic"),
                thumbOf(s),
                isoSeconds(v.optJSONObject("contentDetails")?.optString("duration")),
            )
        }

        private fun oauthMessage(code: String, description: String, status: Int): String = when (code) {
            "invalid_client", "unauthorized_client" ->
                "Google doesn't recognise that client. Check the client ID and secret, and that the client's type is \"TVs and Limited Input devices\"."
            "access_denied" -> "Sign-in was cancelled on the Google page."
            "expired_token" -> "The sign-in code expired. Try again."
            "invalid_scope" -> "Google refused the YouTube permission. Is the YouTube Data API v3 enabled in your Google Cloud project?"
            else -> description.ifEmpty { "Google answered $status" }
        }

        private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
    }
}
