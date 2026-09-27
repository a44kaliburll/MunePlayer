package com.a44kaliburll.zoon.data

import com.a44kaliburll.zoon.util.norm
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * Smart DJ, as in the desktop app: a mix seeded by one artist. Zune used its online
 * "related artists"; this uses Deezer's, then artists that share a genre in your collection,
 * weighted by hearts and plays and never playing a disliked song.
 */
object SmartDj {
    suspend fun build(online: Online, lib: Library, user: UserData, artistKey: String, size: Int = 80): List<Song> {
        val seed = lib.artistByKey[artistKey] ?: return emptyList()
        val related = runCatching { online.related(seed.name) }.getOrDefault(emptyList())
        val byName = lib.artists.associateBy { norm(it.name) }
        val relatedArtists = related.mapNotNull { byName[norm(it)] }.filter { it.key != artistKey }.distinctBy { it.key }
        val seedSongs = seed.songs
        val seedGenres = seedSongs.map { it.genreKey }.toSet()
        val relatedKeys = relatedArtists.map { it.key }.toSet()
        val genreArtists = lib.artists.filter { a ->
            a.key != artistKey && a.key !in relatedKeys && a.songs.any { it.genreKey in seedGenres && it.genre != "Unknown" }
        }

        val pool = ArrayList<Pair<Song, Double>>()
        fun add(songs: List<Song>, weight: Double) {
            for (s in songs) {
                val r = user.ratings[s.key]
                if (r == HATE) continue
                val w = weight * (if (r == LOVE) 1.7 else 1.0) * (1 + min(user.plays[s.key] ?: 0, 20) / 40.0)
                pool += s to Random.nextDouble().pow(1 / w)
            }
        }
        add(seedSongs, 3.0)
        relatedArtists.forEach { add(it.songs, 2.0) }
        genreArtists.forEach { a -> add(a.songs.filter { it.genreKey in seedGenres }, 1.0) }
        return spread(pool.sortedByDescending { it.second }.take(size).map { it.first })
    }

    /** Avoid the same artist twice in a row where possible. */
    private fun spread(songs: List<Song>): List<Song> {
        val out = ArrayList<Song>(songs.size)
        val pending = songs.toMutableList()
        while (pending.isNotEmpty()) {
            val last = out.lastOrNull()
            var idx = pending.indexOfFirst { last == null || it.artistKey != last.artistKey }
            if (idx < 0) idx = 0
            out += pending.removeAt(idx)
        }
        return out
    }
}
