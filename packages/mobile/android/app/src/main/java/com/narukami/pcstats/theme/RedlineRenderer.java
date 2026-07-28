package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * 12 · Redline — one colour; the threshold is the story. Hazard stripes run
 * only while the CPU is above 70 % of the scale (motion that carries a state
 * stops when the state clears), the alert dot pulses on the hot die only, and
 * a die within limits stays pale. Restraint is what makes the red mean something.
 */
class RedlineRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFF0E0000, SIGNAL = 0xFFFF1E1E, TAIL = 0xFF7A0000;
    private static final int BODY = 0xFFFFD9D9, CAPTION = 0xFFC96B6B;
    private static final int TITLE = 0xFFFF5252, SUB = 0xFFFF8A8A, WHITE = 0xFFFFFFFF;

    @Override
    public String id() { return "redline"; }

    @Override
    protected int clockColor() { return CAPTION; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.sansBold; }

    @Override
    protected int clockFill() { return 0xFF1A0505; }

    @Override
    protected int clockStroke() { return 0x80FF1E1E; }

    @Override
    protected float clockRadius(float chipH) { return 0; }

    @Override
    protected float[] clockAnchor(float w, float h, float cq) {
        return new float[]{3 * cq, h - 2.4f * cq, -1};   // lower left, off the edge
    }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(FIELD);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;

        // hazard band: drifts ONLY while the CPU runs hot
        boolean cpuHot = m.cpu.tempFrac != null && m.cpu.tempFrac >= (70 - 30) / 70.0;
        float drift = cpuHot && !a.reducedMotion ? (a.clock % 3000) / 3000f * 3 * cq : 0;
        int save = c.save();
        c.clipRect(0, 0, w, 2.2f * cq);
        scratch.reset();
        scratch.setStrokeWidth(1.5f * cq);
        scratch.setColor(SIGNAL);
        for (float x = -6 * cq + drift; x < w + 4 * cq; x += 3 * cq) {
            c.drawLine(x, 2.7f * cq, x + 2.7f * cq, -.5f * cq, scratch);
        }
        c.restoreToCount(save);

        float top = 2.2f * cq;
        float unitH = (h - top) / 2;
        drawUnit(c, 0, top, w, unitH, cq, m.cpu, cpuHot, true, a, f);
        scratch.reset();
        scratch.setColor(0x59FF1E1E);
        c.drawRect(0, top + unitH, w, top + unitH + .16f * cq, scratch);
        drawUnit(c, 0, top + unitH, w, unitH, cq, m.gpu,
                m.gpu.tempFrac != null && m.gpu.tempFrac >= (70 - 30) / 70.0, false, a, f);
    }

    /**
     * The resident: a stubby hazard-striped service bot in the lower right.
     * Its visor eye scans while things are calm, locks red and pulses when the
     * CPU crosses the redline, and a tap makes it jolt with a flash and "!".
     */
    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        // home: lower right — unless the user has carried it somewhere
        float gx = Float.isNaN(a.petX) ? w - 7 * cq : a.petX;
        float ground = Float.isNaN(a.petY) ? h - 2.6f * cq : a.petY;
        float s = 1.8f * cq;

        boolean poked = a.pokeAge < 700;
        boolean hot = m.cpu.tempFrac != null && m.cpu.tempFrac >= (70 - 30) / 70f;
        float shake = poked && !a.reducedMotion
                ? (float) Math.sin(a.pokeAge / 60.0) * (1 - a.pokeAge / 700f) * 4 : 0;

        // idle acts: 0 scan sweep · 1 antenna ping · 2 hop-turn ·
        //            3 diagnostic blink · 4 power nap
        int act = a.petAct;
        float at = a.petActT;
        float actS = act >= 0 ? (float) Math.sin(at * Math.PI) : 0;

        // grounded contact shadow
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setShader(new android.graphics.RadialGradient(gx, ground + s * .05f, s * .9f,
                0x59000000, 0x00000000, Shader.TileMode.CLAMP));
        c.save();
        c.scale(1f, .2f, gx, ground + s * .05f);
        c.drawCircle(gx, ground + s * .05f, s * .9f, scratch);
        c.restore();
        scratch.setShader(null);

        int save = c.save();
        c.rotate(shake, gx, ground);
        if (a.petDragging && !a.reducedMotion) {           // picked up: tilt + lift
            c.rotate(-5, gx, ground);
            c.translate(0, -.7f * cq);
        }
        if (act == 2) {                                    // hop-turn, checking behind
            c.translate(0, -actS * 1.2f * cq);
            c.rotate((float) Math.sin(at * 2 * Math.PI) * 6, gx, ground);
        }

        // legs + boxy body with red rim, lit from the upper left
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setColor(0xFF3D0A0A);
        c.drawRect(gx - s * .55f, ground - s * .18f, gx - s * .25f, ground, scratch);
        c.drawRect(gx + s * .25f, ground - s * .18f, gx + s * .55f, ground, scratch);
        RectF body = new RectF(gx - s, ground - s * 1.75f, gx + s, ground - s * .18f);
        scratch.setColor(0xFF1A0505);
        c.drawRoundRect(body, s * .22f, s * .22f, scratch);
        scratch.setShader(new LinearGradient(body.left, body.top, body.right, body.bottom,
                new int[]{0x30FFD9D9, 0x00FFFFFF, 0x40000000}, new float[]{0, .45f, 1},
                Shader.TileMode.CLAMP));
        c.drawRoundRect(body, s * .22f, s * .22f, scratch);
        scratch.setShader(null);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1.5f, cq * .09f));
        scratch.setColor(hot ? SIGNAL : 0xFF7A1A1A);
        c.drawRoundRect(body, s * .22f, s * .22f, scratch);

        // hazard chevron chest band
        int save2 = c.save();
        RectF band = new RectF(body.left, body.centerY() + s * .18f, body.right, body.bottom - s * .12f);
        c.clipRect(band);
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStrokeWidth(s * .22f);
        int bandCol = hot ? SIGNAL : 0xFF8C1F1F;
        if (act == 3) {                                    // diagnostic self-test blink
            bandCol = Math.sin(at * 8 * Math.PI) > 0 ? SIGNAL : 0xFF4A0F0F;
        }
        scratch.setColor(bandCol);
        for (float sx = band.left - band.height(); sx < band.right + band.height(); sx += s * .44f) {
            c.drawLine(sx, band.bottom + 2, sx + band.height(), band.top - 2, scratch);
        }
        c.restoreToCount(save2);

        // visor: a dark slot with one scanning (or locked) eye dot
        RectF visor = new RectF(gx - s * .72f, body.top + s * .18f, gx + s * .72f, body.top + s * .62f);
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setColor(0xFF0B0202);
        c.drawRoundRect(visor, s * .2f, s * .2f, scratch);
        float eyeX = hot || poked ? gx
                : gx + (float) Math.sin(a.clock / 2200.0 * 2 * Math.PI) * s * .45f;
        if (act == 0) eyeX = gx + (float) Math.sin(at * 2 * Math.PI) * s * .58f;  // fast sweep
        int eye = poked ? 0xFFFFFFFF : hot ? SIGNAL : 0xFFC96B6B;
        float pulse = hot && !a.reducedMotion
                ? .7f + .3f * (float) Math.sin(a.clock / 700.0 * 2 * Math.PI) : 1;
        if (act == 4) {                                    // power nap: visor dims to a slit
            scratch.setColor(0xFF7A1A1A);
            c.drawRect(gx - s * .5f, visor.centerY() - s * .03f,
                    gx + s * .5f, visor.centerY() + s * .03f, scratch);
        } else {
            if (act == 0) {                                // sweep trail
                scratch.setColor(eye);
                for (int i = 1; i <= 3; i++) {
                    float tx = gx + (float) Math.sin((at - i * .04f) * 2 * Math.PI) * s * .58f;
                    scratch.setAlpha(90 - i * 25);
                    c.drawCircle(tx, visor.centerY(), s * .11f, scratch);
                }
            }
            scratch.setColor(eye);
            scratch.setAlpha((int) (255 * pulse));
            scratch.setShadowLayer(s * .3f, 0, 0, eye);
            c.drawCircle(eyeX, visor.centerY(), s * .14f, scratch);
            scratch.clearShadowLayer();
        }

        // antenna, tip alive when hot
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStrokeWidth(Math.max(1.5f, cq * .07f));
        scratch.setColor(0xFF7A1A1A);
        c.drawLine(gx, body.top, gx, body.top - s * .5f, scratch);
        scratch.setStyle(Paint.Style.FILL);
        scratch.setColor(hot ? SIGNAL : 0xFF8C1F1F);
        c.drawCircle(gx, body.top - s * .58f, s * .11f, scratch);

        // antenna ping ring; nap dots — drawn before un-rotating so they track
        if (act == 1 && at > .15f) {
            float rt = (at - .15f) / .85f;
            scratch.reset();
            scratch.setAntiAlias(true);
            scratch.setStyle(Paint.Style.STROKE);
            scratch.setStrokeWidth(Math.max(1.5f, cq * .08f));
            scratch.setColor(SIGNAL);
            scratch.setAlpha((int) (220 * (1 - rt)));
            c.drawCircle(gx, body.top - s * .58f, s * (.2f + rt * 2.2f), scratch);
        }
        if (act == 4) {
            Paint dots = text(1.2f * cq, f.condensedBold, 0xFFC96B6B, .1f);
            int n = 1 + (int) (at * 3);
            StringBuilder d = new StringBuilder();
            for (int i = 0; i < n; i++) d.append('.');
            dots.setAlpha((int) (255 * (1 - at * .5f)));
            c.drawText(d.toString(), gx - s * .4f, body.top - s * .35f, dots);
        }
        c.restoreToCount(save);

        // startled "!" above the head, fading out
        if (poked) {
            Paint bang = text(1.6f * cq, f.condensedBold, SIGNAL, 0);
            bang.setAlpha((int) (255 * (1 - a.pokeAge / 700f)));
            c.drawText("!", gx + s * 1.2f, body.top - s * .4f, bang);
        }
    }

    @Override
    public RectF petBounds(float w, float h, Anim a) {
        final float cq = w / 100f;
        float gx = Float.isNaN(a.petX) ? w - 7 * cq : a.petX;
        float ground = Float.isNaN(a.petY) ? h - 2.6f * cq : a.petY;
        return new RectF(gx - 2.6f * cq, ground - 4.6f * cq, gx + 2.6f * cq, ground + .6f * cq);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, boolean hot, boolean isCpu, Anim a, Assets f) {
        float px = x + 3 * cq;
        float ty = y + 2.6f * cq;

        // title row with the alert dot (hot die only)
        float tx = px;
        if (hot) {
            scratch.reset();
            scratch.setColor(SIGNAL);
            float pulse = a.reducedMotion ? 1
                    : .25f + .75f * (.5f + .5f * (float) Math.sin(a.clock / 1600.0 * 2 * Math.PI));
            scratch.setAlpha((int) (255 * pulse));
            c.drawCircle(px + .4f * cq, ty - .3f * cq, .4f * cq, scratch);
            tx += 1.6f * cq;
        }
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        String title = u.tag + " · " + (u.tempC == null ? "NO SENSOR"
                : hot && head != null ? head + " °C FROM Tj MAX" : "WITHIN LIMITS");
        c.drawText(title, tx, ty, text(.85f * cq, f.sansBold, TITLE, .34f));

        Paint nm = text(3.4f * cq, f.condensedBold, WHITE, .01f);
        c.drawText(u.name.toUpperCase(), px, ty + 3.4f * cq, nm);
        c.drawText(u.spec.toUpperCase(), px, ty + 4.9f * cq, text(.88f * cq, f.sansMedium, SUB, .24f));

        String third = isCpu ? "HEADROOM" : "FAN";
        String thirdV = isCpu ? (head == null ? "—" : head + "°C")
                : u.fanPct == null ? "—" : Math.round(u.fanPct) == 0 ? "IDLE" : Math.round(u.fanPct) + "%";
        String[][] stats = {{"LOAD", u.loadText}, {u.memLabel, u.memText}, {third, thirdV}};
        float sx = px;
        for (String[] s : stats) {
            c.drawText(s[0], sx, ty + 6.7f * cq, text(.7f * cq, f.sansBold, CAPTION, .3f));
            Paint v = text(2 * cq, f.condensedBold, 0xFFFFECEC, .01f);
            c.drawText(s[1], sx, ty + 8.7f * cq, v);
            sx += Math.max(7 * cq, v.measureText(s[1]) + 3 * cq);
        }

        // gauge: the number, the track, the hard white Tj tick
        float gx = x + w - 3 * cq - 34 * cq;
        float gw = 34 * cq;
        float midY = y + unitH / 2;
        Paint num = text(6.6f * cq, f.condensedBold, hot ? SIGNAL : BODY, -.01f);
        String n = u.tempC == null ? "—" : String.valueOf(Math.round(u.tempC));
        c.drawText(n, gx, midY + .5f * cq, num);
        c.drawText("°C", gx + num.measureText(n) + .4f * cq, midY - 3.2f * cq,
                text(1.6f * cq, f.condensedBold, SUB, 0));

        RectF track = new RectF(gx, midY + 1.5f * cq, gx + gw, midY + 2.8f * cq);
        scratch.reset();
        scratch.setColor(0x24FF1E1E);
        c.drawRect(track, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(cq * .14f);
        scratch.setColor(0x80FF1E1E);
        c.drawRect(track, scratch);
        float frac = isCpu ? a.cpuTemp : a.gpuTemp;
        if (!Float.isNaN(frac) && frac > 0) {
            scratch.reset();
            scratch.setShader(new LinearGradient(track.left, 0, track.right, 0,
                    TAIL, SIGNAL, Shader.TileMode.CLAMP));
            c.drawRect(track.left, track.top, track.left
                    + track.width() * Math.min(1, frac * easeOut(a.entrance)), track.bottom, scratch);
            scratch.setShader(null);
        }
        scratch.reset();
        scratch.setColor(WHITE);
        c.drawRect(track.right - cq * .2f, track.top - .7f * cq, track.right, track.bottom + .7f * cq, scratch);

        Paint sc = text(.66f * cq, f.sansBold, CAPTION, .24f);
        float scy = track.bottom + 1.3f * cq;
        c.drawText("30", track.left, scy, sc);
        c.drawText("DIE TEMP", track.centerX() - sc.measureText("DIE TEMP") / 2, scy, sc);
        rightText(c, isCpu && u.tjMaxC != null ? "Tj MAX " + u.tjMaxC : "100", track.right, scy, sc);
    }
}
