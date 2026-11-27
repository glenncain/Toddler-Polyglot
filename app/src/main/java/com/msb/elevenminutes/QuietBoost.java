package com.msb.elevenminutes;

/**
 * Digital gain for a quiet voice, applied to the microphone before the recogniser hears it.
 *
 * Android's speech recogniser records from the VOICE_RECOGNITION source, which is meant to
 * have a flat response and no automatic gain. That is right for an adult a forearm's length
 * from the tablet. A three-year-old across the table, half-whispering, arrives tens of dB
 * below that and the recogniser decides nobody spoke.
 *
 * This lifts speech towards a target level, and leaves the room alone. It cannot pull a
 * voice out from under a TV: gain lifts the noise with it. It helps a voice that is clean
 * but small.
 *   - an envelope follower (fast up, slow down) tracks how loud the input is right now;
 *   - a short average (25ms) is compared with a noise floor that follows the quietest the
 *     room gets, so the hum of a fridge is never treated as a voice to be boosted (a
 *     boosted room keeps a recogniser from ever deciding she has finished speaking);
 *   - only input clearly above that floor gets gain, capped at maxGainDb;
 *   - a soft limiter keeps anything that was already loud from clipping.
 *
 * Plain Java with no Android imports, so test/QuietBoostCheck.java can run it on a desktop
 * JVM against synthetic quiet speech and measure what comes out.
 */
public final class QuietBoost {

    private final float maxGain;
    private final float target;
    private final float attack, release, floorRise, floorLearn, gainStep, average;
    private final int learnFor;      // samples spent learning the room before any gain
    private int seen = 0;
    private static final float GATE = 1.8f;        // input must be about 5 dB over the room
    private static final float KNEE = 0.80f;       // where the limiter starts to bend

    private float env = 0f;          // peak-following: how loud, for the gain
    private float lvl = 0f;          // a short average: is this a voice or the room, for the gate
    private float floor = -1f;
    private float gain = 1f;

    public QuietBoost(int sampleRate, float maxGainDb, float targetDbfs) {
        this.maxGain = (float) Math.pow(10, maxGainDb / 20.0);
        this.target = (float) Math.pow(10, targetDbfs / 20.0);
        this.attack = coef(0.004, sampleRate);
        this.release = coef(0.200, sampleRate);
        this.floorRise = coef(3.0, sampleRate);
        this.floorLearn = coef(0.05, sampleRate);
        this.learnFor = sampleRate / 4;
        this.gainStep = coef(0.030, sampleRate);
        this.average = coef(0.025, sampleRate);
    }

    /** The defaults the bridge uses: up to +18 dB, speech brought towards -14 dBFS peaks. */
    public static QuietBoost forSpeech(int sampleRate) {
        return new QuietBoost(sampleRate, 18f, -14f);
    }

    private static float coef(double seconds, int rate) {
        return (float) (1.0 - Math.exp(-1.0 / (seconds * rate)));
    }

    /** Current gain, in dB. For the panel and the check. */
    public float gainDb() { return (float) (20.0 * Math.log10(gain)); }

    /** Processes n samples of 16-bit mono PCM in place. */
    public void process(short[] buf, int n) {
        for (int i = 0; i < n; i++) {
            float x = buf[i] / 32768f;
            float a = Math.abs(x);
            env += (a - env) * (a > env ? attack : release);
            lvl += (a - lvl) * average;

            /* The room, at its quietest. For the first quarter second it is learned quickly
               and nothing is boosted; after that it can only creep up, so a voice cannot
               drag it along. The bridge keeps one of these for the whole launch, so the
               room is learned once, not at the start of every listen. */
            boolean learning = seen < learnFor;
            if (learning) seen++;
            if (floor < 0f) floor = lvl;
            else if (lvl < floor) floor = lvl;
            else floor += (lvl - floor) * (learning ? floorLearn : floorRise);

            float want = 1f;
            if (!learning && lvl > floor * GATE && env > 1e-4f) {
                want = target / env;
                if (want > maxGain) want = maxGain;
                if (want < 1f) want = 1f;                          // never turns anything down
            }
            gain += (want - gain) * gainStep;

            float y = x * gain;
            float m = Math.abs(y);
            if (m > KNEE) {
                float over = (m - KNEE) / (1f - KNEE);
                m = KNEE + (1f - KNEE) * (float) Math.tanh(over);
                y = y < 0 ? -m : m;
            }
            int v = Math.round(y * 32767f);
            if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
            buf[i] = (short) v;
        }
    }
}
