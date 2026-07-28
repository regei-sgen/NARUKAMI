package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;

/**
 * 02 · Blueprint — engineering instrument sheet, light. Cool paper with a blue
 * grid, hatched thermal tracks on a REAL 30–100 °C scale, and a solid Tj max
 * tick the fill runs toward. Bar widths use the scale fraction, never the raw
 * temperature, so the printed captions stay honest.
 */
class BlueprintRenderer extends ThemeRenderer {

    private static final int PAPER = 0xFFECEEF1, INK = 0xFF111820;
    private static final int BLUE = 0xFF1F4FD8, HOT = 0xFFA4350A, HOT2 = 0xFFE05A1F;
    private static final int NOTE = 0xFF5B6472, GRID = 0x121F4FD8;

    @Override
    public String id() { return "blueprint"; }

    private final Critter critter = new Critter(Critter.BOX, Critter.ANTENNA,
            Critter.EYE_DOT, Critter.M_RULER, 0xFFFFFFFF, 0xFF111820, 0xFFECEEF1,
            0xFF1F4FD8, 0xFF1F4FD8, 0xFFA4350A, 0xFF1F4FD8, false, 0.94f, 0.52f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return NOTE; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.mono; }

    @Override
    protected int clockFill() { return 0xFFFFFFFF; }

    @Override
    protected int clockStroke() { return 0xFF111820; }

    @Override
    protected float clockRadius(float chipH) { return 0; }

    @Override
    public boolean ambient() { return false; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(PAPER);
        scratch.reset();
        scratch.setColor(GRID);
        scratch.setStrokeWidth(1.5f);
        float step = vw / 50f;
        for (float x = 0; x < vw; x += step) c.drawLine(x, 0, x, vh, scratch);
        for (float y = 0; y < vh; y += step) c.drawLine(0, y, vw, y, scratch);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 3 * cq, padY = 2.4f * cq, gap = 1.6f * cq;

        // title rule
        float headY = padY + 1.3f * cq;
        c.drawText("Thermal & load readout", padX, headY, text(1.5f * cq, f.sansBold, INK, -.01f));
        rightText(c, "SAMPLED CONTINUOUSLY · °C", w - padX, headY, text(.85f * cq, f.mono, NOTE, .2f));
        scratch.reset();
        scratch.setColor(INK);
        c.drawRect(padX, headY + .9f * cq, w - padX, headY + .9f * cq + Math.max(1, cq * .07f), scratch);

        float top = headY + .9f * cq + gap;
        float unitH = (h - top - padY - gap) / 2;
        drawUnit(c, padX, top, w - 2 * padX, unitH, cq, m.cpu, a.cpuLoad, a.cpuMem, a, true, f);
        scratch.reset();
        scratch.setColor(0x2E111820);
        c.drawRect(padX, top + unitH + gap / 2, w - padX, top + unitH + gap / 2 + Math.max(1, cq * .05f), scratch);
        drawUnit(c, padX, top + unitH + gap, w - 2 * padX, unitH, cq, m.gpu, a.gpuLoad, a.gpuMem, a, false, f);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, float load, float mem, Anim a, boolean isCpu, Assets f) {
        float midY = y + unitH / 2;
        // identity, 13cq
        c.drawText(u.tag, x, midY - 1.6f * cq, text(.8f * cq, f.mono, BLUE, .34f));
        Paint name = text(1.35f * cq, f.sansBold, INK, 0);
        String[] parts = splitName(u.name);
        c.drawText(parts[0], x, midY - .1f * cq, name);
        if (!parts[1].isEmpty()) c.drawText(parts[1], x, midY + 1.3f * cq, name);
        c.drawText(u.spec, x, midY + 2.6f * cq, text(.8f * cq, f.mono, NOTE, .04f));

        // three metric columns
        float cx = x + 13 * cq + 2 * cq;
        float cw = x + w - cx;
        float colGap = 2.2f * cq, colW = (cw - 2 * colGap) / 3.15f;
        float enter = easeOut(a.entrance);
        scale(c, cx, midY, colW, cq, "LOAD", u.loadText, u.loadFrac != null,
                load * enter, "0", "50", "100", f);
        String memMid = u.memText.contains("/") ? u.memText.replaceAll("^.*/|G$", "") : "";
        String memTop = memMid.isEmpty() ? "" : String.valueOf(Math.round(Double.parseDouble(memMid) / 2));
        scale(c, cx + colW + colGap, midY, colW, cq, u.memLabel, u.memText, u.memFrac != null,
                mem * enter, "0", memTop, memMid, f);
        therm(c, cx + 2 * (colW + colGap), midY, colW * 1.15f, cq, u,
                isCpu ? a.cpuTemp : a.gpuTemp, enter, f);
    }

