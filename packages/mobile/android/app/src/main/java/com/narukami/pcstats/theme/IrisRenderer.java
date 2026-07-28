package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;

/**
 * 15 · Iris — soft lavender dark, 20 rounded capsule segments per meter.
 * Peach is spent only on the CPU die temp row; lavender for CPU, mint for GPU.
 */
class IrisRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFF16131F, CARD = 0xFF1D1929, CARD_BORDER = 0xFF2B2440;
    private static final int UNLIT = 0xFF2B2440, INK = 0xFFEFEAFF, CAPTION = 0xFF8D84AD;
    private static final int LAVENDER = 0xFFB4A5E0, MINT = 0xFF9EDCC0, PEACH = 0xFFE7B98F;

    @Override
    public String id() { return "iris"; }

    private final Critter critter = new Critter(Critter.PENT, Critter.EARS_NONE,
            Critter.EYE_GLOW, Critter.M_CAPS, 0xFF1D1929, 0xFF2B2440, 0xFF241E33,
            0xFFB4A5E0, 0xFFB4A5E0, 0xFFE7B98F, 0xFF9EDCC0, false, 0.94f, 0.5f);

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
    protected android.graphics.Typeface clockFace(Assets f) { return f.sansMedium; }

    @Override
    protected int clockFill() { return 0xFF1D1929; }

    @Override
    protected int clockStroke() { return 0xFF2B2440; }

    @Override
    public boolean ambient() { return false; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(FIELD);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 2.8f * cq, padY = 2.4f * cq, gap = 1.6f * cq;
        float unitH = (h - 2 * padY - gap) / 2;
        drawUnit(c, padX, padY, w - 2 * padX, unitH, cq, m.cpu, a.cpuLoad, a.cpuMem, a.cpuTemp,
                a, true, f);
        drawUnit(c, padX, padY + unitH + gap, w - 2 * padX, unitH, cq, m.gpu, a.gpuLoad,
                a.gpuMem, a.gpuTemp, a, false, f);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, float load, float mem, float temp, Anim a,
                          boolean isCpu, Assets f) {
        RectF card = new RectF(x, y, x + w, y + unitH);
        scratch.reset();
        scratch.setColor(CARD);
        c.drawRoundRect(card, 1.4f * cq, 1.4f * cq, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        scratch.setColor(CARD_BORDER);
        c.drawRoundRect(card, 1.4f * cq, 1.4f * cq, scratch);

        float px = x + 2 * cq, midY = card.centerY();
        c.drawText(u.tag, px, midY - 1.5f * cq, text(.7f * cq, f.sansMedium, CAPTION, .34f));
        c.drawText(u.name, px, midY, text(1.35f * cq, f.sansMedium, INK, 0));
        c.drawText(u.spec, px, midY + 1.3f * cq, text(.76f * cq, f.sans, CAPTION, 0));

        int hue = isCpu ? LAVENDER : MINT;
        float rx = px + 18 * cq + 2.2f * cq;
        float rw = card.right - 2 * cq - rx;
        float rowGap = unitH / 4;
        float enter = easeOut(a.entrance);
        row(c, rx, y + rowGap, rw, cq, "LOAD", u.loadText, u.loadFrac != null,
                load * enter, hue, false, f);
        row(c, rx, y + 2 * rowGap, rw, cq, u.memLabel, u.memText, u.memFrac != null,
                mem * enter, hue, false, f);
        boolean hotRow = isCpu && u.tempFrac != null;
        row(c, rx, y + 3 * rowGap, rw, cq, "DIE TEMP", u.tempText, u.tempFrac != null,
                Float.isNaN(temp) ? 0 : temp * enter, hotRow ? PEACH : hue, hotRow, f);
    }

    private void row(Canvas c, float x, float y, float rw, float cq, String key, String value,
                     boolean present, float frac, int hue, boolean hiValue, Assets f) {
        c.drawText(key, x, y + .3f * cq, text(.7f * cq, f.sansMedium, CAPTION, .24f));
        float capsX = x + 6.5f * cq + 1.2f * cq;
        float capsW = rw - 6.5f * cq - 9 * cq - 2.4f * cq;
        int lit = present ? Model.litCells(20, (double) Math.min(1, frac)) : 0;
        float gap = .3f * cq, cell = (capsW - 19 * gap) / 20;
        scratch.reset();
        for (int i = 0; i < 20; i++) {
            scratch.setColor(i < lit ? hue : UNLIT);
            float cx = capsX + i * (cell + gap);
            c.drawRoundRect(cx, y - .5f * cq, cx + cell, y + .5f * cq, cell / 2, cell / 2, scratch);
        }
        rightText(c, value, x + rw, y + .4f * cq,
                text(1.25f * cq, f.sansMedium, !present ? CAPTION : hiValue ? PEACH : INK, 0));
    }
}
