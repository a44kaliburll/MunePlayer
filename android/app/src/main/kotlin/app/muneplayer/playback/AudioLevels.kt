package app.muneplayer.playback

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Loudness of the music that is playing right now, for the glow that pulses with it
 * (the desktop app does the same with Web Audio). Filled by [LevelTap] on the playback
 * thread a little ahead of the speaker, read by the UI every frame.
 */
class AudioLevels {
    private val size = 2048
    private val times = LongArray(size)
    private val levels = FloatArray(size)
    private val basses = FloatArray(size)
    private var head = 0
    private var count = 0

    val processor: AudioProcessor = LevelTap(this)

    @Synchronized
    internal fun push(t: Long, level: Float, bass: Float) {
        times[head] = t
        levels[head] = level
        basses[head] = bass
        head = (head + 1) % size
        if (count < size) count++
    }

    @Synchronized
    internal fun clear() {
        count = 0
    }

    /** Writes [loudness, bass] (raw RMS, roughly 0..0.5) for the audio heard at [now] into [out]. */
    @Synchronized
    fun read(out: FloatArray, now: Long = System.nanoTime()) {
        out[0] = 0f
        out[1] = 0f
        var i = (head - 1 + size) % size
        for (n in 0 until count) {
            if (times[i] <= now) {
                // Nothing fresh means we're paused or stopped: silence, not a frozen level.
                if (now - times[i] < STALE_NANOS) {
                    out[0] = levels[i]
                    out[1] = basses[i]
                }
                return
            }
            i = (i - 1 + size) % size
        }
    }

    companion object {
        /** How far the decoder runs ahead of the speaker (the AudioTrack buffer). */
        const val LATENCY_NANOS = 220_000_000L
        private const val STALE_NANOS = 150_000_000L
    }
}

/** A pass-through audio processor that measures loudness and bass in 512-frame blocks. */
private class LevelTap(private val sink: AudioLevels) : BaseAudioProcessor() {
    private var encoding = C.ENCODING_INVALID
    private var channels = 2
    private var sampleRate = 44100
    private var low = 0f
    private var nextAt = 0L

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT && inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT) {
            return AudioProcessor.AudioFormat.NOT_SET
        }
        encoding = inputAudioFormat.encoding
        channels = max(1, inputAudioFormat.channelCount)
        sampleRate = max(8000, inputAudioFormat.sampleRate)
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val size = inputBuffer.remaining()
        if (size == 0) return
        analyze(inputBuffer)
        val out = replaceOutputBuffer(size)
        out.put(inputBuffer)
        out.flip()
    }

    private fun analyze(buf: ByteBuffer) {
        val bytes = if (encoding == C.ENCODING_PCM_FLOAT) 4 else 2
        val frames = buf.remaining() / (bytes * channels)
        if (frames == 0) return
        // One-pole low-pass at ~150 Hz for the bass band.
        val alpha = 1f - exp(-2f * PI.toFloat() * 150f / sampleRate)
        var t = max(System.nanoTime() + AudioLevels.LATENCY_NANOS, nextAt)
        var pos = buf.position()
        var f = 0
        while (f < frames) {
            val n = min(BLOCK, frames - f)
            var sum = 0f
            var bassSum = 0f
            for (i in 0 until n) {
                var mono = 0f
                for (ch in 0 until channels) {
                    mono += if (bytes == 2) buf.getShort(pos) / 32768f else buf.getFloat(pos)
                    pos += bytes
                }
                mono /= channels
                low += alpha * (mono - low)
                sum += mono * mono
                bassSum += low * low
            }
            sink.push(t, sqrt(sum / n), sqrt(bassSum / n))
            t += n * 1_000_000_000L / sampleRate
            f += n
        }
        nextAt = t
    }

    override fun onFlush() {
        low = 0f
        nextAt = 0L
        sink.clear()
    }

    override fun onReset() {
        onFlush()
        encoding = C.ENCODING_INVALID
    }

    companion object {
        private const val BLOCK = 512
    }
}