    private void scale(Canvas c, float x, float midY, float colW, float cq, String label,
                       String value, boolean present, float frac,
                       String lo, String mid, String hi, Assets f) {
        c.drawText(label, x, midY - 2.1f * cq, text(.75f * cq, f.mono, NOTE, .32f));
        c.drawText(value, x, midY + 1.1f * cq, text(3.2f * cq, f.sansMedium, present ? INK : NOTE, -.03f));
        RectF track = new RectF(x, midY + 1.9f * cq, x + colW, midY + 3.4f * cq);
        scratch.reset();
        scratch.setColor(INK);
        float hair = Math.max(1, cq * .06f);
        c.drawRect(track.left, track.top, track.left + hair, track.bottom, scratch);
        c.drawRect(track.right - hair, track.top, track.right, track.bottom, scratch);
        scratch.setColor(0x47111820);
        c.drawRect(track.left, track.centerY(), track.right, track.centerY() + hair, scratch);
        if (present && frac > 0) {
            scratch.setColor(BLUE);
            c.drawRect(track.left, track.top + .12f * cq, track.left + colW * Math.min(1, frac),
                    track.top + .74f * cq, scratch);
        }
        Paint cap = text(.62f * cq, f.mono, NOTE, 0);
        c.drawText(lo, track.left, track.bottom + .8f * cq, cap);
        c.drawText(mid, track.centerX() - cap.measureText(mid) / 2, track.bottom + .8f * cq, cap);
        rightText(c, hi, track.right, track.bottom + .8f * cq, cap);
    }

    private void therm(Canvas c, float x, float midY, float colW, float cq, Model.Unit u,
                       float tempFrac, float enter, Assets f) {
        boolean hot = u.tempC != null && u.tempFrac != null && u.tempFrac >= .6;
        // read row: big number, unit, note
        String n = u.tempC == null ? "—" : String.valueOf(Math.round(u.tempC));
        Paint big = text(3.2f * cq, f.sansMedium, u.tempC == null ? NOTE : INK, -.03f);
        c.drawText(n, x, midY - .4f * cq, big);
        c.drawText("°C die", x + big.measureText(n) + .6f * cq, midY - .4f * cq,
                text(1.1f * cq, f.sansMedium, NOTE, 0));
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        String note;
        if (u.tempC == null) {
            note = noteUp(u);
        } else if (head != null) {
            note = head + "° TO Tj MAX";
        } else if (u.fanPct != null) {
            note = Math.round(u.fanPct) == 0 ? "FAN IDLE" : "FAN " + Math.round(u.fanPct) + "%";
        } else {
            note = "WITHIN RANGE";
        }
        rightText(c, note, x + colW, midY - .4f * cq,
                text(.72f * cq, f.mono, hot ? HOT : BLUE, .14f));

        // hatched track on the 30–100 scale
        RectF track = new RectF(x, midY + .3f * cq, x + colW, midY + 2.7f * cq);
        scratch.reset();
        scratch.setColor(0xFFFFFFFF);
        c.drawRect(track, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .07f));
        scratch.setColor(INK);
        c.drawRect(track, scratch);
        if (!Float.isNaN(tempFrac) && tempFrac > 0) {
            float fillR = track.left + (track.width() - cq * .1f) * Math.min(1, tempFrac * enter);
            int save = c.save();
            c.clipRect(track.left + 1, track.top + 1, fillR, track.bottom - 1);
            scratch.reset();
            scratch.setStrokeWidth(cq * .32f);
            for (float hx = track.left - track.height(); hx < fillR + track.height(); hx += cq * .64f) {
                scratch.setColor(hot ? HOT : BLUE);
                c.drawLine(hx, track.bottom + 2, hx + track.height(), track.top - 2, scratch);
                scratch.setColor(hot ? HOT2 : 0xFF3F68E0);
                c.drawLine(hx + cq * .32f, track.bottom + 2, hx + cq * .32f + track.height(),
                        track.top - 2, scratch);
            }
            c.restoreToCount(save);
        }
        // the Tj max tick at the scale's end
        scratch.reset();
        scratch.setColor(INK);
        c.drawRect(track.right - cq * .07f, track.top - .75f * cq, track.right, track.bottom + .75f * cq, scratch);

        Paint cap = text(.68f * cq, f.mono, NOTE, .08f);
        float capY = track.bottom + 1.3f * cq;
        c.drawText("30", track.left, capY, cap);
        c.drawText("65", track.centerX() - cap.measureText("65") / 2, capY, cap);
        rightText(c, u.tjMaxC != null ? "Tj MAX " + u.tjMaxC : "100", track.right, capY, cap);
    }

    private static String noteUp(Model.Unit u) {
        String s = u.note.toUpperCase();
        return s.length() > 22 ? s.substring(0, 22) : s;
    }

    /** Split a part name onto two lines like the reference's ID block. */
    static String[] splitName(String name) {
        int cut = name.lastIndexOf(' ');
        if (name.length() < 14 || cut <= 0) return new String[]{name, ""};
        return new String[]{name.substring(0, cut), name.substring(cut + 1)};
    }
}
