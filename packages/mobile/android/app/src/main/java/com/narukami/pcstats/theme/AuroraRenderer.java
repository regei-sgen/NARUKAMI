package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * 03 · Aurora — soft glass on an indigo field. Two frosted cards, each with a
 * 274° temperature dial and a full-bleed history strip that meets the card's
 * edges; violet blooms drift behind everything on an 18/24 s loop.
 */
class AuroraRenderer extends ThemeRenderer {

    private static final int INK = 0xFFE7E9F5;
    private static final int LABEL = 0x73E7E9F5, SPEC = 0x80E7E9F5;
    private static final int CARD_TOP = 0x13FFFFFF, CARD_BOT = 0x07FFFFFF, BORDER = 0x1AFFFFFF;
    private static final int DIAL_TRACK = 0x21FFFFFF;
    private static final int CPU_DIAL = 0xFFF4A03C, GPU_DIAL = 0xFF4ADE80;
    private static final int CPU_BAR0 = 0xFF7C5CFF, CPU_BAR1 = 0xFFC084FC, CPU_MEM1 = 0xFFF0ABFC;
    private static final int GPU_BAR0 = 0xFF06B6D4, GPU_BAR1 = 0xFF67E8F9, GPU_MEM1 = 0xFFA5F3FC;
    private static final int CPU_WAVE = 0xFFA78BFA, CPU_FILL = 0x4DA78BFA;
    private static final int GPU_WAVE = 0xFF22D3EE, GPU_FILL = 0x4222D3EE;

    private final Path line = new Path(), area = new Path(), clip = new Path();

    @Override
    public String id() { return "aurora"; }

    private final Critter critter = new Critter(Critter.BLOB, Critter.EARS_NONE,
            Critter.EYE_GLOW, Critter.M_WISP, 0x2EFFFFFF, 0x66FFFFFF, 0x14FFFFFF,
            0xFFA78BFA, 0xFFA78BFA, 0xFFF4A03C, 0xFF00D1B2, false, 0.94f, 0.5f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return LABEL; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.sansMedium; }

    @Override
    protected int clockFill() { return 0xFF171A30; }

