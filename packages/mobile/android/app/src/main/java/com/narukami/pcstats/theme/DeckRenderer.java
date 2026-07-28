package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;

import java.util.Locale;

/**
 * 09 · Deck — brushed-aluminium hi-fi faceplate with inset windows and 26-cell
 * LED ladders that change colour by POSITION, not value: green below 62 %,
 * amber to 85 %, red beyond. Nothing redlining is the point.
 */
class DeckRenderer extends ThemeRenderer {

    private static final int INK = 0xFF20242A, BRAND = 0xFF3A4048, SUB = 0xFF454C56;
    private static final int WIN_INK = 0xFFCFD4DA, WIN_CAP = 0xFF7A828C, WIN_VAL = 0xFFE4E9EF;
    private static final int LED_OFF = 0xFF20252B;
    private static final int GREEN = 0xFF4ADE80, AMBER = 0xFFFFC247, LRED = 0xFFFF5A48;
    private static final int DIAL_WARM = 0xFFFFB74D, DIAL_COOL = 0xFF7FD8A0;

    @Override
    public String id() { return "deck"; }

    private final Critter critter = new Critter(Critter.BOX, Critter.ANTENNA,
            Critter.EYE_GLOW, Critter.M_VU, 0xFF15171B, 0x99FFFFFF, 0xFF0B0D10,
            0xFF4ADE80, 0xFF4ADE80, 0xFFFF5A48, 0xFFFFC247, false, 0.5f, 0.57f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return SUB; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.condensed; }

    @Override
    protected int clockFill() { return 0xFF15171B; }

    @Override
    protected int clockStroke() { return 0x30FFFFFF; }

