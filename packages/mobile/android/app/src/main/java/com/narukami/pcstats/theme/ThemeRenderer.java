package com.narukami.pcstats.theme;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;

import com.narukami.pcstats.R;

/**
 * One visual direction from the design spec. A renderer is given the whole
 * card rectangle and draws everything — background, both units, meters —
 * from the {@link Model} plus the eased channels in {@link Anim}.
 *
 * Renderers work in cq units: 1 cq = 1% of card width, which is exactly the
 * reference CSS's cqw, so dimensions copy across from the spec unchanged.
 */
public abstract class ThemeRenderer {

    /** Eased values the view interpolates between polls — the data motion layer. */
    public static class Anim {
        public float cpuLoad, cpuMem, cpuTemp = Float.NaN;   // fractions
        public float gpuLoad, gpuMem, gpuTemp = Float.NaN;
        public float[] cpuWave, gpuWave;                     // eased °C samples
        /** 0→1 once, on theme switch — the entrance layer. */
        public float entrance = 1f;
        /** Milliseconds since attach — drives ambient loops. Frozen when reduced motion. */
        public long clock;
        public boolean reducedMotion;
        /** Wall-clock time, formatted per the device's 12/24 h setting. */
        public String time;
        /** Milliseconds since the user last tapped the card; MAX_VALUE = never. */
        public float pokeAge = Float.MAX_VALUE;
        /** Card-space coordinates of that tap. */
        public float pokeX, pokeY;
        /** Where the user has dragged the pet to (card space); NaN = home spot. */
        public float petX = Float.NaN, petY = Float.NaN;
        /** Scheduled idle action: index 0–4, -1 = none; t runs 0→1 over the act. */
        public int petAct = -1;
        public float petActT;
        /** True while the user is carrying the pet — it lifts off its shadow. */
        public boolean petDragging;
    }

    /**
     * Typefaces resolved once by the view and shared by every renderer.
     * Substitutions (same precedent as the reference PNG renders): Inter→Roboto,
     * Barlow/Bebas/Anton→Roboto Condensed, DM Serif→system serif,
     * IBM Plex Mono/JetBrains Mono→bundled JetBrains Mono.
     */
    public static class Assets {
        public final Typeface mono, monoBold, sans, sansMedium, sansBold;
        public final Typeface condensed, condensedBold, serif;

        public Assets(Context ctx) {
            mono = ctx.getResources().getFont(R.font.jetbrains_mono_regular);
            monoBold = ctx.getResources().getFont(R.font.jetbrains_mono_bold);
            sans = Typeface.create("sans-serif", Typeface.NORMAL);
            sansMedium = Typeface.create("sans-serif-medium", Typeface.NORMAL);
            sansBold = Typeface.create("sans-serif", Typeface.BOLD);
            condensed = Typeface.create("sans-serif-condensed", Typeface.NORMAL);
            condensedBold = Typeface.create("sans-serif-condensed", Typeface.BOLD);
            serif = Typeface.create("serif", Typeface.NORMAL);
        }
    }

    protected final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    protected final Paint scratch = new Paint(Paint.ANTI_ALIAS_FLAG);

    /**
     * Type magnifier for squarer screens: when the card runs taller than the
     * reference proportions (tablets), text grows into the extra room. Applied
     * centrally in {@link #text} so every renderer inherits it; capped so
     * columns laid out in width units can never collide.
     */
    private float typeScale = 1f;
    private boolean petVisible = true;

    public final void setTypeScale(float s) {
        typeScale = Math.max(1f, Math.min(1.3f, s));
    }

    public final void setPetVisible(boolean v) {
        petVisible = v;
    }

    public abstract String id();

    /** Wants the slow ambient clock ticking (scanlines, blooms, pulses). */
    public boolean ambient() { return true; }

    /**
     * Paint the theme. The background must cover the FULL viewport (vw × vh)
     * so a zoomed-out card never floats on dead black; the instruments lay out
     * inside {@code card}, which the view centres or overflows with zoom.
     */
    public final void draw(Canvas c, float vw, float vh, android.graphics.RectF card,
                           Model m, Anim a, Assets f) {
        background(c, vw, vh, a);
        int save = c.save();
        c.translate(card.left, card.top);
        content(c, card.width(), card.height(), m, a, f);
        if (petVisible) pet(c, card.width(), card.height(), m, a, f);
        drawClock(c, card.width(), card.height(), a, f);
        c.restoreToCount(save);
        overlay(c, vw, vh, a);
    }

    /** The theme's resident critter, if it has one. Card space, above content. */
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {}

    /** The pet's current hit-box in card space (for drag pickup); null = no pet. */
    public android.graphics.RectF petBounds(float w, float h, Anim a) { return null; }

