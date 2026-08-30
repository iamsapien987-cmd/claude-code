package com.candleapp.flame

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlin.math.exp
import kotlin.math.sqrt

/**
 * Microphone capture done natively, because the WebView would not do it.
 *
 * Three fixes were aimed at getUserMedia failing with NotReadableError and
 * all three missed, because each cause was inferred from that one error name.
 * The diagnostics readout eventually ruled out every one of them: the OS
 * permission was granted, the page was in a secure context, one audio input
 * was enumerated, no activity pause was involved, and even a bare
 * `{ audio: true }` failed. Nothing was left to constrain or to time.
 *
 * So this stops asking the WebView. AudioRecord is the primitive that
 * Chromium's own capture is built on, and going straight to it removes every
 * layer that could have been the one failing - the WebView permission gate,
 * device enumeration, constraint negotiation, and the audio-service IPC
 * between the renderer and the browser process.
 *
 * It also buys two things that could not be had through getUserMedia. The
 * audio source can be chosen outright, so UNPROCESSED gets a signal with no
 * noise suppression on it - and noise suppression removes precisely the sound
 * of a blown breath. And when a source does fail it fails with a state, a
 * return code or an exception, so the next report will name a cause instead
 * of offering one word to guess from.
 *
 * Only the measurement lives here. Deciding what counts as a puff is left to
 * the web layer, where it can be tested without a phone.
 */
class MicCapture {

    private companion object {
        const val RATE = 16000

        /** 32 ms of audio: fast enough that a puff is not smeared. */
        const val BLOCK = 512

        /** One-pole filter coefficient for a corner frequency, at RATE. */
        fun pole(hz: Double) = 1.0 - exp(-2.0 * Math.PI * hz / RATE)

        /**
         * Preference order. UNPROCESSED is the one actually wanted; the rest
         * are there because plenty of devices do not implement it, and a
         * processed stream still carries a puff, attenuated rather than gone.
         */
        val SOURCES = listOf(
            "unprocessed" to MediaRecorder.AudioSource.UNPROCESSED,
            "voice recognition" to MediaRecorder.AudioSource.VOICE_RECOGNITION,
            "mic" to MediaRecorder.AudioSource.MIC,
            "default" to MediaRecorder.AudioSource.DEFAULT,
        )
    }

    @Volatile private var lowRms = 0.0
    @Volatile private var highRms = 0.0
    @Volatile private var seq = 0L
    @Volatile private var running = false

    /** Which audio source is open, for the diagnostics readout. */
    @Volatile var source = "none"
        private set

    /** Why it is not open, in the words of whatever refused. */
    @Volatile var error: String? = null
        private set

    /** What each source in the ladder said, whether or not one succeeded. */
    @Volatile var attempts = ""
        private set

    private var record: AudioRecord? = null
    private var worker: Thread? = null

    val active: Boolean get() = running

    /**
     * Walk the source ladder and keep the first one that genuinely yields
     * samples. Blocks briefly, but only ever on a button press.
     */
    fun start(): Boolean {
        if (running) return true

        val minBuf = AudioRecord.getMinBufferSize(
            RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) {
            error = "no buffer size (code $minBuf)"
            attempts = error!!
            return false
        }
        val bufBytes = maxOf(minBuf, BLOCK * 2 * 4)
        val notes = StringBuilder()

        for ((label, src) in SOURCES) {
            var rec: AudioRecord? = null
            try {
                rec = AudioRecord(
                    src, RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufBytes
                )
                if (rec.state != AudioRecord.STATE_INITIALIZED) {
                    notes.append("$label: not initialised. ")
                    rec.release()
                    continue
                }
                rec.startRecording()
                if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                    notes.append("$label: would not start. ")
                    rec.stop()
                    rec.release()
                    continue
                }
                // A source can initialise and start and still refuse to hand
                // over samples, so take one block before believing it.
                val probe = ShortArray(BLOCK)
                val n = rec.read(probe, 0, BLOCK)
                if (n <= 0) {
                    notes.append("$label: read returned $n. ")
                    rec.stop()
                    rec.release()
                    continue
                }

                record = rec
                source = label
                error = null
                attempts = notes.toString()
                running = true
                worker = Thread({ loop() }, "candle-mic").apply {
                    isDaemon = true
                    start()
                }
                return true
            } catch (e: Throwable) {
                notes.append("$label: ${e.javaClass.simpleName}. ")
                try { rec?.release() } catch (ignored: Throwable) { }
            }
        }

        attempts = notes.toString()
        error = attempts.ifEmpty { "no audio source would open" }
        source = "none"
        return false
    }

    /**
     * Split each block into the two bands the web layer compares.
     *
     * Blowing is a broadband rush of air noise concentrated well below
     * 500 Hz; speech and music carry far more of their energy higher up. One
     * pole either side is enough to tell those apart and costs nothing, which
     * matters on a thread that runs thirty times a second for as long as the
     * microphone is on.
     */
    private fun loop() {
        val rec = record ?: return
        val buf = ShortArray(BLOCK)
        val aDc = pole(20.0)
        val aLow = pole(450.0)
        val aHigh = pole(1200.0)
        var dc = 0.0
        var lp = 0.0
        var lpHigh = 0.0

        while (running) {
            val n = try {
                rec.read(buf, 0, BLOCK)
            } catch (e: Throwable) {
                error = e.javaClass.simpleName
                running = false
                return
            }
            if (n <= 0) {
                if (n < 0) {
                    error = "read returned $n"
                    running = false
                    return
                }
                continue
            }

            var sumLow = 0.0
            var sumHigh = 0.0
            for (i in 0 until n) {
                val x = buf[i] / 32768.0
                // Strip the converter's DC offset without touching the
                // 50-450 Hz content that is the whole signature of a breath.
                dc += aDc * (x - dc)
                val v = x - dc
                lp += aLow * (v - lp)
                lpHigh += aHigh * (v - lpHigh)
                val hi = v - lpHigh
                sumLow += lp * lp
                sumHigh += hi * hi
            }
            lowRms = sqrt(sumLow / n)
            highRms = sqrt(sumHigh / n)
            seq++
        }
    }

    /** Low band, high band and a counter, for the page to poll each frame. */
    fun levels() = "$lowRms,$highRms,$seq"

    fun stop() {
        running = false
        // read() blocks for at most one block, so this returns promptly.
        try { worker?.join(500) } catch (ignored: InterruptedException) { }
        worker = null
        try { record?.stop() } catch (ignored: Throwable) { }
        try { record?.release() } catch (ignored: Throwable) { }
        record = null
        lowRms = 0.0
        highRms = 0.0
        source = "none"
    }
}
