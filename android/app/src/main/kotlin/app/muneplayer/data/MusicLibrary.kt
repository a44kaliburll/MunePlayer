package app.muneplayer.data

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.database.Cursor
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.ContextCompat
import app.muneplayer.sync.SyncManifest
import app.muneplayer.util.byName
import app.muneplayer.util.hash12
import app.muneplayer.util.norm
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

private val ARTIST_SPLIT = Regex("\\s*(?:/|;|\\bfeat\\.?\\b|\\bft\\.?\\b|\\bfeaturing\\b)\\s*", RegexOption.IGNORE_CASE)

/** "Daft Punk/Romanthony" -> "Daft Punk" (only used to group untagged albums). */
private fun primaryArtist(artist: String?): String? = artist?.split(ARTIST_SPLIT)?.firstOrNull()?.trim()?.ifEmpty { null }

/**
 * The phone's music collection: every song MediaStore knows about, grouped into albums,
 * album artists and genres the way Zune did. Songs that came from the PC use the PC's tags,
 * so the phone groups them exactly like Mune Player on the PC.
 */
class MusicLibrary(
    private val context: Context,
    private val manifest: SyncManifest,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(Library.EMPTY)
    val state: StateFlow<Library> = _state
    private val _permission = MutableStateFlow(hasPermission())
    val permission: StateFlow<Boolean> = _permission

    private var job: Job? = null
    private var version = 0
    private var started = false

    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = refresh(1500)
    }

    fun start() {
        if (started) return
        started = true
        runCatching {
            context.contentResolver.registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, observer)
        }
        scope.launch { manifest.version.collect { refresh(250) } }
    }

    /** Call after the user answers the music permission prompt. */
    fun permissionChanged() {
        _permission.value = hasPermission()
        refresh()
    }

    fun hasPermission(): Boolean {
        val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
        return ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
    }

    fun refresh(delayMs: Long = 0) {
        job?.cancel()
        job = scope.launch(Dispatchers.IO) {
            if (delayMs > 0) delay(delayMs)
            val granted = hasPermission()
            _permission.value = granted
            val raws = if (granted) runCatching { query() }.onFailure { Log.w(TAG, "MediaStore query failed", it) }.getOrDefault(emptyList()) else emptyList()
            _state.value = build(raws, ++version)
        }
    }

    private class Raw(
        val id: Long,
        val title: String,
        val artist: String?,
        val aaTag: String?,
        val album: String?,
        val genre: String?,
        val year: Int?,
        val track: Int?,
        val disc: Int?,
        val durationMs: Long,
        val added: Long,
        val size: Long,
        val relativePath: String,
        val fileName: String,
        val compilation: Boolean,
        val pcId: String?,
        val pcAlbumId: String?,
    )

    private fun query(): List<Raw> {
        val cols = mutableListOf(
            MediaStore.Audio.Media._ID, MediaStore.Audio.Media.TITLE, MediaStore.Audio.Media.ARTIST, MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.TRACK, MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.YEAR,
            MediaStore.Audio.Media.DATE_ADDED, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.RELATIVE_PATH,
            MediaStore.Audio.Media.DISPLAY_NAME,
        )
        if (Build.VERSION.SDK_INT >= 30) {
            cols += listOf(MediaStore.Audio.Media.ALBUM_ARTIST, MediaStore.Audio.Media.GENRE, MediaStore.Audio.Media.COMPILATION)
        }
        val out = ArrayList<Raw>()
        val uri = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        context.contentResolver.query(uri, cols.toTypedArray(), "${MediaStore.Audio.Media.IS_MUSIC} != 0", null, null)?.use { c ->
            val iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val iTitle = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
            val iArtist = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
            val iAlbum = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)
            val iTrack = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TRACK)
            val iDur = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
            val iYear = c.getColumnIndexOrThrow(MediaStore.Audio.Media.YEAR)
            val iAdded = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED)
            val iSize = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
            val iRel = c.getColumnIndexOrThrow(MediaStore.Audio.Media.RELATIVE_PATH)
            val iName = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val iAa = c.getColumnIndex("album_artist")
            val iGenre = c.getColumnIndex("genre")
            val iComp = c.getColumnIndex("compilation")
            while (c.moveToNext()) {
                val rel = c.str(iRel) ?: ""
                val name = c.str(iName) ?: continue
                val synced = manifest.byFile(rel, name)
                val rawTrack = c.getInt(iTrack)
                if (synced != null) {
                    out += Raw(
                        id = c.getLong(iId), title = synced.title, artist = synced.artist ?: synced.albumArtist, aaTag = synced.albumArtist,
                        album = synced.album, genre = synced.genre, year = synced.year, track = synced.track, disc = synced.disc,
                        durationMs = if (synced.durationMs > 0) synced.durationMs else c.getLong(iDur), added = c.getLong(iAdded) * 1000,
                        size = c.getLong(iSize), relativePath = rel, fileName = name, compilation = false,
                        pcId = synced.pcId, pcAlbumId = synced.pcAlbumId,
                    )
                } else {
                    out += Raw(
                        id = c.getLong(iId),
                        title = c.str(iTitle) ?: name.substringBeforeLast('.'),
                        artist = c.str(iArtist),
                        aaTag = if (iAa >= 0) c.str(iAa) else null,
                        album = c.str(iAlbum),
                        genre = if (iGenre >= 0) c.str(iGenre) else null,
                        year = c.getInt(iYear).takeIf { it > 0 },
                        track = (rawTrack % 1000).takeIf { it > 0 },
                        disc = (rawTrack / 1000).takeIf { it > 0 },
                        durationMs = c.getLong(iDur),
                        added = c.getLong(iAdded) * 1000,
                        size = c.getLong(iSize),
                        relativePath = rel,
                        fileName = name,
                        compilation = iComp >= 0 && c.str(iComp) == "1",
                        pcId = null,
                        pcAlbumId = null,
                    )
                }
            }
        }
        return out
    }

    /** Derive albums, album artists and genres from the flat song list (as the desktop app does). */
    private fun build(raws: List<Raw>, version: Int): Library {
        // Albums without an album-artist tag: several different artists in one folder's copy of
        // the album make it a compilation ("Various Artists"), like Zune showed it.
        val resolved = HashMap<Long, String>()
        raws.filter { it.album != null && it.pcId == null }
            .groupBy { norm(it.relativePath) + "\u0000" + norm(it.album) }
            .values.forEach { g ->
                val tagged = g.firstOrNull { it.aaTag != null }
                if (tagged != null) {
                    g.forEach { resolved[it.id] = it.aaTag ?: tagged.aaTag!! }
                } else {
                    val names = g.mapNotNull { primaryArtist(it.artist) }.associateBy { norm(it) }
                    val aa = if (g.any { it.compilation } || names.size > 1) VARIOUS_ARTISTS else names.values.firstOrNull()
                    if (aa != null) g.forEach { resolved[it.id] = aa }
                }
            }

        val base = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        val songs = raws.map { r ->
            val aa = (if (r.pcId != null) r.aaTag else r.aaTag ?: resolved[r.id]) ?: primaryArtist(r.artist) ?: UNKNOWN_ARTIST
            val albumName = r.album ?: UNKNOWN_ALBUM
            val genreName = r.genre?.takeIf { it.isNotBlank() } ?: "Unknown"
            Song(
                id = r.id,
                uri = ContentUris.withAppendedId(base, r.id),
                key = r.pcId?.let { "pc:$it" } ?: "f:${(r.relativePath + r.fileName).lowercase()}",
                pcId = r.pcId,
                title = r.title,
                artist = r.artist ?: aa,
                albumArtist = aa,
                album = albumName,
                albumKey = hash12("album:${norm(aa)}\u0000${norm(albumName)}"),
                artistKey = hash12("artist:${norm(aa)}"),
                genre = genreName,
                genreKey = hash12("genre:${norm(genreName)}"),
                year = r.year,
                track = r.track,
                disc = r.disc,
                durationMs = r.durationMs,
                added = r.added,
                size = r.size,
                relativePath = r.relativePath,
                fileName = r.fileName,
                pcAlbumId = r.pcAlbumId,
            )
        }

        val trackOrder = compareBy<Song>({ it.disc ?: 999 }, { it.track ?: 9999 }).thenComparing(byName { it.title })
        val albums = songs.groupBy { it.albumKey }.map { (key, list) ->
            val sorted = list.sortedWith(trackOrder)
            val first = sorted.first()
            Album(
                key = key,
                title = first.album,
                artist = first.albumArtist,
                artistKey = first.artistKey,
                year = list.mapNotNull { it.year }.minOrNull(),
                genre = list.groupingBy { it.genre }.eachCount().maxByOrNull { it.value }?.key ?: "Unknown",
                songs = sorted,
                added = list.minOf { it.added },
                unknown = first.album == UNKNOWN_ALBUM,
            )
        }.sortedWith(byName { it.title })

        val albumOrder = compareBy<Album>({ it.year ?: 9999 }).thenComparing(byName { it.title })
        val artists = albums.groupBy { it.artistKey }.map { (key, list) ->
            Artist(key, list.first().artist, list.sortedWith(albumOrder), list.sumOf { it.songs.size }, list.minOf { it.added })
        }.sortedWith(byName { it.name })

        val genres = songs.groupBy { it.genreKey }.map { (key, list) ->
            val albumKeys = list.map { it.albumKey }.toSet()
            Genre(key, list.first().genre, albums.filter { it.key in albumKeys }.sortedWith(byName { it.artist }), list.size)
        }.sortedWith(byName { it.name })

        return Library(songs.sortedWith(byName { it.title }), albums, artists, genres, loaded = true, version = version)
    }

    private fun Cursor.str(i: Int): String? = if (i < 0 || isNull(i)) null else getString(i)?.trim()?.takeIf { it.isNotEmpty() && it != "<unknown>" }

    companion object {
        private const val TAG = "MusicLibrary"
    }
}
