package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * 01 · Phosphor — CRT bench terminal. Black field, JetBrains Mono, segmented
 * block meters over a temperature sparkline, scanlines and a vignette on top.
 *
 * Amber is reserved: the unit tags, the memory segments and the CPU die temp.
 * Everything else is phosphor green — the restraint is the design.
 */
class PhosphorRenderer extends ThemeRenderer {

    private static final int GREEN = 0xFF7DFAA8, AMBER = 0xFFFFC247;
    private static final int SEG_G = 0xFF5FF08E, SEG_A = 0xFFFFB42E, SEG_DIM = 0xFF12241A;
    private static final int LABEL = 0xFF639178, HEAD_M = 0xFF4D6B56, HEAD_R = 0xFF61896F;
    private static final int DIM_VAL = 0xFF4F7059;
    private static final int GLOW_G = 0x735DFF96, GLOW_A = 0x80FFB43C;

    private final Path line = new Path(), area = new Path();

    @Override
    public String id() { return "phosphor"; }

    private final Critter critter = new Critter(Critter.ROUND, Critter.TUFT,
            Critter.EYE_GLOW, Critter.M_SCAN, 0xFF0E1A12, 0xFF2E4A38, 0xFF13241A,
            0xFF5FF08E, 0xFF5FF08E, 0xFFFFB42E, 0xFFFFC247, false, 0.94f, 0.54f);

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
        // upper right, tucked below the TJ MAX caption in the wave's dark sky
        return new float[]{w - 3 * cq, 6.4f * cq, 1};
    }

    @Override
    protected int clockColor() { return LABEL; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.mono; }

    @Override
    protected int clockFill() { return 0xFF0A0F0A; }

    @Override
    protected int clockStroke() { return 0x59639178; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(Color.BLACK);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;

        // entrance: horizontal wipe, 700 ms ease-out
        int save = c.save();
        if (a.entrance < 1f) c.clipRect(0, 0, w * easeOut(a.entrance), h);

        float padX = 3 * cq, padY = 2.6f * cq, gap = 2.2f * cq;
        float unitH = (h - 2 * padY - gap) / 2;
        drawUnit(c, padX, padY, w - 2 * padX, unitH, cq, m.cpu, a.cpuWave, a,
                a.cpuLoad, a.cpuMem, true, f);
        drawUnit(c, padX, padY + unitH + gap, w - 2 * padX, unitH, cq, m.gpu, a.gpuWave, a,
                a.gpuLoad, a.gpuMem, false, f);

        c.restoreToCount(save);
    }

    @Override
    protected void overlay(Canvas c, float vw, float vh, Anim a) {
        // vignette, then scanlines with the 8 s ambient drift — the CRT tell.
        // Full viewport: the tube effect covers the glass, not just the card.
        scratch.reset();
        scratch.setShader(new RadialGradient(vw / 2, vh * .45f, vw * .62f,
                new int[]{0x00000000, 0x00000000, 0xBF000000},
                new float[]{0f, .4f, 1f}, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, vw, vh, scratch);
        scratch.reset();
        scratch.setColor(0x0BFFFFFF);
        float drift = a.reducedMotion ? 0 : (a.clock % 8000) / 8000f * 3f;
        for (float y = -3 + drift; y < vh; y += 3) c.drawRect(0, y, vw, y + 1, scratch);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float h, float cq,
                          Model.Unit u, float[] wave, Anim a,
                          float loadFrac, float memFrac, boolean isCpu, Assets f) {
        int strokeC = isCpu ? SEG_A : SEG_G;
        int fillC = isCpu ? 0x33FFB42E : 0x295FF08E;
        if (wave != null && wave.length >= 2) {
            float min = Float.MAX_VALUE, max = -Float.MAX_VALUE;
            for (float v : wave) { min = Math.min(min, v); max = Math.max(max, v); }
            min -= 14; max += 6;                       // the reference head/footroom
            RectF box = new RectF(x, y + h * .05f, x + w, y + h);
            scratch.setAlpha(140);
            Draw.wave(c, line, area, wave, box, min, max, strokeC, fillC, cq * .12f, scratch);
        }

        // head row
        float headY = y + 1.15f * cq;
        Paint t = text(1.15f * cq, f.monoBold, AMBER, .3f);
        t.setShadowLayer(cq, 0, 0, GLOW_A);
        c.drawText(u.tag, x, headY, t);
        float kw = t.measureText(u.tag);
        t = text(1.15f * cq, f.mono, HEAD_M, .12f);
        c.drawText(headline(u), x + kw + cq, headY, t);
        t = text(1.15f * cq, f.mono, HEAD_R, .16f);
        String r = u.tjMaxC != null ? "TJ MAX " + u.tjMaxC + " · RANGE 30–100" : "RANGE 30–100";
        rightText(c, r, x + w, headY, t);

        // body: three bottom-aligned columns — load · memory · die temp.
        // Reference tones: values are green everywhere except the CPU die temp;
        // amber segments are spent on memory (CPU only). GPU stays green.
        float gap = 2 * cq, colW = (w - 2 * gap) / 3.05f;
        float bot = y + h;
        drawMeterCol(c, x, bot, colW, cq, "LOAD", u.loadText, u.loadFrac != null,
                loadFrac, SEG_G, GLOW_G, f, a);
        drawMeterCol(c, x + colW + gap, bot, colW, cq, u.memLabel, u.memText, u.memFrac != null,
                memFrac, isCpu ? SEG_A : SEG_G, isCpu ? GLOW_A : GLOW_G, f, a);

        // temp column: value + sub line, no segments. NOTE: text() hands back
        // one shared Paint, so each configure must be used before the next.
        float cx = x + 2 * (colW + gap);
        boolean hot = isCpu && u.tempC != null;        // CPU die temp is the amber value
        float subY = bot - .1f * cq;
        float valY = subY - .86f * cq - .9f * cq;
        Paint val = text(4.4f * cq, f.monoBold, u.tempC == null ? DIM_VAL : (hot ? AMBER : GREEN), -.02f);
        if (u.tempC != null) {
            val.setShadowLayer(cq, 0, 0, hot ? GLOW_A : GLOW_G);
            // the .a flicker: one dim frame every 6 s, amber values only
            if (hot && !a.reducedMotion && a.clock % 6000 < 100) val.setAlpha(219);
        }
        c.drawText(u.tempText, cx, valY, val);
        c.drawText("DIE TEMP", cx, valY - 4.4f * cq * .82f - .6f * cq,
                text(.82f * cq, f.mono, LABEL, .42f));
        c.drawText(u.note.toUpperCase(), cx, subY, text(.86f * cq, f.mono, LABEL, .16f));
    }

    private void drawMeterCol(Canvas c, float x, float bot, float colW, float cq,
                              String label, String value, boolean present, float frac,
                              int segOn, int glow, Assets f, Anim a) {
        RectF seg = new RectF(x, bot - .62f * cq, x + colW, bot);
        int lit = present ? Model.litCells(28, (double) (frac * easeOut(a.entrance))) : 0;
        if (lit > 0) {                                  // soft halo behind the lit run
            scratch.reset();
            scratch.setColor(glow & 0x30FFFFFF | (glow & 0x00FFFFFF));
            scratch.setAlpha(48);
            float litW = seg.width() * lit / 28f;
            c.drawRoundRect(seg.left - cq * .1f, seg.top - cq * .25f,
                    seg.left + litW + cq * .1f, seg.bottom + cq * .25f, cq * .3f, cq * .3f, scratch);
        }
        Draw.segMeter(c, seg, 28, lit, .28f * cq, SEG_DIM, segOn, scratch);

        float valY = seg.top - cq;
        Paint val = text(4.4f * cq, f.monoBold, present ? GREEN : DIM_VAL, -.02f);
        if (present) val.setShadowLayer(cq, 0, 0, GLOW_G);
        c.drawText(value, x, valY, val);
        c.drawText(label, x, valY - 4.4f * cq * .82f - .6f * cq,
                text(.82f * cq, f.mono, LABEL, .42f));
    }

    private static String headline(Model.Unit u) {
        return u.spec.isEmpty() ? u.name : u.name + " · " + u.spec;
    }
}
