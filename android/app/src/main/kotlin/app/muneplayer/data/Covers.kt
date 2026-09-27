package app.muneplayer.data

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.util.Size
import coil3.ImageLoader
import coil3.asImage
import coil3.decode.DataSource
import coil3.decode.ImageSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.ImageFetchResult
import coil3.fetch.SourceFetchResult
import coil3.key.Keyer
import coil3.request.Options
import coil3.size.pxOrElse
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okio.FileSystem
import okio.Path.Companion.toOkioPath

/** Album art to show; resolved by [CoverFetcher] in Zune's order of preference. */
data class Cover(
    val albumKey: String,
    val songUri: Uri?,
    val pcAlbumId: String?,
    val artist: String,
    val album: String,
)

fun Album.toCover() = Cover(key, cover.uri, pcAlbumId, artist, title)
fun Song.toCover() = Cover(albumKey, uri, pcAlbumId, albumArtist, album)

/**
 * Album art: the PC's art for synced albums (it includes folder images and covers the PC
 * found online), then the picture embedded in the file, then an online lookup.
 */
class Covers(private val context: Context, private val online: Online) {
    val artDir = File(context.filesDir, "art").apply { mkdirs() }
    private val pcDir = File(artDir, "pc").apply { mkdirs() }
    private val onlineDir = File(artDir, "online").apply { mkdirs() }
    private val misses = ConcurrentHashMap<String, Long>()

    fun pcArtFile(pcAlbumId: String) = File(pcDir, "$pcAlbumId.jpg")

    /** Forget "no art" results, e.g. after a sync brought new covers. */
    fun clearMisses() = misses.clear()

    suspend fun resolveFile(c: Cover, allowOnline: Boolean = true): File? {
        c.pcAlbumId?.let { id -> pcArtFile(id).takeIf { it.length() > 0 }?.let { return it } }
        val cached = File(onlineDir, "${c.albumKey}.jpg")
        if (cached.length() > 0) return cached
        if (!allowOnline || c.album == UNKNOWN_ALBUM || c.artist == UNKNOWN_ARTIST) return null
        val url = online.albumCoverUrl(c.artist, c.album) ?: return null
        return try {
            val bytes = online.download(url)
            withContext(Dispatchers.IO) {
                val tmp = File(onlineDir, "${c.albumKey}.part")
                tmp.writeBytes(bytes)
                tmp.renameTo(cached)
            }
            cached
        } catch (e: Exception) {
            null
        }
    }

    suspend fun thumbnail(c: Cover, px: Int): Bitmap? {
        val uri = c.songUri ?: return null
        return withContext(Dispatchers.IO) {
            try {
                context.contentResolver.loadThumbnail(uri, Size(px, px), null)
            } catch (e: Exception) {
                null
            }
        }
    }

    internal suspend fun fetch(c: Cover, px: Int): FetchResult {
        val missAt = misses[c.albumKey]
        if (missAt != null && System.currentTimeMillis() - missAt < MISS_MS) throw IOException("no art")
        c.pcAlbumId?.let { id ->
            val f = pcArtFile(id)
            if (f.length() > 0) return f.asResult()
        }
        thumbnail(c, px)?.let { return ImageFetchResult(it.asImage(), isSampled = true, dataSource = DataSource.DISK) }
        resolveFile(c)?.let { return it.asResult() }
        misses[c.albumKey] = System.currentTimeMillis()
        throw IOException("no art")
    }

    private fun File.asResult() = SourceFetchResult(
        source = ImageSource(file = toOkioPath(), fileSystem = FileSystem.SYSTEM),
        mimeType = null,
        dataSource = DataSource.DISK,
    )

    companion object {
        private const val MISS_MS = 10 * 60 * 1000L
    }
}

class CoverFetcher(private val data: Cover, private val options: Options, private val covers: Covers) : Fetcher {
    override suspend fun fetch(): FetchResult {
        val px = options.size.width.pxOrElse { 600 }.coerceIn(96, 1400)
        return covers.fetch(data, px)
    }

    class Factory(private val covers: Covers) : Fetcher.Factory<Cover> {
        override fun create(data: Cover, options: Options, imageLoader: ImageLoader): Fetcher = CoverFetcher(data, options, covers)
    }
}

class CoverKeyer : Keyer<Cover> {
    override fun key(data: Cover, options: Options): String = "cover:${data.albumKey}:${data.pcAlbumId.orEmpty()}"
}
