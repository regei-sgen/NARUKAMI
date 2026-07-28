package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;

import java.util.Locale;

/**
 * 17 · Donuts — every metric as a ring, each a percentage of ITS OWN ceiling,
 * with both terms stated in the centre ("18.4G / of 32G"). The fourth ring per
 * device is derived: thermal margin for the CPU, power draw for the GPU.
 * No ambient motion — eight pulsing rings would be unreadable.
 */
class DonutsRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFF0F1220, INK = 0xFFEAEEFB, CAPTION = 0xFF7A82A8;
    private static final int TRACK = 0x17FFFFFF;
    private static final int CPU_RING = 0xFF8AA4D6, GPU_RING = 0xFF6FC4D8;
    private static final int CPU_TEMP = 0xFFE0A45F, GPU_TEMP = 0xFF7BC4A4;

    @Override
    public String id() { return "donuts"; }

    private final Critter critter = new Critter(Critter.ELLIPSE, Critter.EARS_NONE,
            Critter.EYE_RING, Critter.M_SPRINKLE, 0xFF181C30, 0xFF2A3050, 0xFF10131F,
            0xFF8AA4D6, 0xFF8AA4D6, 0xFFE0A45F, 0xFF6FC4D8, false, 0.06f, 0.94f);

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
    protected int clockFill() { return 0xFF181C30; }

    @Override
    protected int clockStroke() { return 0x17FFFFFF; }

    @Override
    protected float[] clockAnchor(float w, float h, float cq) {
        return new float[]{w / 2, h - 1.4f * cq};   // bottom pad, under the rings
    }

    @Override
    public boolean ambient() { return false; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(FIELD);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 2.6f * cq, padY = 2.2f * cq, gap = cq;

        float headY = padY + cq;
        Paint b = text(1.2f * cq, f.sansMedium, INK, .01f);
        c.drawText("Utilisation", padX, headY, b);
        c.drawText("EACH RING IS A PERCENTAGE OF ITS OWN CEILING",
                padX + b.measureText("Utilisation") + 1.2f * cq, headY,
                text(.74f * cq, f.sansMedium, CAPTION, .28f));
        rightText(c, "Tj MAX " + (m.cpu.tjMaxC == null ? 100 : m.cpu.tjMaxC) + " °C",
                w - padX, headY, text(.74f * cq, f.sansMedium, CAPTION, .28f));

        float top = headY + gap;
        float unitH = (h - top - padY - gap) / 2;
        unit(c, padX, top, w - 2 * padX, unitH, cq, m.cpu, a, true, f);
        unit(c, padX, top + unitH + gap, w - 2 * padX, unitH, cq, m.gpu, a, false, f);
    }

    private void unit(Canvas c, float x, float y, float w, float unitH, float cq,
                      Model.Unit u, Anim a, boolean isCpu, Assets f) {
        float midY = y + unitH / 2;
        c.drawText(u.name, x, midY - .3f * cq, text(1.2f * cq, f.sansMedium, INK, 0));
        c.drawText(u.spec, x, midY + .9f * cq, text(.74f * cq, f.sans, CAPTION, 0));

        int main = isCpu ? CPU_RING : GPU_RING;
        int tempC = isCpu ? CPU_TEMP : GPU_TEMP;
        float enter = easeOut(a.entrance);
        float rx = x + 14 * cq + 1.6f * cq;
        float ringGap = 1.6f * cq, ringW = (x + w - rx - 3 * ringGap) / 4;

        float load = isCpu ? a.cpuLoad : a.gpuLoad;
        float mem = isCpu ? a.cpuMem : a.gpuMem;
        float temp = isCpu ? a.cpuTemp : a.gpuTemp;
        String memBig = u.memText.contains("/")
                ? u.memText.substring(0, u.memText.indexOf('/')) + "G" : "—";
        String memOf = u.memText.contains("/")
                ? "of " + u.memText.substring(u.memText.indexOf('/') + 1) : "";

        ring(c, rx, midY, ringW, cq, u.loadFrac == null ? Float.NaN : load * enter, main,
                u.loadText, "of 100", "LOAD", f);
        ring(c, rx + ringW + ringGap, midY, ringW, cq, u.memFrac == null ? Float.NaN : mem * enter,
                main, memBig, memOf, u.memLabel, f);
        // temp ring reads °-of-100° directly, not the 30–100 fraction — the
        // centre states both terms, so the normalisation must match the words
        float tempOf100 = u.tempC == null ? Float.NaN
                : (float) Model.clamp01(u.tempC / (u.tjMaxC == null ? 100.0 : u.tjMaxC)) * enter;
        ring(c, rx + 2 * (ringW + ringGap), midY, ringW, cq, tempOf100, tempC,
                u.tempC == null ? "—" : Math.round(u.tempC) + "°",
                "of " + (u.tjMaxC == null ? 100 : u.tjMaxC) + "°", "DIE TEMP", f);

        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        if (isCpu) {
            float margin = head == null ? Float.NaN : (float) Model.clamp01(head / 70.0) * enter;
            ring(c, rx + 3 * (ringW + ringGap), midY, ringW, cq, margin, tempC,
                    head == null ? "—" : head + "°", "headroom", "MARGIN", f);
        } else {
            double limit = u.powerLimitW != null && u.powerLimitW > 0 ? u.powerLimitW : 90;
            float power = u.powerW == null ? Float.NaN
                    : (float) Model.clamp01(u.powerW / limit) * enter;
            ring(c, rx + 3 * (ringW + ringGap), midY, ringW, cq, power, tempC,
                    u.powerW == null ? "—" : String.format(Locale.US, "%.1fW", u.powerW),
                    "of " + (u.powerLimitW != null ? Math.round(u.powerLimitW) + "W" : "~90W"),
                    "POWER", f);
        }
    }

    private void ring(Canvas c, float x, float midY, float ringW, float cq, float frac, int color,
                      String big, String of, String cap, Assets f) {
        float d = Math.min(ringW, 12 * cq), r = d * .4f;
        float cx = x + ringW / 2, cy = midY - .5f * cq;
        RectF oval = new RectF(cx - r, cy - r, cx + r, cy + r);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(d * .0625f);
        scratch.setColor(TRACK);
        c.drawArc(oval, 0, 360, false, scratch);
        if (!Float.isNaN(frac) && frac > 0) {
            scratch.setColor(color);
            scratch.setStrokeCap(Paint.Cap.ROUND);
            c.drawArc(oval, -90, (float) (360 * Model.clamp01(frac)), false, scratch);
        }
        Paint bp = text(d * .16f, f.sansMedium, Float.isNaN(frac) ? CAPTION : INK, -.025f);
        c.drawText(big, cx - bp.measureText(big) / 2, cy + d * .02f, bp);
        Paint op = text(d * .06f, f.sans, CAPTION, 0);
        c.drawText(of, cx - op.measureText(of) / 2, cy + d * .12f, op);
        Paint cp = text(.7f * cq, f.sansMedium, CAPTION, .26f);
        c.drawText(cap, cx - cp.measureText(cap) / 2, cy + r + 1.3f * cq, cp);
    }
}
