package app.muneplayer.data

import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

const val LOVE = "love"
const val HATE = "hate"

data class Settings(
    val accent: Long = 0xFFE3007B,
    /** Home and now playing backdrop: "artist" photos, the "mune" glow, or plain "black". */
    val background: String = "artist",
    val artistPhotos: Boolean = true,
    val onlineArt: Boolean = true,
    val related: Boolean = true,
    val resume: Boolean = true,
    val keepScreenOn: Boolean = false,
    val autoSync: Boolean = true,
    val removeDeleted: Boolean = true,
    val syncAll: Boolean = true,
    val syncAlbums: Set<String> = emptySet(),
    val syncPlaylists: Set<String> = emptySet(),
    val welcomed: Boolean = false,
    /** What the PC calls this phone; empty = the phone's own device name. */
    val phoneName: String = "",
)

data class Session(val keys: List<String>, val index: Int, val positionMs: Long, val shuffle: Boolean, val repeat: Int)

/** Plays and hearts for PC songs that haven't been reported to the PC yet (keyed by PC track id). */
data class Pending(
    val plays: Map<String, Int> = emptyMap(),
    val lastPlayed: Map<String, Long> = emptyMap(),
    /** "love", "hate", or "" for a heart that was cleared. */
    val ratings: Map<String, String> = emptyMap(),
) {
    val isEmpty get() = plays.isEmpty() && lastPlayed.isEmpty() && ratings.isEmpty()
}

data class UserData(
    val ratings: Map<String, String> = emptyMap(),
    val plays: Map<String, Int> = emptyMap(),
    val lastPlayed: Map<String, Long> = emptyMap(),
    val pins: List<Ref> = emptyList(),
    val history: List<Ref> = emptyList(),
    val playlists: List<Playlist> = emptyList(),
    val pending: Pending = Pending(),
    val session: Session? = null,
    val settings: Settings = Settings(),
)

/**
 * Hearts, play counts, pins, history, phone playlists, settings and the last queue:
 * one JSON file in app storage, saved a moment after each change.
 */