    @Override
    protected int clockStroke() { return 0x24FFFFFF; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        // indigo field + two drifting blooms, across the whole viewport
        scratch.reset();
        scratch.setShader(new LinearGradient(0, 0, vw * .34f, vh,
                0xFF0B0D1C, 0xFF0A0A14, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, vw, vh, scratch);
        float d1 = a.reducedMotion ? 0 : (float) Math.sin(a.clock / 18000.0 * 2 * Math.PI) * .03f * vw;
        float d2 = a.reducedMotion ? 0 : (float) Math.sin(a.clock / 24000.0 * 2 * Math.PI + 2) * .03f * vw;
        bloom(c, vw * .12f + d1, 0, vw * .62f, 0x577856FF);
        bloom(c, vw * .92f + d2, vh, vw * .55f, 0x4200D1B2);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float pad = 2.4f * cq, gap = 1.8f * cq;
        float cardH = (h - 2 * pad - gap) / 2;
        drawCard(c, pad, pad, w - 2 * pad, cardH, cq, m.cpu, a.cpuWave, a,
                a.cpuLoad, a.cpuMem, a.cpuTemp, true, f);
        drawCard(c, pad, pad + cardH + gap, w - 2 * pad, cardH, cq, m.gpu, a.gpuWave, a,
                a.gpuLoad, a.gpuMem, a.gpuTemp, false, f);
    }

    private void bloom(Canvas c, float cx, float cy, float r, int color) {
        scratch.reset();
        scratch.setShader(new RadialGradient(cx, cy, r,
                color, color & 0x00FFFFFF, Shader.TileMode.CLAMP));
        c.drawCircle(cx, cy, r, scratch);
    }

    private void drawCard(Canvas c, float x, float y, float w, float cardH, float cq,
                          Model.Unit u, float[] wave, Anim a,
                          float load, float mem, float temp, boolean isCpu, Assets f) {
        float radius = 1.8f * cq;
        RectF card = new RectF(x, y, x + w, y + cardH);

        // frosted body + border + top hairline (with its 3 s highlight sweep)
        scratch.reset();
        scratch.setShader(new LinearGradient(0, y, 0, y + cardH,
                CARD_TOP, CARD_BOT, Shader.TileMode.CLAMP));
        c.drawRoundRect(card, radius, radius, scratch);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        scratch.setColor(BORDER);
        c.drawRoundRect(card, radius, radius, scratch);
        float hx = a.reducedMotion ? x + w * .5f
                : x + ((a.clock % 3000) / 3000f * 1.6f - .3f) * w;
        scratch.reset();
        scratch.setShader(new LinearGradient(hx - w * .25f, 0, hx + w * .25f, 0,
                new int[]{0x00FFFFFF, 0x6BFFFFFF, 0x00FFFFFF}, null, Shader.TileMode.CLAMP));
        c.drawRect(x + radius, y, x + w - radius, y + Math.max(1, cq * .06f), scratch);

        // clip everything below to the rounded card
        int save = c.save();
        clip.reset();
        clip.addRoundRect(card, radius, radius, Path.Direction.CW);
        c.clipPath(clip);

        float padS = 2.2f * cq, padT = 1.6f * cq;
        float stripH = 6 * cq;
        float contentTop = y + padT, contentBot = y + cardH - stripH - cq;
        float dialW = 10.5f * cq;
        float leftW = w - 2 * padS - 2.4f * cq - dialW;

        // head: chip pill · name · spec
        float headY = contentTop + 1.3f * cq;
        Paint chip = text(.78f * cq, f.sansBold, INK, .24f);
        float chipW = chip.measureText(u.tag) + 1.6f * cq;
        RectF pill = new RectF(x + padS, headY - 1.05f * cq, x + padS + chipW, headY + .45f * cq);
        scratch.reset();
        scratch.setColor(0x1AFFFFFF);
        c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .05f));
        scratch.setColor(0x24FFFFFF);
        c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, scratch);
        c.drawText(u.tag, pill.left + .8f * cq, headY, chip);
        Paint name = text(1.25f * cq, f.sansMedium, INK, -.01f);
        c.drawText(u.name, pill.right + .9f * cq, headY, name);
        float nameW = name.measureText(u.name);
        c.drawText(u.spec, pill.right + .9f * cq + nameW + .9f * cq, headY,
                text(.95f * cq, f.sans, SPEC, 0));

        // metrics: LOAD and MEMORY/VRAM, value + gradient pill bar
        float colGap = 2.4f * cq, colW = (leftW - colGap) / 2;
        float mx = x + padS;
        float barBot = contentBot - .2f * cq;
        int bar1 = isCpu ? CPU_BAR1 : GPU_BAR1, mem1 = isCpu ? CPU_MEM1 : GPU_MEM1;
        int bar0 = isCpu ? CPU_BAR0 : GPU_BAR0;
        float enter = easeOut(a.entrance);
        metric(c, mx, barBot, colW, cq, "LOAD", u.loadText, u.loadFrac != null,
                load * enter, bar0, bar1, f);
        metric(c, mx + colW + colGap, barBot, colW, cq, u.memLabel, u.memText,
                u.memFrac != null, mem * enter, bar0, mem1, f);

        // dial — sweep is the entrance animation
        float dcx = x + w - padS - dialW / 2, dcy = (contentTop + contentBot) / 2;
        int dialC = isCpu ? CPU_DIAL : GPU_DIAL;
        float frac = Float.isNaN(temp) ? 0 : temp * enter;
        Draw.dial(c, dcx, dcy, 4.2f * cq, frac, .61f * cq, DIAL_TRACK, dialC, scratch);
        Paint big = text(2.4f * cq, f.sansBold, INK, -.04f);
        String t = u.tempC == null ? "—" : Math.round(u.tempC) + "°";
        c.drawText(t, dcx - big.measureText(t) / 2, dcy + .6f * cq, big);
        Paint small = text(.6f * cq, f.sansBold, LABEL, .2f);
        String st = u.tempC == null ? noteOrDefault(u) : "DIE TEMP";
        c.drawText(st, dcx - small.measureText(st) / 2, dcy + 1.7f * cq, small);

        // full-bleed strip: wave + live tick + captions, clipped in on entrance
        float stripTop = y + cardH - stripH;
        scratch.reset();
        scratch.setColor(0x17FFFFFF);
        c.drawRect(x, stripTop, x + w, stripTop + Math.max(1, cq * .06f), scratch);
        if (wave != null && wave.length >= 2) {
            int save2 = c.save();
            if (a.entrance < 1f) c.clipRect(x, stripTop, x + w * easeOut(a.entrance), y + cardH);
            float min = Float.MAX_VALUE, max = -Float.MAX_VALUE;
            for (float v : wave) { min = Math.min(min, v); max = Math.max(max, v); }
            min -= 14; max += 6;
            RectF box = new RectF(x, stripTop + stripH * .05f, x + w, y + cardH);
            Draw.wave(c, line, area, wave, box, min, max,
                    isCpu ? CPU_WAVE : GPU_WAVE, isCpu ? CPU_FILL : GPU_FILL, cq * .12f, scratch);
            // the now-tick holds the right edge while the plot moves beneath it
            float ly = Draw.y(wave[wave.length - 1], box.top, box.bottom, min, max);
            float pulse = a.reducedMotion ? .7f
                    : .55f + .3f * (.5f + .5f * (float) Math.sin(a.clock / 1500.0 * 2 * Math.PI));
            scratch.reset();
            scratch.setColor(isCpu ? CPU_WAVE : GPU_WAVE);
            scratch.setAlpha((int) (255 * pulse));
            scratch.setStrokeWidth(cq * .1f);
            c.drawLine(x + w - cq * .1f, ly, x + w - cq * .1f, y + cardH, scratch);
            c.restoreToCount(save2);
        }
        // caption in real time: the true series length at the 2 s probe cadence
        int samples = u.tempSeries.length;
        Paint slab = text(.62f * cq, f.sansBold, 0x6BE7E9F5, .26f);
        c.drawText(samples < 2 ? "DIE TEMP · NO HISTORY YET"
                : "DIE TEMP · LAST " + (samples - 1) * 2 + " s", x + padS, y + cardH - .5f * cq, slab);
        Paint slabR = text(.62f * cq, f.sansBold, 0x9EE7E9F5, .26f);
        rightText(c, Model.rangeLabel(toDoubles(wave)), x + w - padS, y + cardH - .5f * cq, slabR);

        c.restoreToCount(save);
    }

    private void metric(Canvas c, float x, float barBot, float colW, float cq,
                        String label, String value, boolean present, float frac,
                        int from, int to, Assets f) {
        RectF bar = new RectF(x, barBot - .5f * cq, x + colW, barBot);
        Draw.pillBar(c, bar, present ? frac : 0, 0x1AFFFFFF, from, to, scratch);
        float valY = bar.top - .9f * cq;
        c.drawText(value, x, valY, text(3.4f * cq, f.sansBold, present ? INK : LABEL, -.035f));
        c.drawText(label, x, valY - 3.4f * cq * .78f - .4f * cq,
                text(.74f * cq, f.sansBold, LABEL, .28f));
    }

    private static String noteOrDefault(Model.Unit u) {
        return u.note.isEmpty() ? "NO SENSOR" : u.note.toUpperCase();
    }

    private static double[] toDoubles(float[] v) {
        if (v == null) return new double[0];
        double[] out = new double[v.length];
        for (int i = 0; i < v.length; i++) out[i] = v[i];
        return out;
    }
}
