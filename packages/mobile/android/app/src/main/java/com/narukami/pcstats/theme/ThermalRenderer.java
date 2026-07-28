package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;

import java.util.Locale;

/**
 * 04 · Thermal — infrared read: temperature colours the whole surface. Each
 * half's background gradient hue and opacity are computed from its die temp,
 * so a hot CPU half runs orange while the cool GPU half stays violet. The
 * enormous number never moves — only its colour context does.
 */
class ThermalRenderer extends ThemeRenderer {

    private static final int BASE = 0xFF0A0A0C, INK = 0xFFEFEAE4;
    private static final int CAP50 = 0x80EFEAE4, CAP55 = 0x8CEFEAE4, CAP62 = 0x9EEFEAE4;
    private static final int[] RAMP = {0xFF141433, 0xFF2B1F6B, 0xFF8F1F6D, 0xFFD4442A, 0xFFFFB02E, 0xFFFFF3C4};

    @Override
    public String id() { return "thermal"; }

    private final Critter critter = new Critter(Critter.ROUND, Critter.TUFT,
            Critter.EYE_GLOW, Critter.M_EMBER, 0xFF141018, 0x66EFEAE4, 0x1AEFEAE4,
            0xFFFFB02E, 0xFFFFB02E, 0xFFFF5A3C, 0xFFFFB02E, false, 0.5f, 0.49f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected float[] clockAnchor(float w, float h, float cq) {
        // upper right with real margin, well above the DIE TEMP block
        return new float[]{w - 3 * cq, 4 * cq, 1};
    }

    @Override
    protected int clockColor() { return CAP55; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.mono; }

    @Override
    protected int clockFill() { return 0xFF141018; }

    @Override
    protected int clockStroke() { return 0x2EFFFFFF; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(BASE);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float unitH = h / 2;
        drawUnit(c, 0, 0, w, unitH, cq, m.cpu, a.cpuTemp, a, true, f);
        scratch.reset();
        scratch.setColor(0x1AFFFFFF);
        c.drawRect(0, unitH, w, unitH + Math.max(1, cq * .06f), scratch);
        drawUnit(c, 0, unitH, w, unitH, cq, m.gpu, a.gpuTemp, a, false, f);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, float temp, Anim a, boolean isCpu, Assets f) {
        int save = c.save();
        c.clipRect(x, y, x + w, y + unitH);

        // the IR field wash — this IS the readout
        float p = Float.isNaN(temp) ? 0 : (float) Model.clamp01(temp) * easeOut(a.entrance);
        int cool = 0xD91C1A56, warm = 0xD9BE2C54, hot = 0xE6FFA828;
        int mid = p > .6f ? hot : warm;
        scratch.reset();
        scratch.setShader(new RadialGradient(x + w * .78f, y + unitH * .5f, w * .55f,
                new int[]{mid, warm, cool, BASE}, new float[]{0, .26f, .58f, .82f},
                Shader.TileMode.CLAMP));
        scratch.setAlpha((int) (255 * (.5f + p * .45f)));
        c.drawRect(x, y, x + w, y + unitH, scratch);
        // scan texture: vertical hairlines with the slow 6 s drift
        float drift = a.reducedMotion ? 0 : (a.clock % 6000) / 6000f * .5f * cq;
        scratch.reset();
        scratch.setColor(0x47000000);
        for (float sx = x - .5f * cq + drift; sx < x + w; sx += .5f * cq) {
            c.drawRect(sx, y, sx + 1.5f, y + unitH, scratch);
        }

        // title
        float px = x + 3 * cq, ty = y + 2.2f * cq;
        Paint b = text(1.05f * cq, f.monoBold, INK, .3f);
        c.drawText(u.tag, px, ty, b);
        c.drawText(u.name + (u.spec.isEmpty() ? "" : " · " + u.spec),
                px + b.measureText(u.tag) + .9f * cq, ty, text(1.05f * cq, f.mono, CAP55, .1f));

        // three stat rows with 18-cell ladders
        float rowsW = Math.min(52 * cq, w * .5f);
        float colGap = 1.6f * cq, colW = (rowsW - 2 * colGap) / 3;
        float ry = y + unitH * .48f;
        float enter = easeOut(a.entrance);
        String thirdK = isCpu ? "CLOCK" : "POWER";
        String thirdV = isCpu
                ? (u.clockMHz == null ? "—" : String.format(Locale.US, "%.2f GHz", u.clockMHz / 1000))
                : (u.powerW == null ? "—" : String.format(Locale.US, "%.1f W", u.powerW));
        float thirdFrac = isCpu
                ? (u.clockMHz == null ? 0 : (float) Model.clamp01(u.clockMHz / 4000))
                : (u.powerW == null ? 0 : (float) Model.clamp01(u.powerW
                / (u.powerLimitW != null && u.powerLimitW > 0 ? u.powerLimitW : 90)));
        boolean hotTone = p > .6f;
        row(c, px, ry, colW, cq, "LOAD", u.loadText,
                u.loadFrac == null ? 0 : (isCpu ? a.cpuLoad : a.gpuLoad) * enter, hotTone, f);
        row(c, px + colW + colGap, ry, colW, cq, u.memLabel, u.memText,
                u.memFrac == null ? 0 : (isCpu ? a.cpuMem : a.gpuMem) * enter, hotTone, f);
        row(c, px + 2 * (colW + colGap), ry, colW, cq, thirdK, thirdV, thirdFrac * enter, hotTone, f);

        // the enormous temp — colour only, no transform, it's 7.4cq tall
        float bx = x + w - 3 * cq;
        Paint k = text(.75f * cq, f.mono, CAP55, .36f);
        rightText(c, "DIE TEMP", bx, y + unitH * .3f, k);
        // superscript unit hugs the digits, like the reference's <sup>
        Paint sup = text(2 * cq, f.mono, INK, 0);
        float supW = sup.measureText("°C");
        Paint n = text(7.4f * cq, f.monoBold, u.tempC == null ? CAP50 : INK, -.055f);
        String tv = u.tempC == null ? "—" : String.valueOf(Math.round(u.tempC));
        float numRight = bx - supW - .5f * cq;
        float numY = y + unitH * .62f;
        c.drawText(tv, numRight - n.measureText(tv), numY, n);
        c.drawText("°C", numRight + .3f * cq, numY - 7.4f * cq * .55f,
                text(2 * cq, f.mono, INK, 0));
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        String foot = u.tempC == null ? noteShort(u)
                : isCpu && head != null ? head + "°C BELOW Tj MAX " + (u.tjMaxC == null ? 100 : u.tjMaxC)
                : u.note.toUpperCase();
        rightText(c, foot, bx, y + unitH * .74f, text(.78f * cq, f.mono, CAP62, .16f));

        // ramp key, bottom-left
        float ky = y + unitH - 1.5f * cq;
        Paint cap = text(.66f * cq, f.mono, CAP50, .22f);
        c.drawText("30", px, ky + .2f * cq, cap);
        float rampX = px + 1.6f * cq, rampW = 14 * cq;
        scratch.reset();
        scratch.setShader(new LinearGradient(rampX, 0, rampX + rampW, 0, RAMP, null, Shader.TileMode.CLAMP));
        c.drawRect(rampX, ky - .3f * cq, rampX + rampW, ky + .2f * cq, scratch);
        scratch.setShader(null);
        c.drawText("100", rampX + rampW + .7f * cq, ky + .2f * cq, cap);

        c.restoreToCount(save);
    }

    private void row(Canvas c, float x, float y, float colW, float cq, String key, String value,
                     float frac, boolean hot, Assets f) {
        c.drawText(key, x, y, text(.72f * cq, f.mono, CAP50, .34f));
        c.drawText(value, x, y + 2.1f * cq, text(2 * cq, f.monoBold, INK, -.02f));
        int lit = Model.litCells(18, (double) Model.clamp01(frac));
        float gap = .2f * cq, cell = (colW - 17 * gap) / 18;
        scratch.reset();
        for (int i = 0; i < 18; i++) {
            scratch.setColor(i < lit ? (hot ? 0xFFFFB02E : 0xFF7BE0D8) : 0x21FFFFFF);
            float cx = x + i * (cell + gap);
            c.drawRect(cx, y + 2.8f * cq, cx + cell, y + 3.3f * cq, scratch);
        }
    }

    private static String noteShort(Model.Unit u) {
        String s = u.note.toUpperCase();
        return s.length() > 30 ? s.substring(0, 30) : s;
    }
}
