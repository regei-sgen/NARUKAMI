package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;

/**
 * 11 · Cute — the chips as characters. Facial expression is data: past 65 % of
 * the temp scale a die gets open worried eyes, a sweat drop, and "getting
 * toasty"; below it, closed happy eyes and "nice and cool". The cool die must
 * never sweat.
 */
class CuteRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFFFFF4F8, INK = 0xFF4A3F55, FACE = 0xFFFFFDFA;
    private static final int CPU_BG = 0xFFFFE1EC, GPU_BG = 0xFFD8F4E6;
    private static final int CPU_BLUSH = 0xFFFF9DB8, GPU_BLUSH = 0xFF8FD9B0;
    private static final int DROP = 0xFF7FC7FF, WARM_TAG = 0xFFFFCF8B, COOL_TAG = 0xFFA9E8C6;
    private static final int CPU_PILL = 0xFFFF8FB1, CPU_MEM = 0xFFFFB56B;
    private static final int GPU_PILL = 0xFF5ECF9B, GPU_MEM = 0xFF7FC7FF;

    private final Path path = new Path();

    @Override
    public String id() { return "cute"; }

    private final Critter critter = new Critter(Critter.ROUND, Critter.TUFT,
            Critter.EYE_DOT, Critter.M_BLUSH, 0xFFFFFDFA, 0xFF4A3F55, 0xFFFFE1EC,
            0xFF4A3F55, 0xFF4A3F55, 0xFF4A3F55, 0xFFFF9DB8, true, 0.5f, 0.5f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return 0xA64A3F55; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.sansMedium; }

    @Override
    protected int clockFill() { return 0xFFFFFDFA; }

    @Override
    protected int clockStroke() { return 0xFF4A3F55; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(FIELD);
        scratch.reset();                       // polka-dot paper
        scratch.setColor(0x174A3F55);
        float step = vw * .018f;
        for (float y = step / 2; y < vh; y += step) {
            for (float x = step / 2; x < vw; x += step) {
                c.drawCircle(x, y, vw * .0018f, scratch);
            }
        }
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 2.6f * cq, padY = 2.2f * cq, gap = 1.6f * cq;
        float unitH = (h - 2 * padY - gap) / 2;
        card(c, padX, padY, w - 2 * padX, unitH, cq, m.cpu, a.cpuLoad, a.cpuMem, a, true, f);
        card(c, padX, padY + unitH + gap, w - 2 * padX, unitH, cq, m.gpu, a.gpuLoad, a.gpuMem, a, false, f);
    }

    private void card(Canvas c, float x, float y, float w, float unitH, float cq,
                      Model.Unit u, float load, float mem, Anim a, boolean isCpu, Assets f) {
        RectF card = new RectF(x, y, x + w, y + unitH);
        scratch.reset();
        scratch.setColor(INK);
        RectF sh = new RectF(card);
        sh.offset(0, .55f * cq);
        c.drawRoundRect(sh, 2.2f * cq, 2.2f * cq, scratch);
        scratch.setColor(isCpu ? CPU_BG : GPU_BG);
        c.drawRoundRect(card, 2.2f * cq, 2.2f * cq, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .24f);
        scratch.setColor(INK);
        c.drawRoundRect(card, 2.2f * cq, 2.2f * cq, scratch);

        boolean toasty = u.tempFrac != null && u.tempFrac >= .65f;
        float midY = card.centerY();

        face(c, x + 2 * cq, midY - 4.75f * cq, 9.5f * cq, cq, isCpu, toasty, a);

        // name + two stat pills
        float sx = x + 2 * cq + 9.5f * cq + 2.2f * cq;
        float sw = card.right - 17 * cq - 2.2f * cq - sx;
        c.drawText(u.name, sx, midY - 2.4f * cq, text(1.35f * cq, f.sansMedium, INK, 0));
        c.drawText(u.spec, sx, midY - 1.2f * cq, text(.95f * cq, f.sans, 0x994A3F55, 0));
        float enter = easeOut(a.entrance);
        pillRow(c, sx, midY + .6f * cq, sw, cq, "Load", u.loadText,
                u.loadFrac != null, load * enter, isCpu ? CPU_PILL : GPU_PILL, f);
        pillRow(c, sx, midY + 2.6f * cq, sw, cq, u.memLabel.equals("VRAM") ? "VRAM" : "Memory",
                u.memText, u.memFrac != null, mem * enter, isCpu ? CPU_MEM : GPU_MEM, f);

        // temp chip with its mood tag
        RectF chip = new RectF(card.right - 17 * cq, midY - 4.2f * cq, card.right - 2 * cq, midY + 4.2f * cq);
        scratch.reset();
        scratch.setColor(INK);
        sh.set(chip);
        sh.offset(0, .35f * cq);
        c.drawRoundRect(sh, 1.6f * cq, 1.6f * cq, scratch);
        scratch.setColor(FACE);
        c.drawRoundRect(chip, 1.6f * cq, 1.6f * cq, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .24f);
        scratch.setColor(INK);
        c.drawRoundRect(chip, 1.6f * cq, 1.6f * cq, scratch);
        Paint n = text(3.4f * cq, f.sansMedium, INK, 0);
        c.drawText(u.tempText, chip.centerX() - n.measureText(u.tempText) / 2, chip.top + 3.4f * cq, n);
        Paint k = text(.9f * cq, f.sans, 0x994A3F55, 0);
        c.drawText("die temp", chip.centerX() - k.measureText("die temp") / 2, chip.top + 4.6f * cq, k);
        String tag = u.tempC == null ? "no sensor" : toasty ? "getting toasty" : "nice and cool";
        Paint tp = text(.95f * cq, f.sansMedium, INK, 0);
        float tw = tp.measureText(tag) + 2 * cq;
        RectF tagR = new RectF(chip.centerX() - tw / 2, chip.bottom - 2.5f * cq,
                chip.centerX() + tw / 2, chip.bottom - 1 * cq);
        scratch.reset();
        scratch.setColor(u.tempC == null ? FACE : toasty ? WARM_TAG : COOL_TAG);
        c.drawRoundRect(tagR, tagR.height() / 2, tagR.height() / 2, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .18f);
        scratch.setColor(INK);
        c.drawRoundRect(tagR, tagR.height() / 2, tagR.height() / 2, scratch);
        c.drawText(tag, tagR.left + cq, tagR.bottom - .45f * cq, tp);
    }

    private void face(Canvas c, float x, float y, float size, float cq, boolean isCpu,
                      boolean toasty, Anim a) {
        RectF face = new RectF(x, y, x + size, y + size);
        scratch.reset();
        scratch.setColor(FACE);
        c.drawRoundRect(face, 2 * cq, 2 * cq, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .24f);
        scratch.setColor(INK);
        c.drawRoundRect(face, 2 * cq, 2 * cq, scratch);

        // eyes: worried-open when toasty, happy-closed when cool; blink ambient
        float eyeY = face.top + size * .36f;
        boolean blink = !a.reducedMotion && (a.clock % 5200) < 120;
        scratch.reset();
        scratch.setColor(INK);
        for (int side = 0; side < 2; side++) {
            float ex = side == 0 ? face.left + size * .26f + .5f * cq : face.right - size * .26f - .5f * cq;
            if (toasty && !blink) {
                c.drawCircle(ex, eyeY + .5f * cq, .52f * cq, scratch);
            } else {
                c.drawRoundRect(ex - .8f * cq, eyeY + .35f * cq, ex + .8f * cq, eyeY + .65f * cq,
                        .3f * cq, .3f * cq, scratch);
            }
        }
        // blush
        scratch.reset();
        scratch.setColor(isCpu ? CPU_BLUSH : GPU_BLUSH);
        scratch.setAlpha(166);
        float blushY = face.top + size * .52f;
        c.drawRoundRect(face.left + size * .13f, blushY, face.left + size * .13f + 1.5f * cq,
                blushY + .85f * cq, .85f * cq, .85f * cq, scratch);
        c.drawRoundRect(face.right - size * .13f - 1.5f * cq, blushY, face.right - size * .13f,
                blushY + .85f * cq, .85f * cq, .85f * cq, scratch);
        // mouth
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .22f);
        scratch.setColor(INK);
        RectF mouth = new RectF(face.centerX() - 1.05f * cq, face.top + size * .52f,
                face.centerX() + 1.05f * cq, face.top + size * .52f + 2.2f * cq);
        c.drawArc(mouth, 20, 140, false, scratch);
        // sweat drop — temperature signal, hot die ONLY, with the slow slide
        if (toasty) {
            float slide = a.reducedMotion ? 0
                    : (float) (Math.sin(a.clock / 2600.0 * 2 * Math.PI) * .5 + .5) * .4f * cq;
            float dx = face.right - size * .12f - .45f * cq, dy = face.top + size * .14f + slide;
            path.reset();
            path.moveTo(dx, dy);
            path.quadTo(dx + .75f * cq, dy + .4f * cq, dx + .45f * cq, dy + 1.15f * cq);
            path.quadTo(dx + .1f * cq, dy + 1.55f * cq, dx - .3f * cq, dy + 1.1f * cq);
            path.quadTo(dx - .6f * cq, dy + .5f * cq, dx, dy);
            scratch.reset();
            scratch.setColor(DROP);
            c.drawPath(path, scratch);
            scratch.setStyle(Paint.Style.STROKE);
            scratch.setStrokeWidth(cq * .18f);
            scratch.setColor(INK);
            c.drawPath(path, scratch);
        }
    }

    private void pillRow(Canvas c, float x, float y, float sw, float cq, String key, String value,
                         boolean present, float frac, int fill, Assets f) {
        c.drawText(key, x, y + .4f * cq, text(.85f * cq, f.sansMedium, 0xA64A3F55, 0));
        RectF pill = new RectF(x + 5.5f * cq + cq, y - .6f * cq, x + sw - 8 * cq - cq, y + .65f * cq);
        scratch.reset();
        scratch.setColor(FACE);
        c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .2f);
        scratch.setColor(INK);
        c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, scratch);
        if (present && frac > 0) {
            scratch.reset();
            scratch.setColor(fill);
            float fw = Math.max(pill.height(), pill.width() * Math.min(1, frac));
            c.drawRoundRect(pill.left + cq * .1f, pill.top + cq * .1f,
                    pill.left + fw - cq * .1f, pill.bottom - cq * .1f,
                    pill.height() / 2, pill.height() / 2, scratch);
        }
        rightText(c, value, x + sw, y + .4f * cq, text(1.15f * cq, f.sansMedium, INK, 0));
    }
}
