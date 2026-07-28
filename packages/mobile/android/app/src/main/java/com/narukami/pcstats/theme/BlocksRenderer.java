package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;

/**
 * 07 · Blocks — flat panels, hard edges, offset shadows, no gradients. The
 * colour blocking carries the temperature judgement: a hot die's box goes
 * orange, a cool one blue.
 */
class BlocksRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFFCFE0FF, INKB = 0xFF0B0B0B, WHITE = 0xFFFFFFFF;
    private static final int NAME_BG = 0xFFFFD23F, HOT = 0xFFFF5C39, COOL = 0xFF2B5CFF;

    @Override
    public String id() { return "blocks"; }

    private final Critter critter = new Critter(Critter.BOX, Critter.EARS_NONE,
            Critter.EYE_DOT, Critter.M_NONE, 0xFFFFFFFF, 0xFF0B0B0B, 0xFFFFD23F,
            0xFF0B0B0B, 0xFF0B0B0B, 0xFFFF5C39, 0xFF2B5CFF, true, 0.5f, 0.5f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return INKB; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.sansBold; }

    @Override
    protected int clockFill() { return 0xFFFFFFFF; }

    @Override
    protected int clockStroke() { return 0xFF0B0B0B; }

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
        float pad = 2.2f * cq, gap = 1.8f * cq;
        float unitH = (h - 2 * pad - gap) / 2;
        drawUnit(c, pad, pad, w - 2 * pad, unitH, cq, m.cpu, a.cpuLoad, a.cpuMem, a, f);
        drawUnit(c, pad, pad + unitH + gap, w - 2 * pad, unitH, cq, m.gpu, a.gpuLoad, a.gpuMem, a, f);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, float load, float mem, Anim a, Assets f) {
        float gap = 1.6f * cq;
        float nameW = 20 * cq, valW = (w - 2 * nameW - 3 * gap) / 2;
        float enter = easeOut(a.entrance);
        // drop-in entrance: boxes rise from a slight offset
        float dy = (1 - enter) * .6f * cq;

        RectF box = new RectF(x, y + dy, x + nameW, y + unitH + dy);
        drawBox(c, box, cq, NAME_BG, INKB);
        c.drawText(u.tag, box.left + 1.4f * cq, box.top + 2 * cq,
                text(.78f * cq, f.sansBold, INKB, .3f));
        Paint nm = text(1.9f * cq, f.condensedBold, INKB, .01f);
        String[] parts = BlueprintRenderer.splitName(u.name.toUpperCase());
        c.drawText(parts[0], box.left + 1.4f * cq, box.bottom - 3.4f * cq, nm);
        if (!parts[1].isEmpty()) c.drawText(parts[1], box.left + 1.4f * cq, box.bottom - 1.7f * cq, nm);
        c.drawText(u.spec, box.left + 1.4f * cq, box.bottom - .6f * cq,
                text(.8f * cq, f.sansMedium, INKB, .12f));

        box = new RectF(x + nameW + gap, y + dy, x + nameW + gap + valW, y + unitH + dy);
        metric(c, box, cq, "LOAD", u.loadText, u.loadFrac != null, load * enter, WHITE, INKB, f);
        box.offset(valW + gap, 0);
        metric(c, box, cq, u.memLabel, u.memText, u.memFrac != null, mem * enter, WHITE, INKB, f);

        // temp box: colour IS the judgement
        boolean hot = u.tempFrac != null && u.tempFrac >= .6;
        box = new RectF(x + w - nameW, y + dy, x + w, y + unitH + dy);
        drawBox(c, box, cq, u.tempFrac == null ? WHITE : hot ? HOT : COOL, INKB);
        int ink = u.tempFrac == null ? INKB : WHITE;
        c.drawText("DIE TEMP", box.left + 1.4f * cq, box.top + 2 * cq,
                text(.78f * cq, f.sansBold, ink, .3f));
        Paint v = text(4.2f * cq, f.condensedBold, ink, .01f);
        String n = u.tempC == null ? "—" : String.valueOf(Math.round(u.tempC));
        c.drawText(n, box.left + 1.4f * cq, box.bottom - 2 * cq, v);
        c.drawText("°C", box.left + 1.4f * cq + v.measureText(n) + .3f * cq, box.bottom - 2 * cq,
                text(1.4f * cq, f.condensedBold, ink, .04f));
        c.drawText(noteFor(u), box.left + 1.4f * cq, box.bottom - .7f * cq,
                text(.8f * cq, f.sansBold, ink, .14f));
    }

    private void metric(Canvas c, RectF box, float cq, String label, String value,
                        boolean present, float frac, int bg, int ink, Assets f) {
        drawBox(c, box, cq, bg, ink);
        c.drawText(label.toUpperCase(), box.left + 1.4f * cq, box.top + 2 * cq,
                text(.78f * cq, f.sansBold, ink, .3f));
        String bigPart = value.contains("/") ? value.substring(0, value.indexOf('/')) : value;
        String small = value.substring(bigPart.length());
        Paint v = text(4.2f * cq, f.condensedBold, present ? ink : 0xFF9AA6BC, .01f);
        c.drawText(bigPart, box.left + 1.4f * cq, box.bottom - 2.4f * cq, v);
        c.drawText(small, box.left + 1.4f * cq + v.measureText(bigPart) + .2f * cq,
                box.bottom - 2.4f * cq, text(1.4f * cq, f.condensedBold, ink, .04f));
        // solid black bar in a bordered track — chunky steps, no interpolation
        RectF track = new RectF(box.left + 1.4f * cq, box.bottom - 1.9f * cq,
                box.right - 1.4f * cq, box.bottom - .8f * cq);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .2f);
        scratch.setColor(ink);
        c.drawRect(track, scratch);
        if (present && frac > 0) {
            float stepped = Math.round(Math.min(1, frac) * 8) / 8f;   // steps(8)
            scratch.reset();
            scratch.setColor(ink);
            c.drawRect(track.left + cq * .1f, track.top + cq * .1f,
                    track.left + cq * .1f + (track.width() - cq * .2f) * stepped,
                    track.bottom - cq * .1f, scratch);
        }
    }

    private void drawBox(Canvas c, RectF box, float cq, int bg, int ink) {
        scratch.reset();
        scratch.setColor(ink);
        c.drawRect(box.left + .55f * cq, box.top + .55f * cq,
                box.right + .55f * cq, box.bottom + .55f * cq, scratch);  // hard offset shadow
        scratch.setColor(bg);
        c.drawRect(box, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .28f);
        scratch.setColor(ink);
        c.drawRect(box, scratch);
    }

    private static String noteFor(Model.Unit u) {
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        if (head != null) return head + "°C TO Tj MAX";
        return u.note.toUpperCase();
    }
}
