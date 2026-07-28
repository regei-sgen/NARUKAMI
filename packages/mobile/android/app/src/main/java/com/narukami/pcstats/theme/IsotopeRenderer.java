package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;

import java.util.Locale;

/**
 * 08 · Isotope — Swiss data sheet. Six hairline columns, two bands split by a
 * rule, 22-tick columns, and red spent exactly once: on the CPU die temp.
 * No motion — information design earns its authority by not moving.
 */
class IsotopeRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFFE9E7E2, INK = 0xFF111111;
    private static final int RED = 0xFFD7263D, CAPTION = 0xFF5C5952;
    private static final int TICK_DIM = 0x29111111, HAIR = 0x38111111;

    @Override
    public String id() { return "isotope"; }

    private final Critter critter = new Critter(Critter.PENT, Critter.EARS_NONE,
            Critter.EYE_DOT, Critter.M_TICKS, 0xFFE9E7E2, 0xFF111111, 0xFFDDDAD2,
            0xFF111111, 0xFF111111, 0xFFD7263D, 0xFFD7263D, false, 0.5f, 0.53f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return CAPTION; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.mono; }

    @Override
    protected int clockFill() { return 0xFFE9E7E2; }

    @Override
    protected int clockStroke() { return 0xFF111111; }

    @Override
    protected float clockRadius(float chipH) { return 0; }

    @Override
    public boolean ambient() { return false; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(FIELD);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 3 * cq, padY = 2.4f * cq;

        float headY = padY + 2 * cq;
        c.drawText("LOAD & THERMALS", padX, headY, text(2.4f * cq, f.condensedBold, INK, -.01f));
        rightText(c, "DIE TEMP RANGE 30–100 °C · Tj MAX " + (m.cpu.tjMaxC == null ? 100 : m.cpu.tjMaxC),
                w - padX, headY, text(.75f * cq, f.mono, CAPTION, .24f));
        scratch.reset();
        scratch.setColor(INK);
        c.drawRect(padX, headY + .7f * cq, w - padX, headY + .7f * cq + .16f * cq, scratch);

        float top = headY + .7f * cq + 1.6f * cq;
        float bandH = (h - top - padY - 2.4f * cq) / 2;
        float enter = easeOut(a.entrance);
        band(c, padX, top, w - 2 * padX, bandH, cq, m.cpu, a.cpuLoad, a.cpuMem, a.cpuTemp, enter, true, f);
        scratch.reset();
        scratch.setColor(INK);
        float ruleY = top + bandH + 1.2f * cq;
        c.drawRect(padX, ruleY, w - padX, ruleY + .16f * cq, scratch);
        band(c, padX, ruleY + 1.2f * cq, w - 2 * padX, bandH, cq, m.gpu, a.gpuLoad, a.gpuMem, a.gpuTemp, enter, false, f);
    }

    private void band(Canvas c, float x, float y, float w, float bandH, float cq, Model.Unit u,
                      float load, float mem, float temp, float enter, boolean isCpu, Assets f) {
        float colW = w / 6f;
        String[] id = idLines(u);
        // column 0: identity caption
        c.drawText(u.tag, x, y + .9f * cq, text(.68f * cq, f.mono, CAPTION, .28f));
        Paint cap = text(.72f * cq, f.mono, CAPTION, .06f);
        for (int i = 0; i < id.length; i++) {
            c.drawText(id[i], x, y + 2.2f * cq + i * 1.1f * cq, cap);
        }

        boolean tempPresent = u.tempFrac != null;
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        String w1, w1s;
        if (isCpu) {
            w1 = head == null ? "—" : String.valueOf(head);
            w1s = "DEGREES C";
        } else {
            w1 = u.powerW == null ? "—" : String.format(Locale.US, "%.1f", u.powerW);
            w1s = "WATTS";
        }
        String clock = u.clockMHz == null ? "—"
                : isCpu ? String.format(Locale.US, "%.2f", u.clockMHz / 1000) : String.valueOf(Math.round(u.clockMHz));

        col(c, x + colW, y, colW, cq, "LOAD", num(u.loadText), "PERCENT",
                u.loadFrac != null, load * enter, false, null, f);
        col(c, x + 2 * colW, y, colW, cq, u.memLabel, num(u.memText),
                "OF " + total(u.memText) + " GB", u.memFrac != null, mem * enter, false, null, f);
        col(c, x + 3 * colW, y, colW, cq, "DIE TEMP",
                u.tempC == null ? "—" : String.valueOf(Math.round(u.tempC)), "DEGREES C",
                tempPresent, Float.isNaN(temp) ? 0 : temp * enter, isCpu && tempPresent, null, f);
        col(c, x + 4 * colW, y, colW, cq, isCpu ? "HEADROOM" : "POWER", w1, w1s, true, -1,
                false, isCpu ? "Measured against\nTj max " + (u.tjMaxC == null ? 100 : u.tjMaxC) + " °C"
                        : fanCaption(u), f);
        col(c, x + 5 * colW, y, colW, cq, "CLOCK", clock,
                isCpu ? "GIGAHERTZ" : "MEGAHERTZ", true, -1, false,
                isCpu ? "Base, all cores" : "Core, current", f);
    }

    private void col(Canvas c, float x, float y, float colW, float cq, String key, String n,
                     String small, boolean present, float tickFrac, boolean red,
                     String caption, Assets f) {
        scratch.reset();
        scratch.setColor(HAIR);
        c.drawRect(x - .6f * cq, y, x - .6f * cq + Math.max(1, cq * .04f), y + 11 * cq, scratch);
        c.drawText(key, x + .6f * cq, y + .9f * cq, text(.68f * cq, f.mono, CAPTION, .28f));
        int ink = !present ? CAPTION : red ? RED : INK;
        c.drawText(n, x + .6f * cq, y + 5.4f * cq, text(4.4f * cq, f.condensedBold, ink, -.03f));
        c.drawText(small, x + .6f * cq, y + 6.5f * cq, text(.72f * cq, f.condensedBold, CAPTION, .1f));
        if (tickFrac >= 0) {
            // 22 ticks, lit full-height, unlit 26 %
            int lit = present ? Model.litCells(22, (double) tickFrac) : 0;
            float tx = x + .6f * cq, tw = colW - 1.8f * cq;
            float cell = (tw - 21 * .16f * cq) / 22, bot = y + 11 * cq, tallH = 3.4f * cq;
            scratch.reset();
            for (int i = 0; i < 22; i++) {
                boolean on = i < lit;
                scratch.setColor(on ? (red ? RED : INK) : TICK_DIM);
                float hgt = on ? tallH : tallH * .26f;
                c.drawRect(tx + i * (cell + .16f * cq), bot - hgt, tx + i * (cell + .16f * cq) + cell, bot, scratch);
            }
        } else if (caption != null) {
            Paint cap = text(.62f * cq, f.mono, CAPTION, .06f);
            String[] lines = caption.split("\n");
            for (int i = 0; i < lines.length; i++) {
                c.drawText(lines[i], x + .6f * cq, y + 8.2f * cq + i * cq, cap);
            }
        }
    }

    private static String num(String v) {
        int cut = v.indexOf('/');
        if (cut > 0) return v.substring(0, cut);
        return v.endsWith("%") ? v.substring(0, v.length() - 1) : v;
    }

    private static String total(String memText) {
        int cut = memText.indexOf('/');
        return cut > 0 ? memText.substring(cut + 1).replace("G", "") : "—";
    }

    private static String fanCaption(Model.Unit u) {
        if (u.fanPct == null) return "Fan unreported";
        return Math.round(u.fanPct) == 0 ? "Fan idle" : "Fan " + Math.round(u.fanPct) + "%";
    }

    private static String[] idLines(Model.Unit u) {
        String[] name = BlueprintRenderer.splitName(u.name);
        String[] spec = u.spec.split(" · ");
        String[] out = new String[Math.min(4, 2 + spec.length)];
        out[0] = name[0];
        out[1] = name[1].isEmpty() ? (spec.length > 0 ? spec[0] : "") : name[1];
        int idx = name[1].isEmpty() ? 1 : 0;
        for (int i = 2; i < out.length; i++, idx++) {
            out[i] = idx < spec.length ? spec[idx] : "";
        }
        return out;
    }
}
