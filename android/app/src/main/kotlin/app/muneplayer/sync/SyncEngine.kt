package app.muneplayer.sync

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.webkit.MimeTypeMap
import app.muneplayer.AppGraph
import app.muneplayer.data.Pending
import app.muneplayer.util.safeFileName
import java.io.File
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

sealed interface SyncState {
    data object Idle : SyncState
    data class Running(
        val phase: String,
        val done: Int = 0,
        val total: Int = 0,
        val title: String? = null,
        val bytes: Long = 0,
        val totalBytes: Long = 0,
    ) : SyncState
    data class Done(val added: Int, val removed: Int, val songs: Int, val failed: List<String>, val at: Long) : SyncState
    data class Failed(val message: String, val at: Long) : SyncState
}

/** A song in the PC's collection, as /mune/v1/library describes it. */
data class PcTrack(
    val id: String,
    val title: String,
    val artist: String?,
    val albumArtist: String,
    val album: String?,
    val albumId: String,
    val genre: String?,
    val year: Int?,
    val track: Int?,
    val disc: Int?,
    val durationMs: Long,
    val ext: String,
    val size: Long?,
    val mtime: Long,
    val rating: String?,
    val plays: Int,
)

/**
 * Wireless sync, the Zune HD way: report plays and hearts to the PC, read its collection,
 * copy the songs that should be on the phone into Music/Mune/<artist>/<album>, fetch album
 * art, and remove songs that were taken out of the sync.
 */
class SyncEngine(private val context: Context, private val graph: AppGraph) {
    private val _state = MutableStateFlow<SyncState>(SyncState.Idle)
    val state: StateFlow<SyncState> = _state
    private val lock = Mutex()
    private val resolver: ContentResolver get() = context.contentResolver
    private val manifest get() = graph.manifest

    val running get() = _state.value is SyncState.Running

    /** The PC's collection from the last successful read, for the "choose what to sync" list. */
    private val _pcLibrary = MutableStateFlow<PcCollection?>(null)
    val pcLibrary: StateFlow<PcCollection?> = _pcLibrary

    data class PcCollection(val tracks: Map<String, PcTrack>, val albums: Map<String, PcAlbum>, val playlists: List<PcPlaylist>)

