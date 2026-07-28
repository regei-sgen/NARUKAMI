package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;

/**
 * 10 · Chrono — quiet dark dial. A 240° hairline arc with a 15-tick ring and a
 * dot travelling at the arc's tip; serif numerals against sans labels; gold for
 * the CPU, muted green for the GPU. Deliberately the slowest mover here.
 */
class ChronoRenderer extends ThemeRenderer {

    private static final int CASE_BG = 0xFF131316, DIAL_INK = 0xFFEFE9DD;
    private static final int GOLD = 0xFFC8A45C, COOL = 0xFF8FB8A8, CAPTION = 0xFF8E887C;

    @Override
    public String id() { return "chrono"; }

    private final Critter critter = new Critter(Critter.ROUND, Critter.EARS_NONE,
            Critter.EYE_DOT, Critter.M_CROWN, 0xFF1B1B1F, 0xFFC8A45C, 0xFF232327,
            0xFFC8A45C, 0xFFC8A45C, 0xFFDD8888, 0xFFC8A45C, false, 0.6f, 0.94f);

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
    protected android.graphics.Typeface clockFace(Assets f) { return f.sans; }

    @Override
    protected int clockFill() { return 0xFF1B1B1F; }

    @Override
    protected int clockStroke() { return 0x59C8A45C; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(CASE_BG);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 4 * cq, padY = 3 * cq;

        // head: serif title, gold subtitle, hairline with the 6 s gold sweep
        float headY = padY + 1.7f * cq;
        Paint t = text(1.9f * cq, f.serif, DIAL_INK, .01f);
        c.drawText("Thermals", padX, headY, t);
        c.drawText("TWO DIES, ONE BENCH", padX + t.measureText("Thermals") + 1.4f * cq, headY,
                text(.78f * cq, f.sansMedium, GOLD, .36f));
        rightText(c, "RANGE 30–100 °C", w - padX, headY, text(.75f * cq, f.sans, CAPTION, .26f));
        float sweep = a.reducedMotion ? .5f : (a.clock % 6000) / 6000f;
        scratch.reset();
        scratch.setColor(0x52C8A45C);
        c.drawRect(padX, headY + cq, w - padX, headY + cq + Math.max(1, cq * .05f), scratch);
        scratch.setColor(0x33FFFFFF);
        float hx = padX + (w - 2 * padX) * sweep;
        c.drawRect(Math.max(padX, hx - 6 * cq), headY + cq, Math.min(w - padX, hx + 6 * cq),
                headY + cq + Math.max(1, cq * .05f), scratch);

        float top = headY + cq + 2.2f * cq;
        float colW = (w - 2 * padX - 4 * cq) / 2;
        float midY = top + (h - top - padY) / 2;
        unit(c, padX, midY, colW, cq, m.cpu, a.cpuTemp, GOLD, true, a, f);
        // fading gold divider
        scratch.reset();
        scratch.setColor(0x59C8A45C);
        c.drawRect(padX + colW + 2 * cq, midY - 7 * cq, padX + colW + 2 * cq + Math.max(1, cq * .05f),
                midY + 7 * cq, scratch);
        unit(c, padX + colW + 4 * cq, midY, colW, cq, m.gpu, a.gpuTemp, COOL, false, a, f);
    }

    private void unit(Canvas c, float x, float midY, float colW, float cq, Model.Unit u,
                      float temp, int tone, boolean isCpu, Anim a, Assets f) {
        // dial: 240° hairline arc, tick ring, travelling dot — 1.1 s ease
        float r = 6 * cq, cx = x + 7 * cq, cy = midY;
        final float A0 = 150, SPAN = 240;
        RectF oval = new RectF(cx - r, cy - r, cx + r, cy + r);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        scratch.setColor(0x24EFE9DD);
        c.drawArc(oval, A0, SPAN, false, scratch);
        scratch.setColor(0x80C8A45C);
        for (int i = 0; i <= 14; i++) {
            double ang = Math.toRadians(A0 + SPAN * i / 14);
            float o = (i % 7 == 0) ? cq * .7f : cq * .35f;
            c.drawLine(cx + (float) Math.cos(ang) * (r - cq * .3f),
                    cy + (float) Math.sin(ang) * (r - cq * .3f),
                    cx + (float) Math.cos(ang) * (r - cq * .3f - o),
                    cy + (float) Math.sin(ang) * (r - cq * .3f - o), scratch);
        }
        if (!Float.isNaN(temp)) {
            float frac = Model.clamp01(temp) * easeOut(a.entrance) == 0 ? 0
                    : (float) Model.clamp01(temp) * easeOut(a.entrance);
            scratch.setStrokeWidth(cq * .22f);
            scratch.setStrokeCap(Paint.Cap.ROUND);
            scratch.setColor(tone);
            c.drawArc(oval, A0, SPAN * frac, false, scratch);
            double tip = Math.toRadians(A0 + SPAN * frac);
            scratch.setStyle(Paint.Style.FILL);
            c.drawCircle(cx + (float) Math.cos(tip) * r, cy + (float) Math.sin(tip) * r, cq * .26f, scratch);
        }
        Paint n = text(3.4f * cq, f.serif, u.tempC == null ? CAPTION : DIAL_INK, 0);
        String tv = u.tempC == null ? "—" : Math.round(u.tempC) + "°";
        c.drawText(tv, cx - n.measureText(tv) / 2, cy + 1.1f * cq, n);
        Paint k = text(.62f * cq, f.sans, CAPTION, .34f);
        c.drawText("DIE TEMP", cx - k.measureText("DIE TEMP") / 2, cy + 2.4f * cq, k);

        // list: serif name + hairline key/value rows
        float lx = cx + r + 2.4f * cq;
        float lw = x + colW - lx;
        c.drawText(u.name, lx, midY - 4.6f * cq, text(1.5f * cq, f.serif, DIAL_INK, 0));
        c.drawText(u.spec.toUpperCase(), lx, midY - 3.4f * cq, text(.72f * cq, f.sans, CAPTION, .2f));
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        String thirdK = isCpu ? "HEADROOM" : "POWER";
        String thirdV = isCpu ? (head == null ? "—" : head + " °C")
                : u.powerW == null ? "—" : String.format(java.util.Locale.US, "%.1f W", u.powerW);
        String[][] rows = {{"LOAD", u.loadText}, {u.memLabel, u.memText.replace("/", " / ")},
                {thirdK, thirdV}};
        float ry = midY - 1.6f * cq;
        for (String[] row : rows) {
            scratch.reset();
            scratch.setColor(0x1FEFE9DD);
            c.drawRect(lx, ry - 1.2f * cq, lx + lw, ry - 1.2f * cq + Math.max(1, cq * .05f), scratch);
            c.drawText(row[0], lx, ry, text(.7f * cq, f.sans, CAPTION, .3f));
            rightText(c, row[1], lx + lw, ry, text(1.4f * cq, f.sansMedium, DIAL_INK, -.01f));
            ry += 2.5f * cq;
        }
    }
}