class UserStore(private val file: File, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(load())
    val state: StateFlow<UserData> = _state
    val data get() = _state.value
    private var saveJob: Job? = null

    fun update(fn: (UserData) -> UserData) {
        _state.update(fn)
        scheduleSave()
    }

    fun updateSettings(fn: (Settings) -> Settings) = update { it.copy(settings = fn(it.settings)) }

    // ------------------------------------------------------------------ hearts and plays
    fun rating(key: String): String? = data.ratings[key]

    fun setRating(song: Song, rating: String?) = update { d ->
        val ratings = if (rating == null) d.ratings - song.key else d.ratings + (song.key to rating)
        val pending = if (song.pcId != null) d.pending.copy(ratings = d.pending.ratings + (song.pcId to (rating ?: ""))) else d.pending
        d.copy(ratings = ratings, pending = pending)
    }

    /** Zune's heart button cycles: nothing -> love -> dislike -> nothing. */
    fun cycleRating(song: Song) = setRating(
        song,
        when (rating(song.key)) {
            null -> LOVE
            LOVE -> HATE
            else -> null
        },
    )

    fun recordPlay(song: Song) = update { d ->
        val now = System.currentTimeMillis()
        val pending = song.pcId?.let { id ->
            d.pending.copy(
                plays = d.pending.plays + (id to (d.pending.plays[id] ?: 0) + 1),
                lastPlayed = d.pending.lastPlayed + (id to now),
            )
        } ?: d.pending
        d.copy(
            plays = d.plays + (song.key to (d.plays[song.key] ?: 0) + 1),
            lastPlayed = d.lastPlayed + (song.key to now),
            pending = pending,
        )
    }

    /** After the PC accepted a report, forget exactly what was sent (newer plays stay queued). */
    fun reported(sent: Pending) = update { d ->
        val plays = d.pending.plays.mapValues { (k, v) -> v - (sent.plays[k] ?: 0) }.filterValues { it > 0 }
        val last = d.pending.lastPlayed.filter { (k, v) -> v > (sent.lastPlayed[k] ?: -1) }
        val ratings = d.pending.ratings.filter { (k, v) -> sent.ratings[k] != v }
        d.copy(pending = Pending(plays, last, ratings))
    }

    // ------------------------------------------------------------------ pins and history
    fun isPinned(type: String, id: String) = data.pins.any { it.type == type && it.id == id }

    fun togglePin(type: String, id: String) = update { d ->
        if (d.pins.any { it.type == type && it.id == id }) d.copy(pins = d.pins.filterNot { it.type == type && it.id == id })
        else d.copy(pins = listOf(Ref(type, id)) + d.pins)
    }

    fun addHistory(type: String, id: String) = update { d ->
        d.copy(history = (listOf(Ref(type, id)) + d.history.filterNot { it.type == type && it.id == id }).take(40))
    }

    // ------------------------------------------------------------------ playlists
    fun createPlaylist(name: String, keys: List<String>): Playlist {
        val p = Playlist(UUID.randomUUID().toString(), name.trim().ifEmpty { "Untitled Playlist" }, keys, modified = System.currentTimeMillis())
        update { it.copy(playlists = it.playlists + p) }
        return p
    }

    fun editPlaylist(id: String, fn: (Playlist) -> Playlist) = update { d ->
        d.copy(playlists = d.playlists.map { if (it.id == id) fn(it).copy(modified = System.currentTimeMillis()) else it })
    }

    fun deletePlaylist(id: String) = update { d ->
        d.copy(
            playlists = d.playlists.filterNot { it.id == id },
            pins = d.pins.filterNot { it.type == Ref.PLAYLIST && it.id == id },
            history = d.history.filterNot { it.type == Ref.PLAYLIST && it.id == id },
        )
    }

    fun saveSession(session: Session?) = update { it.copy(session = session) }

    // ------------------------------------------------------------------ persistence
    private fun scheduleSave() {
        saveJob?.cancel()
        saveJob = scope.launch(Dispatchers.IO) {
            delay(600)
            write(_state.value)
        }
    }

    fun flush() {
        saveJob?.cancel()
        write(_state.value)
    }

    @Synchronized
    private fun write(d: UserData) {
        val af = AtomicFile(file)
        val out = af.startWrite()
        try {
            out.write(toJson(d).toString().toByteArray(Charsets.UTF_8))
            af.finishWrite(out)
        } catch (e: Exception) {
            af.failWrite(out)
            Log.w("UserStore", "save failed", e)
        }
    }

    private fun load(): UserData = try {
        if (!file.exists()) UserData() else fromJson(JSONObject(String(AtomicFile(file).readFully(), Charsets.UTF_8)))
    } catch (e: Exception) {
        Log.w("UserStore", "could not read ${file.name}; starting fresh", e)
        runCatching { file.copyTo(File(file.parentFile, "${file.name}.corrupt-${System.currentTimeMillis()}")) }
        UserData()
    }

    companion object {
        private fun <V> JSONObject.toMap(get: (JSONObject, String) -> V): Map<String, V> =
            keys().asSequence().associateWith { get(this, it) }

        private fun refJson(r: Ref) = JSONObject().put("type", r.type).put("id", r.id).put("t", r.t)
        private fun refOf(o: JSONObject) = Ref(o.getString("type"), o.getString("id"), o.optLong("t"))
        private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }
        private fun JSONArray.strings() = (0 until length()).map { getString(it) }

        fun toJson(d: UserData): JSONObject {
            val s = d.settings
            return JSONObject()
                .put("v", 1)
                .put("ratings", JSONObject(d.ratings))
                .put("plays", JSONObject(d.plays))
                .put("lastPlayed", JSONObject(d.lastPlayed))
                .put("pins", JSONArray(d.pins.map(::refJson)))
                .put("history", JSONArray(d.history.map(::refJson)))
                .put("playlists", JSONArray(d.playlists.map { p ->
                    JSONObject().put("id", p.id).put("name", p.name).put("keys", JSONArray(p.songKeys)).put("modified", p.modified)
                }))
                .put("pending", JSONObject()
                    .put("plays", JSONObject(d.pending.plays))
                    .put("lastPlayed", JSONObject(d.pending.lastPlayed))
                    .put("ratings", JSONObject(d.pending.ratings)))
                .put("session", d.session?.let { se ->
                    JSONObject().put("keys", JSONArray(se.keys)).put("index", se.index).put("position", se.positionMs)
                        .put("shuffle", se.shuffle).put("repeat", se.repeat)
                })
                .put("settings", JSONObject()
                    .put("accent", s.accent)
                    .put("background", s.background)
                    .put("artistPhotos", s.artistPhotos)
                    .put("onlineArt", s.onlineArt)
                    .put("related", s.related)
                    .put("resume", s.resume)
                    .put("keepScreenOn", s.keepScreenOn)
                    .put("autoSync", s.autoSync)
                    .put("removeDeleted", s.removeDeleted)
                    .put("syncAll", s.syncAll)
                    .put("syncAlbums", JSONArray(s.syncAlbums.toList()))
                    .put("syncPlaylists", JSONArray(s.syncPlaylists.toList()))
                    .put("welcomed", s.welcomed)
                    .put("phoneName", s.phoneName))
        }

        fun fromJson(o: JSONObject): UserData {
            val def = Settings()
            val s = o.optJSONObject("settings") ?: JSONObject()
            val pend = o.optJSONObject("pending") ?: JSONObject()
            return UserData(
                ratings = o.optJSONObject("ratings")?.toMap { j, k -> j.getString(k) } ?: emptyMap(),
                plays = o.optJSONObject("plays")?.toMap { j, k -> j.getInt(k) } ?: emptyMap(),
                lastPlayed = o.optJSONObject("lastPlayed")?.toMap { j, k -> j.getLong(k) } ?: emptyMap(),
                pins = o.optJSONArray("pins")?.objects()?.map(::refOf) ?: emptyList(),
                history = o.optJSONArray("history")?.objects()?.map(::refOf) ?: emptyList(),
                playlists = o.optJSONArray("playlists")?.objects()?.map { p ->
                    Playlist(p.getString("id"), p.getString("name"), p.optJSONArray("keys")?.strings() ?: emptyList(), modified = p.optLong("modified"))
                } ?: emptyList(),
                pending = Pending(
                    plays = pend.optJSONObject("plays")?.toMap { j, k -> j.getInt(k) } ?: emptyMap(),
                    lastPlayed = pend.optJSONObject("lastPlayed")?.toMap { j, k -> j.getLong(k) } ?: emptyMap(),
                    ratings = pend.optJSONObject("ratings")?.toMap { j, k -> j.getString(k) } ?: emptyMap(),
                ),
                session = o.optJSONObject("session")?.let { se ->
                    Session(
                        keys = se.optJSONArray("keys")?.strings() ?: emptyList(),
                        index = se.optInt("index"),
                        positionMs = se.optLong("position"),
                        shuffle = se.optBoolean("shuffle"),
                        repeat = se.optInt("repeat"),
                    )
                },
                settings = Settings(
                    accent = s.optLong("accent", def.accent),
                    background = s.optString("background", def.background),
                    artistPhotos = s.optBoolean("artistPhotos", def.artistPhotos),
                    onlineArt = s.optBoolean("onlineArt", def.onlineArt),
                    related = s.optBoolean("related", def.related),
                    resume = s.optBoolean("resume", def.resume),
                    keepScreenOn = s.optBoolean("keepScreenOn", def.keepScreenOn),
                    autoSync = s.optBoolean("autoSync", def.autoSync),
                    removeDeleted = s.optBoolean("removeDeleted", def.removeDeleted),
                    syncAll = s.optBoolean("syncAll", def.syncAll),
                    syncAlbums = s.optJSONArray("syncAlbums")?.strings()?.toSet() ?: emptySet(),
                    syncPlaylists = s.optJSONArray("syncPlaylists")?.strings()?.toSet() ?: emptySet(),
                    welcomed = s.optBoolean("welcomed", def.welcomed),
                    phoneName = s.optString("phoneName", def.phoneName),
                ),
            )
        }
    }
}
