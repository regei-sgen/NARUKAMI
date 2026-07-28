package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.DashPathEffect;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * 16 · Areas — both dies on one plot with a real 30–100 °C scale, so the gap
 * between them is the first thing you see. Endpoint dots mark the live value;
 * six figures underneath state now / peak / load for each device.
 */
class AreasRenderer extends ThemeRenderer {

    private static final int BG = 0xFF0D1117, INK = 0xFFE6EDF3, BODY = 0xFFC9D1D9;
    private static final int AXIS = 0xFF8B949E, AXIS_DIM = 0xFF5A636D;
    private static final int GRID = 0xFF1C232C, GRID_TJ = 0xFF3B4551, RULE = 0xFF21262D;
    private static final int CPU = 0xFFE3A765, GPU = 0xFF7BC4A4;
    private static final int CPU_FILL = 0x6BE3A765, GPU_FILL = 0x617BC4A4;

    private final Path line = new Path(), area = new Path();

    @Override
    public String id() { return "areas"; }

    private final Critter critter = new Critter(Critter.CLOUD, Critter.EARS_NONE,
            Critter.EYE_GLOW, Critter.M_SPARK, 0xFF161B22, 0xFF30363D, 0xFF0D1117,
            0xFFE3A765, 0xFF7BC4A4, 0xFFE3A765, 0xFF7BC4A4, false, 0.85f, 0.72f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return AXIS; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.mono; }

    @Override
    protected int clockFill() { return 0xFF161B22; }

