package com.a44kaliburll.zoon.sync

import android.util.AtomicFile
import android.util.Log
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/** A song file this app downloaded from the PC, with the PC's metadata for it. */
data class SyncedTrack(
    val pcId: String,
    val uri: String,
    val relativePath: String,
    val fileName: String,
    val size: Long,
    val mtime: Long,
    val pcAlbumId: String,
    val title: String,
    val artist: String?,
    val albumArtist: String,
    val album: String?,
    val genre: String?,
    val year: Int?,
    val track: Int?,
    val disc: Int?,
    val durationMs: Long,
    val added: Long,
) {
    val pathKey get() = (relativePath + fileName).lowercase()
}

data class PcAlbum(val id: String, val title: String, val artist: String, val year: Int?, val trackIds: List<String>, val art: Boolean?)

data class PcPlaylist(val id: String, val name: String, val trackIds: List<String>)

/**
 * What wireless sync put on the phone: file locations and PC metadata for each song,
 * plus the PC's albums, playlists and play counts from the last sync.
 */
class SyncManifest(private val file: File) {
    private val lock = Any()
    private var tracks = HashMap<String, SyncedTrack>()
    private var byPath = HashMap<String, SyncedTrack>()
    var albums: Map<String, PcAlbum> = emptyMap()
        private set
    var playlists: List<PcPlaylist> = emptyList()
        private set
    var pcPlays: Map<String, Int> = emptyMap()
        private set

    private val _version = MutableStateFlow(0)
    /** Bumped whenever the manifest changes, so the library can re-merge. */
    val version: StateFlow<Int> = _version

    init {
        load()
    }

    fun track(pcId: String): SyncedTrack? = synchronized(lock) { tracks[pcId] }
    fun byFile(relativePath: String, fileName: String): SyncedTrack? = synchronized(lock) { byPath[(relativePath + fileName).lowercase()] }
    fun all(): List<SyncedTrack> = synchronized(lock) { tracks.values.toList() }
    val count get() = synchronized(lock) { tracks.size }

    fun put(t: SyncedTrack) = synchronized(lock) {
        tracks[t.pcId]?.let { byPath.remove(it.pathKey) }
        tracks[t.pcId] = t
        byPath[t.pathKey] = t
    }

    fun remove(pcId: String) = synchronized(lock) {
        tracks.remove(pcId)?.let { byPath.remove(it.pathKey) }
    }

    fun setPcData(albums: Map<String, PcAlbum>, playlists: List<PcPlaylist>, plays: Map<String, Int>) = synchronized(lock) {
        this.albums = albums
        this.playlists = playlists
        this.pcPlays = plays
    }

    fun clear() = synchronized(lock) {
        tracks.clear()
        byPath.clear()
        albums = emptyMap()
        playlists = emptyList()
        pcPlays = emptyMap()
    }

    /** Write to disk and tell the library. */
    fun save() {
        val json = synchronized(lock) { toJson() }
        val af = AtomicFile(file)
        val out = af.startWrite()
        try {
            out.write(json.toString().toByteArray(Charsets.UTF_8))
            af.finishWrite(out)
        } catch (e: Exception) {
            af.failWrite(out)
            Log.w("SyncManifest", "save failed", e)
        }
        _version.value++
    }

    private fun toJson(): JSONObject = JSONObject()
        .put("v", 1)
        .put("tracks", JSONArray(tracks.values.map { t ->
            JSONObject().put("pcId", t.pcId).put("uri", t.uri).put("rel", t.relativePath).put("name", t.fileName)
                .put("size", t.size).put("mtime", t.mtime).put("album", t.pcAlbumId).put("title", t.title)
                .put("artist", t.artist).put("aa", t.albumArtist).put("albumTitle", t.album).put("genre", t.genre)
                .put("year", t.year).put("track", t.track).put("disc", t.disc).put("duration", t.durationMs).put("added", t.added)
        }))
        .put("albums", JSONArray(albums.values.map { a ->
            JSONObject().put("id", a.id).put("title", a.title).put("artist", a.artist).put("year", a.year)
                .put("trackIds", JSONArray(a.trackIds)).put("art", a.art)
        }))
        .put("playlists", JSONArray(playlists.map { p ->
            JSONObject().put("id", p.id).put("name", p.name).put("trackIds", JSONArray(p.trackIds))
        }))
        .put("plays", JSONObject(pcPlays))

    private fun load() {
        if (!file.exists()) return
        try {
            val o = JSONObject(String(AtomicFile(file).readFully(), Charsets.UTF_8))
            o.optJSONArray("tracks")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val j = arr.getJSONObject(i)
                    put(
                        SyncedTrack(
                            pcId = j.getString("pcId"),
                            uri = j.getString("uri"),
                            relativePath = j.getString("rel"),
                            fileName = j.getString("name"),
                            size = j.optLong("size"),
                            mtime = j.optLong("mtime"),
                            pcAlbumId = j.optString("album"),
                            title = j.optString("title"),
                            artist = j.optStringOrNull("artist"),
                            albumArtist = j.optString("aa"),
                            album = j.optStringOrNull("albumTitle"),
                            genre = j.optStringOrNull("genre"),
                            year = j.optIntOrNull("year"),
                            track = j.optIntOrNull("track"),
                            disc = j.optIntOrNull("disc"),
                            durationMs = j.optLong("duration"),
                            added = j.optLong("added"),
                        ),
                    )
                }
            }
            albums = o.optJSONArray("albums")?.let { arr ->
                (0 until arr.length()).map { arr.getJSONObject(it) }.associate { a ->
                    a.getString("id") to PcAlbum(
                        a.getString("id"), a.optString("title"), a.optString("artist"), a.optIntOrNull("year"),
                        a.optJSONArray("trackIds")?.let { t -> (0 until t.length()).map { t.getString(it) } } ?: emptyList(),
                        if (a.isNull("art")) null else a.optBoolean("art"),
                    )
                }
            } ?: emptyMap()
            playlists = o.optJSONArray("playlists")?.let { arr ->
                (0 until arr.length()).map { arr.getJSONObject(it) }.map { p ->
                    PcPlaylist(p.getString("id"), p.optString("name"), p.optJSONArray("trackIds")?.let { t -> (0 until t.length()).map { t.getString(it) } } ?: emptyList())
                }
            } ?: emptyList()
            pcPlays = o.optJSONObject("plays")?.let { p -> p.keys().asSequence().associateWith { p.getInt(it) } } ?: emptyMap()
        } catch (e: Exception) {
            Log.w("SyncManifest", "could not read ${file.name}", e)
        }
    }
}

fun JSONObject.optStringOrNull(name: String): String? = if (isNull(name)) null else optString(name).takeIf { it.isNotEmpty() }
fun JSONObject.optIntOrNull(name: String): Int? = if (isNull(name) || !has(name)) null else optInt(name)
fun JSONObject.optLongOrNull(name: String): Long? = if (isNull(name) || !has(name)) null else optLong(name)