    // ── the time section: small, dim, themed — never competing with data ────

    /** Centre point of the clock's baseline; themes override to dodge headers. */
    protected float[] clockAnchor(float w, float h, float cq) {
        return new float[]{w / 2, 2.1f * cq};
    }

    /** The theme's caption tone — present but never competing with data. */
    protected int clockColor() { return 0x80FFFFFF; }

    protected Typeface clockFace(Assets f) { return f.mono; }

    /** The chip behind the time — each theme surfaces it in its own material. */
    protected int clockFill() { return 0x33000000; }

    protected int clockStroke() { return 0x2EFFFFFF; }

    /** Pill by default; hard-edged themes override to 0. */
    protected float clockRadius(float chipH) { return chipH / 2; }

    private void drawClock(Canvas c, float w, float h, Anim a, Assets f) {
        if (a.time == null || a.time.isEmpty()) return;
        float cq = w / 100f;
        float[] at = clockAnchor(w, h, cq);
        Paint t = text(1.45f * cq, clockFace(f), clockColor(), .14f);
        float tw = t.measureText(a.time);
        float size = t.getTextSize();
        // optional third anchor value aligns the CHIP EDGE to x:
        // 1 = right edge at x, -1 = left edge at x, absent/0 = centred on x
        float half = tw / 2 + 1.2f * cq;
        float cx = at.length > 2 && at[2] > 0 ? at[0] - half
                : at.length > 2 && at[2] < 0 ? at[0] + half : at[0];
        android.graphics.RectF chip = new android.graphics.RectF(
                cx - half, at[1] - size * .95f - .5f * cq,
                cx + half, at[1] + .6f * cq);
        clockChip(c, chip, clockRadius(chip.height()));
        c.drawText(a.time, cx - tw / 2, at[1], t);
    }

    /**
     * The chip's body: glass over a SOLID base — the sheen and specular give
     * it depth, the opaque fill guarantees nothing shows through from behind.
     * Overridable for special materials (Nixie warms its glass, for instance).
     */
    protected void clockChip(Canvas c, android.graphics.RectF chip, float r) {
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setColor(clockFill());                 // solid base, no see-through
        c.drawRoundRect(chip, r, r, scratch);
        scratch.setShader(new android.graphics.LinearGradient(0, chip.top, 0, chip.bottom,
                new int[]{0x40FFFFFF, 0x12FFFFFF, 0x0AFFFFFF}, new float[]{0, .55f, 1},
                android.graphics.Shader.TileMode.CLAMP));
        c.drawRoundRect(chip, r, r, scratch);
        scratch.setShader(null);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, chip.height() * .045f));
        scratch.setColor(clockStroke());
        c.drawRoundRect(chip, r, r, scratch);
        // specular highlight along the upper curve
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStrokeCap(Paint.Cap.ROUND);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1.5f, chip.height() * .07f));
        scratch.setShader(new android.graphics.LinearGradient(
                chip.left + r, 0, chip.right - r, 0,
                new int[]{0x00FFFFFF, 0x73FFFFFF, 0x00FFFFFF}, null,
                android.graphics.Shader.TileMode.CLAMP));
        float hy = chip.top + chip.height() * .18f;
        c.drawLine(chip.left + r * .9f, hy, chip.right - r * .9f, hy, scratch);
        scratch.setShader(null);
    }

    /** Full-viewport field behind the instruments. */
    protected abstract void background(Canvas c, float vw, float vh, Anim a);

    /** The readout itself, in card coordinates (0,0 .. w,h). */
    protected abstract void content(Canvas c, float w, float h, Model m, Anim a, Assets f);

    /** Full-viewport pass above everything (scanlines, vignette). Optional. */
    protected void overlay(Canvas c, float vw, float vh, Anim a) {}

    // ── shared text helpers ─────────────────────────────────────────────────

    /** Configure the shared paint for text: size, face, colour, tracking (em). */
    protected Paint text(float sizePx, Typeface face, int color, float trackingEm) {
        p.reset();
        p.setAntiAlias(true);
        p.setTypeface(face);
        p.setTextSize(sizePx * typeScale);
        p.setColor(color);
        p.setLetterSpacing(trackingEm);
        return p;
    }

    /** Draw right-aligned text ending at x. */
    protected void rightText(Canvas c, String s, float x, float y, Paint paint) {
        c.drawText(s, x - paint.measureText(s), y, paint);
    }

    /** Ease helper for the entrance layer. */
    protected static float easeOut(float t) {
        float x = Math.max(0, Math.min(1, t));
        return 1 - (1 - x) * (1 - x) * (1 - x);
    }
}
