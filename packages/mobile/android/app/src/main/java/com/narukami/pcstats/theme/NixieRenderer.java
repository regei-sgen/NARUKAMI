package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * 05 · Nixie — tube instrument with brass bezel. Orange-glow digit tubes and
 * real moving-coil meters: 130° sweep, brass ticks, a red zone, and a needle
 * that overshoots like physics. Load meter reads 0–100; temp reads 30–100.
 */
class NixieRenderer extends ThemeRenderer {

    private static final int WALNUT0 = 0xFF241D15, WALNUT1 = 0xFF0D0A07;
    private static final int GLOW = 0xFFFF9A2E, GLOW_DIM = 0xFFC2762A;
    private static final int BRASS = 0xFF8C7A55, RED = 0xFFC9402A;
    private static final int PLATE = 0xFFD8C9A6, NEEDLE = 0xFFFFCE7A;

    @Override
    public String id() { return "nixie"; }

    @Override
    protected int clockColor() { return PLATE; }   // engraved cream, legible on glass

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.mono; }

    @Override
    protected float[] clockAnchor(float w, float h, float cq) {
        // upper-right corner, pill centre riding the CPU panel's top bezel line
        return new float[]{w - 3.2f * cq, 3.3f * cq, 1};
    }

    /** Glass pill: opaque walnut base (hides the bezel line behind it), warm
     *  glass sheen on top, specular highlight, soft glass rim. */
    @Override
    protected void clockChip(Canvas c, RectF chip, float r) {
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setColor(0xFF1C160F);                    // solid base — nothing shows through
        c.drawRoundRect(chip, r, r, scratch);
        scratch.setShader(new LinearGradient(0, chip.top, 0, chip.bottom,
                new int[]{0x38FFF3E0, 0x17FFDDAA, 0x0FFFFFFF},
                new float[]{0, .55f, 1}, Shader.TileMode.CLAMP));
        c.drawRoundRect(chip, r, r, scratch);
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, chip.height() * .045f));
        scratch.setColor(0x59FFE7C2);
        c.drawRoundRect(chip, r, r, scratch);
        // specular highlight along the pill's upper curve
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStrokeCap(Paint.Cap.ROUND);
        scratch.setStrokeWidth(Math.max(1.5f, chip.height() * .07f));
        scratch.setShader(new LinearGradient(chip.left + r, 0, chip.right - r, 0,
                new int[]{0x00FFFFFF, 0x80FFFFFF, 0x00FFFFFF}, null, Shader.TileMode.CLAMP));
        float hy = chip.top + chip.height() * .18f;
        c.drawLine(chip.left + r * .9f, hy, chip.right - r * .9f, hy, scratch);
    }

    @Override
    protected int clockStroke() { return 0x598C7A55; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        scratch.reset();
        scratch.setShader(new RadialGradient(vw / 2, 0, vw * 1.1f,
                WALNUT0, WALNUT1, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, vw, vh, scratch);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float pad = 2.4f * cq, gap = 1.6f * cq;
        float unitH = (h - 2 * pad - gap) / 2;
        drawUnit(c, pad, pad, w - 2 * pad, unitH, cq, m.cpu, a, true, f);
        drawUnit(c, pad, pad + unitH + gap, w - 2 * pad, unitH, cq, m.gpu, a, false, f);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, Anim a, boolean isCpu, Assets f) {
        RectF panel = new RectF(x, y, x + w, y + unitH);
        scratch.reset();
        scratch.setShader(new LinearGradient(0, y, 0, y + unitH,
                0xFF1C160F, 0xFF100C08, Shader.TileMode.CLAMP));
        c.drawRoundRect(panel, .7f * cq, .7f * cq, scratch);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .07f));
        scratch.setColor(0xFF4A3A22);
        c.drawRoundRect(panel, .7f * cq, .7f * cq, scratch);
        scratch.setColor(0x47D6B26E);   // brass inner bevel
        c.drawLine(panel.left + cq, panel.top + cq * .15f, panel.right - cq, panel.top + cq * .15f, scratch);

        float px = x + 2 * cq;
        c.drawText(isCpu ? "CENTRAL PROCESSOR" : "GRAPHICS PROCESSOR", px, y + 1.9f * cq,
                text(.8f * cq, f.mono, BRASS, .42f));
        c.drawText(u.name + (u.spec.isEmpty() ? "" : " · " + u.spec), px, y + 3.6f * cq,
                text(1.35f * cq, f.mono, PLATE, .1f));

        // one instrument row: tubes and meters share a midline below the header
        float meterW = 16.5f * cq;
        float contentTop = y + 4.2f * cq, contentBot = y + unitH - 1 * cq;
        float mid = (contentTop + contentBot) / 2;

        float tubesW = w - 2 * meterW - 3 * 2 * cq - 2 * cq;
        float tubeGap = 1.6f * cq, tubeW = (tubesW - 2 * tubeGap) / 3;
        float tubeH = Math.min(6 * cq, contentBot - contentTop);
        float tubeY = mid - tubeH / 2;
        float enter = easeOut(a.entrance);
        String[][] tubes = {
                {"LOAD", big(u.loadText), small(u.loadText)},
                {u.memLabel, big(u.memText), small(u.memText)},
                {"DIE TEMP", u.tempC == null ? "—" : String.valueOf(Math.round(u.tempC)),
                        u.tempC == null ? "" : "°C"},
        };
        for (int i = 0; i < 3; i++) {
            tube(c, px + i * (tubeW + tubeGap), tubeY, tubeW, tubeH, cq, tubes[i], enter, a, i, f);
        }

        // moving-coil meters, arc centres sitting on the same midline
        float m1x = x + w - 2 * meterW - 3 * cq;
        float m2x = x + w - meterW - 2 * cq;
        float my = mid - meterW * .32f;   // puts the arc's visual centre on the midline
        float load = isCpu ? a.cpuLoad : a.gpuLoad;
        float temp = isCpu ? a.cpuTemp : a.gpuTemp;
        meter(c, m1x, my, meterW, cq, u.loadFrac == null ? Float.NaN : load * enter, .70f, f);
        meter(c, m2x, my, meterW, cq, Float.isNaN(temp) ? Float.NaN : temp * enter,
                (85 - 30) / 70f, f);
        // engraved captions on one shared baseline under both pivots
        Paint cap = text(.66f * cq, f.mono, BRASS, .32f);
        float capY = my + meterW * .52f + 2.6f * cq;
        String c1 = "LOAD %", c2 = "DIE TEMP 30–100";
        c.drawText(c1, m1x + (meterW - cap.measureText(c1)) / 2, capY, cap);
        c.drawText(c2, m2x + (meterW - cap.measureText(c2)) / 2, capY, cap);
    }

    /**
     * The resident: a little brass owl perched on the GPU panel's top bezel.
     * Its eyes are nixie tubes — they glow, flicker, blink, and run red when
     * the CPU crowds Tj max. A tap startles it into a hop with flared eyes.
     */
    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float pad = 2.4f * cq, gap = 1.6f * cq;
        // home: perched on the GPU panel's top line — unless carried elsewhere
        float perchY = Float.isNaN(a.petY) ? pad + (h - 2 * pad - gap) / 2 + gap : a.petY;
        float cx = Float.isNaN(a.petX) ? w - 8.5f * cq : a.petX;
        float s = 1.9f * cq;                                   // body radius unit

        boolean poked = a.pokeAge < 900;
        float hop = poked && !a.reducedMotion
                ? (float) Math.sin(a.pokeAge / 900f * Math.PI) * 1.3f * cq : 0;
        float breathe = a.reducedMotion ? 0
                : (float) Math.sin(a.clock / 3800.0 * 2 * Math.PI) * .02f * s;
        float baseY = perchY - hop;

        // idle acts: 0 preen · 1 hoot · 2 wing stretch · 3 look around · 4 doze
        int act = a.petAct;
        float at = a.petActT;
        float actS = act >= 0 ? (float) Math.sin(at * Math.PI) : 0;

        // grounded contact shadow — outside every transform, so hops, preens
        // and carries visibly lift the owl off it
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setShader(new RadialGradient(cx, perchY + s * .05f, s * .95f,
                0x59000000, 0x00000000, Shader.TileMode.CLAMP));
        c.save();
        c.scale(1f, .2f, cx, perchY + s * .05f);
        c.drawCircle(cx, perchY + s * .05f, s * .95f, scratch);
        c.restore();
        scratch.setShader(null);

        int actSave = c.save();
        if (a.petDragging && !a.reducedMotion) {          // picked up: tilt + lift
            c.rotate(-5, cx, perchY);
            c.translate(0, -.7f * cq);
        }
        if (act == 0) c.rotate(12 * actS, cx, baseY);                 // preen tilt
        if (act == 1) c.scale(1 + .09f * actS, 1 + .09f * actS, cx, baseY); // hoot puff
        if (act == 2) {                                               // wing stretch
            scratch.reset();
            scratch.setAntiAlias(true);
            scratch.setColor(0xFF2A2013);
            float span = s * 1.1f * actS;
            RectF wing = new RectF(cx - s - span, baseY - s * 1.4f, cx - s * .6f, baseY - s * .9f);
            c.drawRoundRect(wing, s * .25f, s * .25f, scratch);
            wing.set(cx + s * .6f, baseY - s * 1.4f, cx + s + span, baseY - s * .9f);
            c.drawRoundRect(wing, s * .25f, s * .25f, scratch);
            scratch.setStyle(Paint.Style.STROKE);
            scratch.setStrokeWidth(Math.max(1.5f, cq * .08f));
            scratch.setColor(BRASS);
            c.drawRoundRect(wing, s * .25f, s * .25f, scratch);
            wing.set(cx - s - span, baseY - s * 1.4f, cx - s * .6f, baseY - s * .9f);
            c.drawRoundRect(wing, s * .25f, s * .25f, scratch);
        }

        // body: dark walnut egg with a brass rim, lit from the upper left
        scratch.reset();
        scratch.setAntiAlias(true);
        RectF body = new RectF(cx - s, baseY - 2.15f * s - breathe, cx + s, baseY);
        scratch.setColor(0xFF2A2013);
        c.drawRoundRect(body, s, s, scratch);
        scratch.setShader(new LinearGradient(body.left, body.top, body.right, body.bottom,
                new int[]{0x33FFE7C2, 0x00FFFFFF, 0x40000000}, new float[]{0, .45f, 1},
                Shader.TileMode.CLAMP));
        c.drawRoundRect(body, s, s, scratch);
        scratch.setShader(null);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1.5f, cq * .09f));
        scratch.setColor(BRASS);
        c.drawRoundRect(body, s, s, scratch);
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setColor(0xFF1C160F);
        RectF belly = new RectF(cx - s * .58f, baseY - s * 1.05f, cx + s * .58f, baseY - s * .08f);
        c.drawRoundRect(belly, s * .5f, s * .5f, scratch);

        // ear tufts — raised when startled
        float tuft = poked ? s * .5f : s * .32f;
        scratch.setColor(0xFF2A2013);
        c.drawCircle(cx - s * .62f, body.top + s * .1f - tuft * .4f, tuft, scratch);
        c.drawCircle(cx + s * .62f, body.top + s * .1f - tuft * .4f, tuft, scratch);

        // nixie-tube eyes: sockets, then glowing filament pupils
        float eyeY = body.top + s * .75f, eyeR = s * .42f;
        scratch.setColor(0xFF120D08);
        c.drawCircle(cx - s * .5f, eyeY, eyeR, scratch);
        c.drawCircle(cx + s * .5f, eyeY, eyeR, scratch);
        boolean hotMood = m.cpu.tempFrac != null && m.cpu.tempFrac >= .8;
        boolean blink = (!a.reducedMotion && !poked && (a.clock % 4700) < 130)
                || act == 4;                                           // dozing = eyes shut
        float flick = a.reducedMotion ? 1
                : .9f + .1f * (float) Math.sin(a.clock / 900.0 * 2 * Math.PI + 1.3);
        int glow = hotMood ? 0xFFFF4A2E : GLOW;
        if (blink) {
            scratch.setColor(BRASS);
            scratch.setStrokeWidth(Math.max(1.5f, cq * .09f));
            c.drawLine(cx - s * .78f, eyeY, cx - s * .22f, eyeY, scratch);
            c.drawLine(cx + s * .22f, eyeY, cx + s * .78f, eyeY, scratch);
        } else {
            scratch.reset();
            scratch.setAntiAlias(true);
            scratch.setColor(glow);
            float pupil = poked ? eyeR * .72f : eyeR * .5f;
            if (act == 0) pupil *= 1 - .35f * actS;                    // preen squint
            float look = act == 3                                      // glance left, right
                    ? (float) Math.sin(at * 3 * Math.PI) * eyeR * .38f : 0;
            scratch.setShadowLayer(eyeR * (poked ? 1.4f : .8f) * flick, 0, 0, glow);
            c.drawCircle(cx - s * .5f + look, eyeY, pupil, scratch);
            c.drawCircle(cx + s * .5f + look, eyeY, pupil, scratch);
            scratch.clearShadowLayer();
            scratch.setColor(0xC8FFFFFF);              // tube-glass catchlights
            c.drawCircle(cx - s * .5f + look - pupil * .3f, eyeY - pupil * .35f, pupil * .28f, scratch);
            c.drawCircle(cx + s * .5f + look - pupil * .3f, eyeY - pupil * .35f, pupil * .28f, scratch);
            scratch.clearShadowLayer();
        }

        // hoot ripples from the beak; drifting z's while dozing
        if (act == 1 && at > .25f) {
            float rt = (at - .25f) / .75f;
            scratch.reset();
            scratch.setAntiAlias(true);
            scratch.setStyle(Paint.Style.STROKE);
            scratch.setStrokeWidth(Math.max(1.5f, cq * .08f));
            scratch.setColor(GLOW);
            scratch.setAlpha((int) (200 * (1 - rt)));
            c.drawCircle(cx, eyeY + s * .5f, s * (0.4f + rt * 1.6f), scratch);
            scratch.setAlpha((int) (120 * (1 - rt)));
            c.drawCircle(cx, eyeY + s * .5f, s * (0.4f + rt * 2.4f), scratch);
        }
        if (act == 4) {
            Paint z = text(.9f * cq, f.mono, BRASS, 0);
            z.setAlpha((int) (255 * (1 - at)));
            c.drawText("z", cx + s * 1.2f, body.top - at * 1.5f * cq, z);
            if (at > .35f) {
                z.setAlpha((int) (200 * (1 - at)));
                c.drawText("z", cx + s * 1.7f, body.top - .8f * cq - at * 1.9f * cq, z);
            }
        }
        c.restoreToCount(actSave);

        // brass beak + talons gripping the bezel
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setColor(BRASS);
        clipPath(c, cx, eyeY + s * .48f, s * .2f);
        c.drawCircle(cx - s * .45f, perchY, cq * .12f, scratch);
        c.drawCircle(cx - s * .2f, perchY, cq * .12f, scratch);
        c.drawCircle(cx + s * .2f, perchY, cq * .12f, scratch);
        c.drawCircle(cx + s * .45f, perchY, cq * .12f, scratch);
    }

    @Override
    public RectF petBounds(float w, float h, Anim a) {
        final float cq = w / 100f;
        float pad = 2.4f * cq, gap = 1.6f * cq;
        float perchY = Float.isNaN(a.petY) ? pad + (h - 2 * pad - gap) / 2 + gap : a.petY;
        float cx = Float.isNaN(a.petX) ? w - 8.5f * cq : a.petX;
        return new RectF(cx - 3 * cq, perchY - 6 * cq, cx + 3 * cq, perchY + 1.2f * cq);
    }

    /** Tiny triangle beak. */
    private void clipPath(Canvas c, float cx, float y, float r) {
        android.graphics.Path beak = new android.graphics.Path();
        beak.moveTo(cx - r, y - r * .6f);
        beak.lineTo(cx + r, y - r * .6f);
        beak.lineTo(cx, y + r);
        beak.close();
        c.drawPath(beak, scratch);
    }

    private void tube(Canvas c, float x, float y, float w, float h, float cq,
                      String[] kv, float enter, Anim a, int idx, Assets f) {
        RectF tube = new RectF(x, y, x + w, y + h);
        scratch.reset();
        scratch.setShader(new LinearGradient(0, y, 0, y + h,
                0x1AFF9628, 0x66000000, Shader.TileMode.CLAMP));
        c.drawRoundRect(tube, .35f * cq, .35f * cq, scratch);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        scratch.setColor(0x38FF9628);
        c.drawRoundRect(tube, .35f * cq, .35f * cq, scratch);
        c.drawText(kv[0], x + 1.1f * cq, y + 1.2f * cq, text(.66f * cq, f.mono, BRASS, .3f));
        // warm-up entrance + a per-tube randomised flicker in the glow radius
        float flick = a.reducedMotion ? 1
                : .92f + .08f * (float) Math.sin(a.clock / 4000.0 * 2 * Math.PI + idx * 2.1);
        Paint d = text(2.5f * cq, f.monoBold, GLOW, 0);
        d.setAlpha((int) (255 * enter));
        d.setShadowLayer(cq * .4f * flick * enter, 0, 0, 0xE6FF8C1E);
        c.drawText(kv[1], x + 1.1f * cq, y + h - .9f * cq, d);
        c.drawText(kv[2], x + 1.1f * cq + d.measureText(kv[1]) + .2f * cq, y + h - .9f * cq,
                text(1 * cq, f.mono, GLOW_DIM, 0));
    }

    /** The reference meter: A0 205°, span 130°, ticks every tenth, red zone. */
    private void meter(Canvas c, float x, float y, float mw, float cq, float frac, float redFrac,
                       Assets f) {
        float cx = x + mw / 2, cy = y + mw * .52f, r = mw * .41f;
        final float A0 = 205, SPAN = 130;
        RectF oval = new RectF(cx - r, cy - r, cx + r, cy + r);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1.5f, cq * .1f));
        scratch.setColor(0xFF6B5A38);
        c.drawArc(oval, A0, SPAN, false, scratch);
        scratch.setStrokeWidth(cq * .28f);
        scratch.setColor(RED);
        c.drawArc(oval, A0 + SPAN * redFrac, SPAN * (1 - redFrac), false, scratch);
        scratch.reset();
        scratch.setColor(BRASS);
        for (int i = 0; i <= 10; i++) {
            double ang = Math.toRadians(A0 + SPAN * i / 10);
            float o = (i % 5 == 0) ? mw * .06f : mw * .03f;
            scratch.setStrokeWidth(i % 5 == 0 ? cq * .14f : cq * .07f);
            c.drawLine(cx + (float) Math.cos(ang) * (r - 2),
                    cy + (float) Math.sin(ang) * (r - 2),
                    cx + (float) Math.cos(ang) * (r - 2 - o),
                    cy + (float) Math.sin(ang) * (r - 2 - o), scratch);
        }
        if (!Float.isNaN(frac)) {
            double ang = Math.toRadians(A0 + SPAN * Model.clamp01(frac));
            scratch.setStrokeWidth(cq * .18f);
            scratch.setColor(NEEDLE);
            scratch.setStrokeCap(Paint.Cap.ROUND);
            c.drawLine(cx, cy, cx + (float) Math.cos(ang) * (r - mw * .07f),
                    cy + (float) Math.sin(ang) * (r - mw * .07f), scratch);
        }
        scratch.reset();
        scratch.setColor(0xFF3A2F1C);
        c.drawCircle(cx, cy, cq * .35f, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        scratch.setColor(BRASS);
        c.drawCircle(cx, cy, cq * .35f, scratch);
    }

    private static String big(String v) {
        int cut = v.indexOf('/');
        if (cut > 0) return v.substring(0, cut);
        return v.endsWith("%") ? v.substring(0, v.length() - 1) : v;
    }

    private static String small(String v) {
        int cut = v.indexOf('/');
        if (cut > 0) return v.substring(cut);
        return v.endsWith("%") ? "%" : "";
    }
}
