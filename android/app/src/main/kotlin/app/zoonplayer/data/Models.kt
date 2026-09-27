package app.zoonplayer.data

import android.net.Uri

const val UNKNOWN_ARTIST = "Unknown Artist"
const val UNKNOWN_ALBUM = "Unknown Album"
const val VARIOUS_ARTISTS = "Various Artists"

/** One song file on the phone, with metadata from the PC when it was synced from Zoon Player on the PC. */
data class Song(
    val id: Long,
    val uri: Uri,
    /** Stable key for hearts, plays and playlists: "pc:<id>" for synced songs, else "f:<path>". */
    val key: String,
    val pcId: String?,
    val title: String,
    val artist: String,
    val albumArtist: String,
    val album: String,
    val albumKey: String,
    val artistKey: String,
    val genre: String,
    val genreKey: String,
    val year: Int?,
    val track: Int?,
    val disc: Int?,
    val durationMs: Long,
    val added: Long,
    val size: Long,
    val relativePath: String,
    val fileName: String,
    val pcAlbumId: String?,
)

data class Album(
    val key: String,
    val title: String,
    val artist: String,
    val artistKey: String,
    val year: Int?,
    val genre: String,
    val songs: List<Song>,
    val added: Long,
    val unknown: Boolean,
) {
    val cover: Song get() = songs.first()
    val pcAlbumId: String? get() = songs.firstNotNullOfOrNull { it.pcAlbumId }
    val durationMs: Long get() = songs.sumOf { it.durationMs }
}

data class Artist(
    val key: String,
    val name: String,
    val albums: List<Album>,
    val songCount: Int,
    val added: Long,
) {
    val songs: List<Song> get() = albums.flatMap { it.songs }
}

data class Genre(val key: String, val name: String, val albums: List<Album>, val songCount: Int) {
    val songs: List<Song> get() = albums.flatMap { a -> a.songs.filter { it.genreKey == key } }
}

data class Playlist(
    val id: String,
    val name: String,
    val songKeys: List<String>,
    /** Set for playlists that came from the PC (read-only on the phone). */
    val pcId: String? = null,
    val modified: Long = 0,
)

/** What a pin or a history entry points at. */
data class Ref(val type: String, val id: String, val t: Long = System.currentTimeMillis()) {
    companion object {
        const val ALBUM = "album"
        const val ARTIST = "artist"
        const val PLAYLIST = "playlist"
        const val GENRE = "genre"
        const val DJ = "dj"
    }
}

class Library(
    val songs: List<Song>,
    val albums: List<Album>,
    val artists: List<Artist>,
    val genres: List<Genre>,
    val loaded: Boolean,
    val version: Int,
) {
    val songByKey: Map<String, Song> = songs.associateBy { it.key }
    val albumByKey: Map<String, Album> = albums.associateBy { it.key }
    val artistByKey: Map<String, Artist> = artists.associateBy { it.key }
    val genreByKey: Map<String, Genre> = genres.associateBy { it.key }
    val albumByPcId: Map<String, Album> = albums.mapNotNull { a -> a.pcAlbumId?.let { it to a } }.toMap()

    val isEmpty get() = songs.isEmpty()

    companion object {
        val EMPTY = Library(emptyList(), emptyList(), emptyList(), emptyList(), loaded = false, version = 0)
    }
}
