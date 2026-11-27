import com.msb.elevenminutes.QuietBoost;
import java.util.Random;

/* Runs the quiet-voice boost on a desktop JVM against synthetic audio and measures it.
   No Android needed. From the repo root:

     javac -d build/qb app/src/main/java/com/msb/elevenminutes/QuietBoost.java test/QuietBoostCheck.java
     java -cp build/qb QuietBoostCheck

   The audio: a quiet room (white noise at -60 dBFS RMS), a quiet child's word (a voiced
   220 Hz tone with harmonics and two syllables, peaking at -36 dBFS), the room again, then
   an adult speaking normally (peaking at -6 dBFS), then the room. Exits non-zero if the
   boost does not lift the quiet word, lifts the room, or clips the loud one. */
public class QuietBoostCheck {
    static final int RATE = 16000;
    static final Random RNG = new Random(7);

    static double db(double lin) { return 20 * Math.log10(Math.max(lin, 1e-9)); }

    static void noise(float[] a, int from, int to, double rmsDb) {
        double s = Math.pow(10, rmsDb / 20) * Math.sqrt(3);    // uniform noise: rms = amp/sqrt(3)
        for (int i = from; i < to; i++) a[i] += (float) ((RNG.nextDouble() * 2 - 1) * s);
    }

    static void word(float[] a, int from, int to, double peakDb) {
        double peak = Math.pow(10, peakDb / 20);
        int n = to - from;
        for (int i = 0; i < n; i++) {
            double t = (double) i / RATE;
            double syll = Math.pow(Math.sin(Math.PI * 2 * i / n), 2);   // two syllables
            double v = 0.6 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 440 * t)
                     + 0.1 * Math.sin(2 * Math.PI * 660 * t);
            a[from + i] += (float) (peak * syll * v);
        }
    }

    static double peak(short[] s, int from, int to) {
        int p = 0; for (int i = from; i < to; i++) p = Math.max(p, Math.abs(s[i]));
        return p / 32768.0;
    }
    static double rms(short[] s, int from, int to) {
        double sum = 0; for (int i = from; i < to; i++) sum += (double) s[i] * s[i];
        return Math.sqrt(sum / (to - from)) / 32768.0;
    }

    public static void main(String[] args) {
        int s = RATE;                                   // one second
        int[] cut = { 0, s, s + 3 * s / 4, 3 * s, 3 * s + 3 * s / 4, 5 * s };
        float[] a = new float[cut[5]];
        noise(a, 0, a.length, -60);
        word(a, cut[1], cut[2], -36);                   // the quiet child
        word(a, cut[3], cut[4], -6);                    // the adult

        short[] in = new short[a.length];
        for (int i = 0; i < a.length; i++) in[i] = (short) Math.max(-32768, Math.min(32767, Math.round(a[i] * 32767)));
        short[] out = in.clone();

        QuietBoost b = QuietBoost.forSpeech(RATE);
        for (int i = 0; i < out.length; i += 1280) {    // 80ms reads, like the bridge
            int n = Math.min(1280, out.length - i);
            short[] chunk = new short[n];
            System.arraycopy(out, i, chunk, 0, n);
            b.process(chunk, n);
            System.arraycopy(chunk, 0, out, i, n);
        }

        // the room before anyone speaks (after the first 200ms, while the floor settles)
        double roomIn = rms(in, s / 5, cut[1]), roomOut = rms(out, s / 5, cut[1]);
        // the room straight after the quiet word, from 300ms on (the boost must let go)
        double tailIn = rms(in, cut[2] + 3 * s / 10, cut[3]), tailOut = rms(out, cut[2] + 3 * s / 10, cut[3]);
        double quietIn = peak(in, cut[1], cut[2]), quietOut = peak(out, cut[1], cut[2]);
        double loudIn = peak(in, cut[3], cut[4]), loudOut = peak(out, cut[3], cut[4]);

        double lift = db(quietOut) - db(quietIn);
        double roomLift = db(roomOut) - db(roomIn);
        double tailLift = db(tailOut) - db(tailIn);

        System.out.printf("quiet word: %.1f dBFS in, %.1f dBFS out (+%.1f dB)%n", db(quietIn), db(quietOut), lift);
        System.out.printf("room before: %.1f dBFS in, %.1f dBFS out (%+.1f dB)%n", db(roomIn), db(roomOut), roomLift);
        System.out.printf("room after the word: %.1f in, %.1f out (%+.1f dB)%n", db(tailIn), db(tailOut), tailLift);
        System.out.printf("loud word: %.1f dBFS in, %.1f dBFS out%n", db(loudIn), db(loudOut));

        int fail = 0;
        if (lift < 14) { System.out.println("FAIL: the quiet word was lifted less than 14 dB"); fail++; }
        if (roomLift > 3) { System.out.println("FAIL: the room was boosted more than 3 dB"); fail++; }
        if (tailLift > 6) { System.out.println("FAIL: the boost did not let go of the room after the word"); fail++; }
        if (loudOut > 0.995) { System.out.println("FAIL: the loud word clipped"); fail++; }
        if (db(loudOut) < db(loudIn) - 1.5) { System.out.println("FAIL: the loud word was turned down"); fail++; }
        System.out.println(fail == 0 ? "quiet boost: all checks pass" : fail + " check(s) failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