    suspend fun run(auto: Boolean = false): SyncState = lock.withLock {
        // The hourly check right after a sync (it waits on the lock while one runs) has nothing to do.
        val last = graph.pc.pc.value?.lastSync ?: 0L
        if (auto && System.currentTimeMillis() - last < 20 * 60_000L) return@withLock _state.value
        val result = try {
            doRun(auto)
        } catch (e: CancellationException) {
            _state.value = SyncState.Failed("Sync stopped", System.currentTimeMillis())
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "sync failed", e)
            if (auto && e is IOException) SyncState.Idle else SyncState.Failed(e.message ?: e.javaClass.simpleName, System.currentTimeMillis())
        }
        _state.value = result
        result
    }

    /** Reads the PC's collection without copying anything (for choosing albums). */
    suspend fun browse(): PcCollection = withContext(Dispatchers.IO) {
        val client = connect()
        readCollection(client).also { _pcLibrary.value = it }
    }

    private suspend fun connect(): PcClient {
        val pc = graph.pc.pc.value ?: throw PcError("Pair with your PC first")
        if (!graph.pc.hasNetworkPermission()) throw PcError("Allow Mune to find devices on your Wi-Fi (Nearby devices) to sync")
        val client = graph.pc.client(pc)
        val hello = try {
            client.hello()
        } catch (e: IOException) {
            // The PC's address may have changed (DHCP): look for it again by its id.
            val found = Discovery.find(context, 2600, stopAtId = pc.id).firstOrNull { it.id == pc.id }
                ?: throw PcError("Can't reach ${pc.name}. Make sure Mune Player is open on the PC, wireless sync is on, and you're on the same Wi-Fi.")
            graph.pc.update { it.copy(host = found.host, port = found.port, name = found.name.ifEmpty { it.name }) }
            return graph.pc.client()
        }
        if (hello.id != pc.id) throw PcError("A different PC answered at ${pc.host}. Pair again from the sync page.")
        // The PC may have been renamed in its settings since pairing.
        if (hello.name.isNotEmpty() && hello.name != pc.name) graph.pc.update { it.copy(name = hello.name) }
        return client
    }

    private suspend fun doRun(auto: Boolean): SyncState = withContext(Dispatchers.IO) {
        _state.value = SyncState.Running("connecting")
        val client = connect()

        // 1. Plays and hearts first, so the PC has them before we read its collection.
        val pending = graph.store.data.pending
        if (!pending.isEmpty) {
            client.report(pendingJson(pending).put("phoneName", graph.pc.phoneName))
            graph.store.reported(pending)
        }

        // 2. The collection.
        _state.value = SyncState.Running("reading")
        val pcLib = readCollection(client)
        _pcLibrary.value = pcLib
        val tracks = pcLib.tracks

        // 3. Hearts from the PC win for synced songs, unless the phone changed them since.
        graph.store.update { d ->
            val r = d.ratings.toMutableMap()
            for (t in tracks.values) {
                if (d.pending.ratings.containsKey(t.id)) continue
                val key = "pc:${t.id}"
                if (t.rating == null) r.remove(key) else r[key] = t.rating
            }
            d.copy(ratings = r)
        }

        // 4. What should be on the phone.
        val settings = graph.store.data.settings
        val wanted: Set<String> = if (settings.syncAll) {
            tracks.keys
        } else {
            (settings.syncAlbums.flatMap { pcLib.albums[it]?.trackIds.orEmpty() } +
                settings.syncPlaylists.flatMap { id -> pcLib.playlists.firstOrNull { it.id == id }?.trackIds.orEmpty() })
                .filter { it in tracks }.toSet()
        }

        val onPhone = scanSyncFolder()
        // Leftovers of an interrupted download.
        onPhone.values.filter { it.pending }.forEach { runCatching { resolver.delete(it.uri, null, null) } }

        val toAdd = wanted.mapNotNull { tracks[it] }.filter { t ->
            val m = manifest.track(t.id) ?: return@filter true
            val file = onPhone[m.pathKey] ?: return@filter true
            m.mtime != t.mtime || (t.size != null && file.size != t.size)
        }.sortedWith(compareBy({ it.albumArtist.lowercase() }, { it.album?.lowercase() }, { it.disc ?: 0 }, { it.track ?: 0 }))
        val toRemove = if (settings.removeDeleted) manifest.all().filter { it.pcId !in wanted } else emptyList()

        // 5. Copy.
        val totalBytes = toAdd.sumOf { it.size ?: 0L }
        var bytesDone = 0L
        var added = 0
        val failed = mutableListOf<String>()
        for ((i, t) in toAdd.withIndex()) {
            currentCoroutineContext().ensureActive()
            _state.value = SyncState.Running("copying", i, toAdd.size, t.title, bytesDone, totalBytes)
            try {
                val base = bytesDone
                bytesDone += download(client, t, onPhone) { sent ->
                    _state.value = SyncState.Running("copying", i, toAdd.size, t.title, base + sent, totalBytes)
                }
                added++
                if (added % 5 == 0) manifest.save()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "could not copy ${t.title}", e)
                failed += "${t.title}: ${e.message}"
            }
        }

        // 6. Album art for everything that's on the phone.
        _state.value = SyncState.Running("art", toAdd.size, toAdd.size, null, bytesDone, totalBytes)
        val albumIds = wanted.mapNotNull { tracks[it]?.albumId }.toSet()
        for (id in albumIds) {
            currentCoroutineContext().ensureActive()
            val album = pcLib.albums[id] ?: continue
            val file = graph.covers.pcArtFile(id)
            val before = manifest.albums[id]
            val stale = before == null || before.art != album.art || before.trackIds != album.trackIds
            if (album.art == false) {
                file.delete()
                continue
            }
            if (file.length() > 0 && !stale) continue
            runCatching { fetchTo(client, client.albumArtUrl(id, "l"), file) }
        }

        // 7. Remove what's no longer part of the sync.
        var removed = 0
        for (m in toRemove) {
            try {
                resolver.delete(Uri.parse(m.uri), null, null)
                removed++
            } catch (e: Exception) {
                Log.w(TAG, "could not remove ${m.fileName}", e)
            }
            manifest.remove(m.pcId)
        }

        manifest.setPcData(pcLib.albums, pcLib.playlists, tracks.mapValues { it.value.plays })
        manifest.save()
        graph.covers.clearMisses()

        // 8. Tell the PC how it went (it shows "synced" in its settings).
        runCatching {
            client.report(
                JSONObject().put("synced", JSONObject().put("songs", manifest.count).put("added", added)).put("phoneName", graph.pc.phoneName),
            )
        }
        graph.pc.update { it.copy(lastSync = System.currentTimeMillis()) }
        SyncState.Done(added, removed, manifest.count, failed, System.currentTimeMillis())
    }

    private suspend fun readCollection(client: PcClient): PcCollection {
        val lib = client.library()
        val tracks = HashMap<String, PcTrack>()
        lib.optJSONArray("tracks")?.let { arr ->
            for (i in 0 until arr.length()) {
                val j = arr.getJSONObject(i)
                val t = PcTrack(
                    id = j.getString("id"),
                    title = j.optString("title").ifEmpty { "Untitled" },
                    artist = j.optStringOrNull("artist"),
                    albumArtist = j.optString("albumArtist").ifEmpty { "Unknown Artist" },
                    album = j.optStringOrNull("album"),
                    albumId = j.optString("albumId"),
                    genre = j.optStringOrNull("genre"),
                    year = j.optIntOrNull("year")?.takeIf { it > 0 },
                    track = j.optIntOrNull("track")?.takeIf { it > 0 },
                    disc = j.optIntOrNull("disc")?.takeIf { it > 0 },
                    durationMs = (j.optDouble("duration", 0.0) * 1000).toLong(),
                    ext = j.optString("ext", ".mp3").lowercase(),
                    size = j.optLongOrNull("size"),
                    mtime = j.optLong("mtime"),
                    rating = j.optStringOrNull("rating"),
                    plays = j.optInt("plays"),
                )
                tracks[t.id] = t
            }
        }
        val albums = HashMap<String, PcAlbum>()
        lib.optJSONArray("albums")?.let { arr ->
            for (i in 0 until arr.length()) {
                val a = arr.getJSONObject(i)
                val ids = a.optJSONArray("trackIds")?.let { t -> (0 until t.length()).map { t.getString(it) } }.orEmpty()
                albums[a.getString("id")] = PcAlbum(
                    a.getString("id"), a.optString("title"), a.optString("artist"), a.optIntOrNull("year"), ids,
                    if (a.isNull("art")) null else a.optBoolean("art"),
                )
            }
        }
        val playlists = lib.optJSONArray("playlists")?.let { arr ->
            (0 until arr.length()).map { arr.getJSONObject(it) }.map { p ->
                PcPlaylist(p.getString("id"), p.optString("name"), p.optJSONArray("trackIds")?.let { t -> (0 until t.length()).map { t.getString(it) } }.orEmpty())
            }
        }.orEmpty()
        return PcCollection(tracks, albums, playlists)
    }

    private class OnPhone(val uri: Uri, val size: Long, val pending: Boolean)

    /** Everything under Music/Mune, keyed by lower-cased relative path + file name. */
    private fun scanSyncFolder(): Map<String, OnPhone> {
        val out = HashMap<String, OnPhone>()
        val collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val args = Bundle().apply {
            putString(ContentResolver.QUERY_ARG_SQL_SELECTION, "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?")
            putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf("$ROOT/%"))
            putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_INCLUDE)
        }
        val cols = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.IS_PENDING)
        resolver.query(collection, cols, args, null)?.use { c ->
            while (c.moveToNext()) {
                val rel = c.getString(1) ?: continue
                val name = c.getString(2) ?: continue
                out[(rel + name).lowercase()] = OnPhone(Uri.withAppendedPath(collection, c.getLong(0).toString()), c.getLong(3), c.getInt(4) == 1)
            }
        }
        return out
    }

    /** Copies one song into Music/Mune/<artist>/<album>/ and records it. Returns the bytes written. */
    private fun download(client: PcClient, t: PcTrack, onPhone: Map<String, OnPhone>, progress: (Long) -> Unit): Long {
        val rel = "$ROOT/${safeFileName(t.albumArtist, "Unknown Artist")}/${safeFileName(t.album ?: "Unknown Album", "Unknown Album")}/"
        val stem = safeFileName((t.track?.let { "%02d ".format(it) } ?: "") + t.title, "Track")
        val name = stem + t.ext
        val key = (rel + name).lowercase()

        // A changed file on the PC replaces the old copy.
        manifest.track(t.id)?.let { old ->
            if (old.pathKey != key || onPhone[key]?.let { it.size != t.size } == true) runCatching { resolver.delete(Uri.parse(old.uri), null, null) }
        }
        // Already on the phone (say, after reinstalling the app): adopt it instead of copying again.
        onPhone[key]?.let { existing ->
            if (!existing.pending && (t.size == null || existing.size == t.size) && manifest.track(t.id)?.mtime.let { it == null || it == t.mtime }) {
                manifest.put(record(t, existing.uri, rel, name, existing.size))
                return 0
            }
            runCatching { resolver.delete(existing.uri, null, null) }
        }

        val collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeFor(t.ext))
            put(MediaStore.MediaColumns.RELATIVE_PATH, rel)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: throw IOException("Couldn't create $name")
        try {
            var written = 0L
            client.open(client.fileUrl(t.id)).use { res ->
                res.body.byteStream().use { input ->
                    resolver.openOutputStream(uri, "w")?.use { out ->
                        val buf = ByteArray(256 * 1024)
                        var lastReport = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            written += n
                            val now = System.nanoTime()
                            if (now - lastReport > 120_000_000L) {
                                lastReport = now
                                progress(written)
                            }
                        }
                    } ?: throw IOException("Couldn't write $name")
                }
            }
            if (t.size != null && written != t.size) throw IOException("Copy was cut short ($written of ${t.size} bytes)")
            // MediaStore renames the file if the name was taken; record what it really used.
            var finalName = name
            var finalRel = rel
            resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.RELATIVE_PATH), Bundle().apply {
                putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_INCLUDE)
            }, null)?.use { c ->
                if (c.moveToFirst()) {
                    finalName = c.getString(0) ?: name
                    finalRel = c.getString(1) ?: rel
                }
            }
            resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            manifest.put(record(t, uri, finalRel, finalName, written))
            progress(written)
            return written
        } catch (e: Throwable) {
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
    }

    private fun record(t: PcTrack, uri: Uri, rel: String, name: String, size: Long) = SyncedTrack(
        pcId = t.id, uri = uri.toString(), relativePath = rel, fileName = name, size = size, mtime = t.mtime,
        pcAlbumId = t.albumId, title = t.title, artist = t.artist, albumArtist = t.albumArtist, album = t.album,
        genre = t.genre, year = t.year, track = t.track, disc = t.disc, durationMs = t.durationMs, added = System.currentTimeMillis(),
    )

    private fun fetchTo(client: PcClient, url: String, file: File) {
        val tmp = File(file.parentFile, file.name + ".part")
        client.open(url).use { res -> tmp.outputStream().use { out -> res.body.byteStream().copyTo(out) } }
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    private fun pendingJson(p: Pending) = JSONObject()
        .put("plays", JSONObject(p.plays))
        .put("lastPlayed", JSONObject(p.lastPlayed))
        .put("ratings", JSONObject(p.ratings.mapValues { (_, v) -> v.ifEmpty { JSONObject.NULL } }))

    /** Stops tracking synced songs and deletes them (after unpairing, if asked). */
    suspend fun removeAllSynced() = withContext(Dispatchers.IO) {
        lock.withLock {
            for (m in manifest.all()) runCatching { resolver.delete(Uri.parse(m.uri), null, null) }
            manifest.clear()
            manifest.save()
        }
    }

    companion object {
        private const val TAG = "SyncEngine"
        const val ROOT = "Music/Mune"

        fun mimeFor(ext: String): String {
            val e = ext.removePrefix(".").lowercase()
            return MimeTypeMap.getSingleton().getMimeTypeFromExtension(e) ?: when (e) {
                "mp3" -> "audio/mpeg"
                "flac" -> "audio/flac"
                "m4a", "m4b", "mp4" -> "audio/mp4"
                "aac" -> "audio/aac"
                "ogg", "oga", "opus" -> "audio/ogg"
                "wav" -> "audio/x-wav"
                "webm" -> "audio/webm"
                else -> "audio/mpeg"
            }
        }
    }
}