    @Override
    public boolean ambient() { return false; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        scratch.reset();
        scratch.setShader(new LinearGradient(0, 0, 0, vh,
                0xFFD5D8DD, 0xFFA8ADB5, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, vw, vh, scratch);
        scratch.reset();                     // brushed texture
        scratch.setColor(0x0B000000);
        for (float y = 0; y < vh; y += 4) c.drawRect(0, y, vw, y + 1.5f, scratch);
        scratch.setColor(0x0DFFFFFF);
        for (float y = 2; y < vh; y += 4) c.drawRect(0, y, vw, y + 1.5f, scratch);
        scratch.reset();
        scratch.setShader(new LinearGradient(0, 0, 0, vh * .22f,
                0x8CFFFFFF, 0x00FFFFFF, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, vw, vh * .22f, scratch);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 2.6f * cq, padY = 2 * cq, gap = 1.2f * cq;

        for (float[] p : new float[][]{{1, 1}, {99, 1}, {1, 98}, {99, 98}}) {
            screw(c, p[0] * cq * (w / 100f / cq), p[1] / 100f * h, cq);
        }
        float headY = padY + 1.1f * cq;
        c.drawText("SYSTEM MONITOR", padX, headY, text(1.15f * cq, f.condensedBold, BRAND, .42f));
        rightText(c, "DIE TEMP 30–100 °C · Tj MAX " + (m.cpu.tjMaxC == null ? 100 : m.cpu.tjMaxC),
                w - padX, headY, text(.75f * cq, f.condensed, SUB, .28f));

        float top = headY + gap;
        float unitH = (h - top - padY - gap) / 2;
        drawUnit(c, padX, top, w - 2 * padX, unitH, cq, m.cpu, a, true, f);
        drawUnit(c, padX, top + unitH + gap, w - 2 * padX, unitH, cq, m.gpu, a, false, f);
    }

    private void screw(Canvas c, float cx, float cy, float cq) {
        scratch.reset();
        scratch.setShader(new RadialGradient(cx - cq * .15f, cy - cq * .2f, cq * .8f,
                0xFFF2F4F6, 0xFF8A9099, Shader.TileMode.CLAMP));
        c.drawCircle(cx, cy, cq * .55f, scratch);
        scratch.reset();
        scratch.setColor(0x59000000);
        c.drawRect(cx - cq * .38f, cy - cq * .08f, cx + cq * .38f, cy + cq * .08f, scratch);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, Anim a, boolean isCpu, Assets f) {
        RectF win = new RectF(x, y, x + w, y + unitH);
        scratch.reset();
        scratch.setShader(new LinearGradient(0, y, 0, y + unitH,
                0xFF15171B, 0xFF0B0D10, Shader.TileMode.CLAMP));
        c.drawRoundRect(win, .4f * cq, .4f * cq, scratch);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .08f));
        scratch.setColor(0x99FFFFFF);
        c.drawRoundRect(new RectF(win.left, win.bottom, win.right, win.bottom + cq * .08f), 0, 0, scratch);
        scratch.setColor(0xCC000000);
        c.drawRoundRect(win, .4f * cq, .4f * cq, scratch);

        float px = x + 1.6f * cq, midY = win.centerY();
        c.drawText(u.tag, px, midY - .5f * cq, text(1.5f * cq, f.condensedBold, WIN_INK, .1f));
        c.drawText(u.name + (u.spec.isEmpty() ? "" : " · " + firstChunk(u.spec)), px, midY + .8f * cq,
                text(.75f * cq, f.condensed, WIN_CAP, .2f));

        float vx = px + 16 * cq, vw = x + w - 16 * cq - 1.6f * cq - vx;
        float rowGap = unitH / 4;
        float enter = easeOut(a.entrance);
        float temp = isCpu ? a.cpuTemp : a.gpuTemp;
        String thirdKey = isCpu ? "TEMP" : "POWER";
        float thirdFrac = isCpu ? (Float.isNaN(temp) ? 0 : temp)
                : u.powerW == null ? 0 : (float) Model.clamp01(u.powerW
                / (u.powerLimitW != null && u.powerLimitW > 0 ? u.powerLimitW : 90));
        String thirdV = isCpu
                ? (u.clockMHz == null ? "—" : String.format(Locale.US, "%.2f GHz", u.clockMHz / 1000))
                : (u.powerW == null ? "—" : String.format(Locale.US, "%.1f W", u.powerW));
        vurow(c, vx, y + rowGap, vw, cq, "LOAD", u.loadText,
                u.loadFrac == null ? 0 : (isCpu ? a.cpuLoad : a.gpuLoad) * enter, f);
        vurow(c, vx, y + 2 * rowGap, vw, cq, u.memLabel, u.memText,
                u.memFrac == null ? 0 : (isCpu ? a.cpuMem : a.gpuMem) * enter, f);
        vurow(c, vx, y + 3 * rowGap, vw, cq, thirdKey, thirdV, thirdFrac * enter, f);

        boolean cool = u.tempFrac == null || u.tempFrac < .6;
        float dx = x + w - 8 * cq;
        Paint n = text(3.6f * cq, f.sansBold, u.tempC == null ? WIN_CAP : cool ? DIAL_COOL : DIAL_WARM, -.03f);
        String t = u.tempC == null ? "—" : Math.round(u.tempC) + "°C";
        c.drawText(t, dx - n.measureText(t) / 2, midY + .4f * cq, n);
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        String k = u.tempC == null ? "DIE TEMP"
                : isCpu && head != null ? "DIE TEMP · " + head + "° LEFT"
                : u.fanPct != null && Math.round(u.fanPct) == 0 ? "DIE TEMP · FAN IDLE" : "DIE TEMP";
        Paint kp = text(.68f * cq, f.condensed, WIN_CAP, .34f);
        c.drawText(k, dx - kp.measureText(k) / 2, midY + 1.6f * cq, kp);
    }

    private void vurow(Canvas c, float x, float y, float vw, float cq, String key, String value,
                       float frac, Assets f) {
        c.drawText(key, x, y + .3f * cq, text(.72f * cq, f.condensed, WIN_CAP, .24f));
        float lx = x + 5.5f * cq + .9f * cq, lw = vw - 5.5f * cq - 7 * cq - 1.8f * cq;
        int lit = Model.litCells(26, (double) Model.clamp01(frac));
        float gap = .2f * cq, cell = (lw - 25 * gap) / 26;
        scratch.reset();
        for (int i = 0; i < 26; i++) {
            float p = i / 25f;
            int col = p < .62f ? GREEN : p < .85f ? AMBER : LRED;
            scratch.setColor(i < lit ? col : LED_OFF);
            float cx = lx + i * (cell + gap);
            c.drawRoundRect(cx, y - .42f * cq, cx + cell, y + .42f * cq, 1.5f, 1.5f, scratch);
        }
        rightText(c, value, x + vw, y + .4f * cq, text(1.15f * cq, f.condensed, WIN_VAL, .04f));
    }

    private static String firstChunk(String spec) {
        int cut = spec.indexOf(" · ");
        return cut > 0 ? spec.substring(0, cut) : spec;
    }
}
