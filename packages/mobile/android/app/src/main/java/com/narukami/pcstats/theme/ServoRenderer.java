package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;

/**
 * 13 · Servo — diagnostic bay. Clipped-corner panels with a hazard-yellow
 * spine, sheared armour-plate meters, and a visor whose two eyes are
 * colour-coded to the dies — the header states both temps before you read
 * a number.
 */
class ServoRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFF15171B, YELLOW = 0xFFF2C200;
    private static final int WARM = 0xFFFFB02E, COOL = 0xFF4BE0A0;
    private static final int INK = 0xFFE8EAED, CAPTION = 0xFF7F868F;
    private static final int PLATE_DIM = 0xFF22262C, PANEL_BORDER = 0xFF2B3037;

    private final Path clip = new Path();

    @Override
    public String id() { return "servo"; }

    private final Critter critter = new Critter(Critter.TRAP, Critter.ANTENNA,
            Critter.EYE_VISOR, Critter.M_STRIPE, 0xFF1B1E23, 0xFF2B3037, 0xFF14171B,
            0xFF4BE0A0, 0xFF4BE0A0, 0xFFFFB02E, 0xFFF2C200, false, 0.5f, 0.52f);

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
    protected int clockFill() { return 0xFF1B1E23; }

    @Override
    protected int clockStroke() { return 0x59F2C200; }

    @Override
    protected float clockRadius(float chipH) { return 0; }

    @Override
    protected float[] clockAnchor(float w, float h, float cq) {
        return new float[]{w / 2, 4.5f * cq};   // centred inside the visor
    }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(FIELD);
        scratch.reset();
        scratch.setColor(0x0DF2C200);
        scratch.setStrokeWidth(1.5f);
        for (float x = 0; x < vw; x += vw * .03f) c.drawLine(x, 0, x, vh, scratch);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 2.4f * cq, padY = 2 * cq, gap = 1.1f * cq;

        // visor
        float visorH = 3.6f * cq;
        panel(c, padX, padY, w - 2 * padX, visorH, 1.6f * cq, cq, 0xFF1E2126, 0xFF111317, 0xFF2E333A, false);
        float ey = padY + visorH / 2;
        eye(c, padX + 1.6f * cq, ey, cq, m.cpu, a);
        eye(c, padX + 1.6f * cq + 4.4f * cq, ey, cq, m.gpu, a);
        float ttlX = padX + 1.6f * cq + 9 * cq;
        c.drawText("DIAGNOSTIC BAY", ttlX, ey - .1f * cq, text(cq, f.sansBold, YELLOW, .32f));
        boolean anyHot = (m.cpu.tempFrac != null && m.cpu.tempFrac >= .78)
                || (m.gpu.tempFrac != null && m.gpu.tempFrac >= .78);
        c.drawText(anyHot ? "THERMAL WATCH" : "BOTH DIES NOMINAL", ttlX, ey + .9f * cq,
                text(.68f * cq, f.sansMedium, anyHot ? WARM : CAPTION, .24f));
        rightText(c, "RANGE 30–100 °C", padX + w - 2 * padX - 1.6f * cq, ey + .3f * cq,
                text(.72f * cq, f.sansMedium, CAPTION, .28f));

        float top = padY + visorH + gap;
        float unitH = (h - top - padY - gap) / 2;
        drawUnit(c, padX, top, w - 2 * padX, unitH, cq, m.cpu, a.cpuLoad, a.cpuMem, a.cpuTemp, a, true, f);
        drawUnit(c, padX, top + unitH + gap, w - 2 * padX, unitH, cq, m.gpu, a.gpuLoad, a.gpuMem,
                a.gpuTemp, a, false, f);
    }

    private void eye(Canvas c, float x, float cy, float cq, Model.Unit u, Anim a) {
        boolean warm = u.tempFrac != null && u.tempFrac >= .5;
        int color = u.tempFrac == null ? PLATE_DIM : warm ? WARM : COOL;
        // breathing glow, offset per eye
        float breathe = a.reducedMotion ? 1
                : .8f + .2f * (float) Math.sin(a.clock / 4000.0 * 2 * Math.PI + (warm ? 0 : Math.PI));
        clip.reset();
        clip.moveTo(x + .5f * cq, cy - .65f * cq);
        clip.lineTo(x + 3.6f * cq, cy - .65f * cq);
        clip.lineTo(x + 3.1f * cq, cy + .65f * cq);
        clip.lineTo(x, cy + .65f * cq);
        clip.close();
        scratch.reset();
        scratch.setColor(color);
        scratch.setAlpha((int) (70 * breathe));
        c.drawRoundRect(x - .5f * cq, cy - 1.1f * cq, x + 4.1f * cq, cy + 1.1f * cq, cq, cq, scratch);
        scratch.setAlpha(255);
        c.drawPath(clip, scratch);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, float load, float mem, float temp, Anim a,
                          boolean isCpu, Assets f) {
        panel(c, x, y, w, unitH, 1.4f * cq, cq, 0xFF1B1E23, 0xFF121418, PANEL_BORDER, true);
        float midY = y + unitH / 2;
        float px = x + 1.8f * cq;
        c.drawText(u.tag, px, midY - 1.7f * cq, text(.7f * cq, f.sansMedium, YELLOW, .34f));
        c.drawText(u.name, px, midY - .2f * cq, text(1.4f * cq, f.sansBold, INK, .04f));
        c.drawText(u.spec, px, midY + 1.1f * cq, text(.7f * cq, f.sans, CAPTION, .16f));

        boolean warm = u.tempFrac != null && u.tempFrac >= .5;
        int tone = u.tempFrac == null ? CAPTION : warm ? WARM : COOL;
        float rx = px + 16 * cq + 1.8f * cq;
        float rw = x + w - 20 * cq - 1.8f * cq - rx;
        float rowGap = unitH / 4;
        float enter = easeOut(a.entrance);
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        String thirdKey = isCpu ? "THERMAL" : "POWER";
        String thirdV = isCpu ? (head == null ? "—" : head + "° LEFT")
                : u.powerW == null ? "—" : String.format(java.util.Locale.US, "%.1f W", u.powerW);
        float thirdFrac = isCpu ? (Float.isNaN(temp) ? 0 : temp)
                : u.powerW == null ? 0 : (float) Model.clamp01(u.powerW
                / (u.powerLimitW != null && u.powerLimitW > 0 ? u.powerLimitW : 90));
        prow(c, rx, y + rowGap, rw, cq, "LOAD", u.loadText, u.loadFrac != null, load * enter, tone, f);
        prow(c, rx, y + 2 * rowGap, rw, cq, u.memLabel, u.memText, u.memFrac != null, mem * enter, tone, f);
        prow(c, rx, y + 3 * rowGap, rw, cq, thirdKey, thirdV, true, thirdFrac * enter, tone, f);

        // temp block on the right, behind a hairline
        float tx = x + w - 20 * cq;
        scratch.reset();
        scratch.setColor(PANEL_BORDER);
        c.drawRect(tx - 1.6f * cq, y + unitH * .18f, tx - 1.6f * cq + Math.max(1, cq * .06f),
                y + unitH * .82f, scratch);
        Paint n = text(4 * cq, f.sansBold, tone, -.02f);
        String t = u.tempC == null ? "—" : Math.round(u.tempC) + "°C";
        rightText(c, t, x + w - 1.8f * cq, midY, n);
        rightText(c, "DIE TEMP", x + w - 1.8f * cq, midY + 1.3f * cq,
                text(.66f * cq, f.sansMedium, CAPTION, .3f));
        String st = warm ? "MONITOR"
                : u.fanPct != null && Math.round(u.fanPct) == 0 ? "FAN IDLE" : "NOMINAL";
        Paint stP = text(.66f * cq, f.sansMedium, FIELD, .24f);
        float stW = stP.measureText(st) + 1.6f * cq;
        scratch.reset();
        scratch.setColor(YELLOW);
        c.drawRect(x + w - 1.8f * cq - stW, midY + 2 * cq, x + w - 1.8f * cq, midY + 3.1f * cq, scratch);
        c.drawText(st, x + w - 1.8f * cq - stW + .8f * cq, midY + 2.8f * cq, stP);
    }

    private void prow(Canvas c, float x, float y, float rw, float cq, String key, String value,
                      boolean present, float frac, int tone, Assets f) {
        c.drawText(key, x, y + .3f * cq, text(.7f * cq, f.sansMedium, CAPTION, .26f));
        float segX = x + 6 * cq + cq, segW = rw - 6 * cq - 8.5f * cq - 2 * cq;
        int lit = present ? Model.litCells(16, (double) Math.min(1, frac)) : 0;
        float gap = .22f * cq, cell = (segW - 15 * gap) / 16;
        for (int i = 0; i < 16; i++) {
            float sx = segX + i * (cell + gap);
            clip.reset();                                   // sheared armour plate
            clip.moveTo(sx + .2f * cq, y - .48f * cq);
            clip.lineTo(sx + cell, y - .48f * cq);
            clip.lineTo(sx + cell - .2f * cq, y + .48f * cq);
            clip.lineTo(sx, y + .48f * cq);
            clip.close();
            scratch.reset();
            scratch.setColor(i < lit ? tone : PLATE_DIM);
            c.drawPath(clip, scratch);
        }
        rightText(c, value, x + rw, y + .4f * cq, text(1.15f * cq, f.sansMedium, present ? INK : CAPTION, .02f));
    }

    /** Panel with one clipped corner pair and the yellow spine. */
    private void panel(Canvas c, float x, float y, float w, float h, float corner, float cq,
                       int top, int bot, int border, boolean spine) {
        clip.reset();
        clip.moveTo(x + corner, y);
        clip.lineTo(x + w, y);
        clip.lineTo(x + w, y + h - corner);
        clip.lineTo(x + w - corner, y + h);
        clip.lineTo(x, y + h);
        clip.lineTo(x, y + corner);
        clip.close();
        scratch.reset();
        scratch.setShader(new LinearGradient(0, y, 0, y + h, top, bot, Shader.TileMode.CLAMP));
        c.drawPath(clip, scratch);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        scratch.setColor(border);
        c.drawPath(clip, scratch);
        if (spine) {
            scratch.reset();
            scratch.setColor(YELLOW);
            c.drawRect(x, y + h * .2f, x + .3f * cq, y + h * .8f, scratch);
        }
    }
}
