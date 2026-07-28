package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;

import java.util.Locale;

/**
 * 18 · Radar — the only design comparing the dies directly: five normalised
 * axes, two polygons, and the raw table beside the plot so the normalisation
 * stays auditable. The vertex on the axis with the largest CPU–GPU gap pulses,
 * pointing at the finding.
 *
 * Ceilings: load and temp use their natural 100s; clock is normalised against
 * 4 GHz (CPU) / 2 GHz (GPU) and power against the GPU's own limit — stated
 * here because the table's raw numbers are the audit trail.
 */
class RadarRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFF0B0F14, WEB = 0xFF1A2229, WEB_HI = 0xFF2A343D;
    private static final int INK = 0xFFE8EEF4, CAPTION = 0xFF8B98A5;
    private static final int CPU = 0xFFE0A45F, GPU = 0xFF6FC4D8;
    private static final int RULE = 0xFF1B232C, RULE_DIM = 0xFF141B22;

    private final Path poly = new Path();

    @Override
    public String id() { return "radar"; }

    private final Critter critter = new Critter(Critter.CLOUD, Critter.ANTENNA,
            Critter.EYE_GLOW, Critter.M_SWEEP, 0xFF10161C, 0xFF2A343D, 0xFF0B0F14,
            0xFF6FC4D8, 0xFF6FC4D8, 0xFFE0A45F, 0xFFE0A45F, false, 0.06f, 0.94f);

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
    protected int clockFill() { return 0xFF10161C; }

    @Override
    protected int clockStroke() { return 0xFF2A343D; }

    @Override
    protected float[] clockAnchor(float w, float h, float cq) {
        return new float[]{w / 2, h - 1.4f * cq};   // between plot and table feet
    }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(FIELD);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 3 * cq, padY = 2.2f * cq;

        float[] cpu = axes(m.cpu, true);
        float[] gpu = axes(m.gpu, false);
        String[] names = {"LOAD", "MEMORY", "DIE TEMP", "CLOCK", "POWER"};

        // plot, 34cq column
        float R = 14 * cq;
        float cx = padX + 17 * cq, cy = h / 2;
        float enter = easeOut(a.entrance);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        for (int lvl = 1; lvl <= 4; lvl++) {
            scratch.setColor(lvl == 4 ? WEB_HI : WEB);
            web(c, cx, cy, R * lvl / 4f);
        }
        for (int i = 0; i < 5; i++) {
            float[] p = pt(cx, cy, R, i, 1);
            scratch.setColor(WEB);
            c.drawLine(cx, cy, p[0], p[1], scratch);
            float[] l = pt(cx, cy, R * 1.24f, i, 1);
            Paint ax = text(.72f * cq, f.mono, CAPTION, .1f);
            c.drawText(names[i], l[0] - ax.measureText(names[i]) / 2, l[1] + .3f * cq, ax);
        }
        // largest-gap vertex pulses — it points at the finding
        int gapAxis = 0;
        float gapMax = -1;
        for (int i = 0; i < 5; i++) {
            float g = Math.abs(cpu[i] - gpu[i]);
            if (g > gapMax) { gapMax = g; gapAxis = i; }
        }
        polygon(c, cx, cy, R, cpu, CPU, enter, gapAxis, a);
        polygon(c, cx, cy, R, gpu, GPU, enter, gapAxis, a);

        // side: title, legend, audit table
        float sx = padX + 34 * cq + 3 * cq;
        float sw = w - padX - sx;
        float sy = padY + 2.4f * cq;
        c.drawText("Where the two dies differ", sx, sy, text(1.5f * cq, f.sansMedium, INK, -.01f));
        sy += 2 * cq;
        legend(c, sx, sy, cq, CPU, "CPU · " + m.cpu.name, f);
        legend(c, sx + sw / 2, sy, cq, GPU, "GPU · " + (m.hasGpu ? m.gpu.name : "—"), f);

        sy += 2.2f * cq;
        String cpuClock = m.cpu.clockMHz == null ? "—"
                : String.format(Locale.US, "%.2f GHz", m.cpu.clockMHz / 1000);
        String gpuClock = m.gpu.clockMHz == null ? "—"
                : String.format(Locale.US, "%.2f GHz", m.gpu.clockMHz / 1000);
        String[][] rows = {
                {"AXIS", "CPU", "GPU"},
                {"Load", m.cpu.loadText, m.gpu.loadText},
                {"Memory in use", m.cpu.memText, m.gpu.memText},
                {"Die temp", m.cpu.tempText, m.gpu.tempText},
                {"Clock", cpuClock, gpuClock},
                {"Power", "—", m.gpu.powerW == null ? "—"
                        : String.format(Locale.US, "%.1f W", m.gpu.powerW)},
        };
        float rowH = 1.9f * cq;
        for (int i = 0; i < rows.length; i++) {
            float ry = sy + i * rowH;
            if (i == 0) {
                Paint hp = text(.66f * cq, f.sansMedium, CAPTION, .24f);
                c.drawText(rows[0][0], sx, ry, hp);
                rightText(c, rows[0][1], sx + sw * .72f, ry, hp);
                rightText(c, rows[0][2], sx + sw, ry, hp);
            } else {
                c.drawText(rows[i][0], sx, ry, text(.85f * cq, f.sans, CAPTION, 0));
                rightText(c, rows[i][1], sx + sw * .72f, ry, text(.85f * cq, f.sans, CPU, 0));
                rightText(c, rows[i][2], sx + sw, ry, text(.85f * cq, f.sans, GPU, 0));
            }
            scratch.reset();
            scratch.setColor(i == 0 ? RULE : RULE_DIM);
            c.drawRect(sx, ry + .5f * cq, sx + sw, ry + .5f * cq + Math.max(1, cq * .05f), scratch);
        }
    }

    /** The five normalised axis values (0..1): load · memory · temp · clock · power. */
    static float[] axes(Model.Unit u, boolean isCpu) {
        float load = u.loadFrac == null ? 0 : (float) (double) u.loadFrac;
        float mem = u.memFrac == null ? 0 : (float) (double) u.memFrac;
        float temp = u.tempFrac == null ? 0 : (float) (double) u.tempFrac;
        double clockCeil = isCpu ? 4000 : 2000;
        float clock = u.clockMHz == null ? 0 : (float) Model.clamp01(u.clockMHz / clockCeil);
        float power = 0;
        if (!isCpu && u.powerW != null) {
            double limit = u.powerLimitW != null && u.powerLimitW > 0 ? u.powerLimitW : 90;
            power = (float) Model.clamp01(u.powerW / limit);
        }
        return new float[]{load, mem, temp, clock, power};
    }

    private float[] pt(float cx, float cy, float R, int axis, float v) {
        double ang = Math.toRadians(-90 + axis * 72);
        return new float[]{cx + (float) Math.cos(ang) * R * v, cy + (float) Math.sin(ang) * R * v};
    }

    private void web(Canvas c, float cx, float cy, float r) {
        poly.reset();
        for (int i = 0; i < 5; i++) {
            float[] p = pt(cx, cy, r, i, 1);
            if (i == 0) poly.moveTo(p[0], p[1]); else poly.lineTo(p[0], p[1]);
        }
        poly.close();
        c.drawPath(poly, scratch);
    }

    private void polygon(Canvas c, float cx, float cy, float R, float[] v, int color,
                         float enter, int gapAxis, Anim a) {
        poly.reset();
        for (int i = 0; i < 5; i++) {
            float[] p = pt(cx, cy, R, i, v[i] * enter);
            if (i == 0) poly.moveTo(p[0], p[1]); else poly.lineTo(p[0], p[1]);
        }
        poly.close();
        scratch.reset();
        scratch.setColor(color);
        scratch.setAlpha(41);
        c.drawPath(poly, scratch);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeJoin(Paint.Join.ROUND);
        scratch.setStrokeWidth(R * .019f);
        scratch.setColor(color);
        c.drawPath(poly, scratch);
        scratch.reset();
        scratch.setColor(color);
        for (int i = 0; i < 5; i++) {
            float[] p = pt(cx, cy, R, i, v[i] * enter);
            float r = R * .029f;
            if (i == gapAxis && !a.reducedMotion) {
                float t = (a.clock % 1200) / 1200f;
                r *= 1f + .35f * (float) Math.sin(t * Math.PI);
            }
            c.drawCircle(p[0], p[1], r, scratch);
        }
    }

    private void legend(Canvas c, float x, float y, float cq, int color, String label, Assets f) {
        scratch.reset();
        scratch.setColor(color);
        c.drawRoundRect(x, y - .8f * cq, x + cq, y + .2f * cq, .25f * cq, .25f * cq, scratch);
        c.drawText(label, x + 1.5f * cq, y, text(.8f * cq, f.sans, CAPTION, 0));
    }
}