    @Override
    protected int clockStroke() { return 0xFF21262D; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(BG);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;

        float padX = 2.4f * cq, padY = 2 * cq, gap = cq;

        // header: title + legend
        float headY = padY + 1.2f * cq;
        c.drawText("Die temperature · live", padX, headY, text(1.3f * cq, f.sansMedium, INK, -.01f));
        Paint leg = text(.78f * cq, f.sans, AXIS, 0);
        String l1 = "CPU " + m.cpu.name, l2 = m.hasGpu ? "GPU " + m.gpu.name : "GPU —";
        float lx = w - padX - leg.measureText(l2);
        swatch(c, lx - 1.7f * cq, headY - .3f * cq, cq, GPU);
        c.drawText(l2, lx, headY, leg);
        lx -= leg.measureText(l1) + 4.4f * cq;
        swatch(c, lx - 1.7f * cq, headY - .3f * cq, cq, CPU);
        c.drawText(l1, lx, headY, leg);

        // footer: six figures over a hairline rule
        float footH = 3.4f * cq;
        float footTop = h - padY - footH;
        scratch.reset();
        scratch.setColor(RULE);
        c.drawRect(padX, footTop, w - padX, footTop + Math.max(1, cq * .06f), scratch);
        String cpuPeak = m.cpu.tempSeries.length > 0
                ? Math.round(Model.peak(m.cpu.tempSeries)) + " °C" : "—";
        String gpuPeak = m.gpu.tempSeries.length > 0
                ? Math.round(Model.peak(m.gpu.tempSeries)) + " °C" : "—";
        String[][] foot = {
                {"CPU NOW", m.cpu.tempC == null ? "—" : Math.round(m.cpu.tempC) + " °C", "a"},
                {"CPU PEAK", cpuPeak, "a"},
                {"CPU LOAD", m.cpu.loadText, ""},
                {"GPU NOW", m.gpu.tempC == null ? "—" : Math.round(m.gpu.tempC) + " °C", "b"},
                {"GPU PEAK", gpuPeak, "b"},
                {"GPU LOAD", m.gpu.loadText, ""},
        };
        float colW = (w - 2 * padX - 5 * 1.2f * cq) / 6;
        for (int i = 0; i < 6; i++) {
            float x = padX + i * (colW + 1.2f * cq);
            c.drawText(foot[i][0], x, footTop + 1.55f * cq, text(.66f * cq, f.sansMedium, AXIS, .24f));
            int vc = foot[i][2].equals("a") ? CPU : foot[i][2].equals("b") ? GPU : BODY;
            c.drawText(foot[i][1], x, footTop + 3.1f * cq, text(1.4f * cq, f.sansMedium, vc, 0));
        }

        // plot box — fixed reserves rather than the reference's proportional
        // margins: our plot is taller, and a proportional label zone leaves a
        // dead band between the axis and the footer
        float plotTop = headY + gap, plotBot = footTop - gap;
        float x0 = padX + 3.2f * cq, x1 = w - padX - .8f * cq;
        float y0 = plotTop + .7f * cq, y1 = plotBot - 2.4f * cq;

        // gridlines every 10 °C; the 100 line is Tj max, dashed
        Paint axisText = text(.9f * cq, f.mono, AXIS, 0);
        for (int v = 30; v <= 100; v += 10) {
            float y = Draw.y(v, y0, y1, 30, 100);
            scratch.reset();
            scratch.setStyle(Paint.Style.STROKE);
            scratch.setStrokeWidth(Math.max(1, cq * .06f));
            scratch.setColor(v == 100 ? GRID_TJ : GRID);
            if (v == 100) scratch.setPathEffect(new DashPathEffect(new float[]{5, 5}, 0));
            c.drawLine(x0, y, x1, y, scratch);
            rightText(c, String.valueOf(v), x0 - .8f * cq, y + .3f * cq, axisText);
        }
        rightText(c, "°C", x0 - .8f * cq, y1 + 1.6f * cq, text(.8f * cq, f.mono, AXIS_DIM, 0));

        // x ticks: sample age in seconds (2 s probe cadence). The first label
        // anchors left so it never collides with the °C caption; the live edge
        // always gets its "0s", right-anchored.
        int n = Math.max(m.cpu.tempSeries.length, m.gpu.tempSeries.length);
        if (n >= 2) {
            int step = Math.max(1, (n - 1) / 4);
            Paint tickText = text(.8f * cq, f.mono, AXIS_DIM, 0);
            for (int t = 0; t <= n - 1; t += step) {
                if (n - 1 - t < step) continue;   // the live edge draws its own 0s tick
                float x = x0 + (x1 - x0) * t / (n - 1);
                scratch.reset();
                scratch.setColor(GRID_TJ);
                scratch.setStrokeWidth(Math.max(1, cq * .06f));
                c.drawLine(x, y1, x, y1 + .5f * cq, scratch);
                String lab = (t - (n - 1)) * 2 + "s";
                float tx = t == 0 ? x : x - tickText.measureText(lab) / 2;
                c.drawText(lab, tx, y1 + 1.6f * cq, tickText);
            }
            float xe = x1;
            scratch.reset();
            scratch.setColor(GRID_TJ);
            scratch.setStrokeWidth(Math.max(1, cq * .06f));
            c.drawLine(xe, y1, xe, y1 + .5f * cq, scratch);
            rightText(c, "0s", xe, y1 + 1.6f * cq, tickText);
        }

        // the two series on one shared scale, entrance-clipped left → right
        int save = c.save();
        if (a.entrance < 1f) c.clipRect(x0, 0, x0 + (x1 - x0) * easeOut(a.entrance), h);
        drawSeries(c, a.cpuWave, x0, x1, y0, y1, CPU, CPU_FILL, cq, a);
        drawSeries(c, a.gpuWave, x0, x1, y0, y1, GPU, GPU_FILL, cq, a);
        c.restoreToCount(save);

        if (n < 2) {
            Paint wait = text(.9f * cq, f.mono, AXIS_DIM, .1f);
            String msg = "collecting history…";
            c.drawText(msg, (x0 + x1 - wait.measureText(msg)) / 2, (y0 + y1) / 2, wait);
        }

        scratch.reset();
        scratch.setColor(GRID_TJ);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        c.drawLine(x0, y1, x1, y1, scratch);
    }

    private void drawSeries(Canvas c, float[] vals, float x0, float x1, float y0, float y1,
                            int color, int fill, float cq, Anim a) {
        if (vals == null || vals.length < 2) return;
        RectF box = new RectF(x0, y0, x1, y1);
        Draw.wave(c, line, area, vals, box, 30, 100, color, fill, cq * .19f, scratch);
        // live endpoint: solid dot + the 1.5 s pulse ring
        float ly = Draw.y(vals[vals.length - 1], y0, y1, 30, 100);
        scratch.reset();
        scratch.setColor(color);
        c.drawCircle(x1, ly, cq * .36f, scratch);
        if (!a.reducedMotion) {
            float t = (a.clock % 1500) / 1500f;
            scratch.setStyle(Paint.Style.STROKE);
            scratch.setStrokeWidth(cq * .12f);
            scratch.setAlpha((int) (160 * (1 - t)));
            c.drawCircle(x1, ly, cq * (.36f + .5f * t), scratch);
        }
    }

    private void swatch(Canvas c, float x, float y, float cq, int color) {
        scratch.reset();
        scratch.setColor(color);
        c.drawRoundRect(x, y - .15f * cq, x + 1.2f * cq, y + .15f * cq, .15f * cq, .15f * cq, scratch);
    }
}
