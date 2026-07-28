package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * The shared drawing primitives the design spec calls data-* attributes —
 * wave, seg, dial, area — expressed as Canvas calls. Each theme composes
 * these; none of them owns a palette.
 *
 * All geometry comes in already scaled (the renderer works in cq units,
 * 1 cq = 1% of card width, exactly the reference CSS's cqw).
 */
final class Draw {

    private Draw() {}

    /**
     * The reference smoothing: cubic segments whose control points sit at the
     * horizontal midpoint with flat tangents — no vertical overshoot, so the
     * plot can never show a temperature hotter than any sample.
     */
    static void spline(Path out, float[] vals, float x0, float x1, float yTop, float yBot,
                       float min, float max) {
        out.reset();
        int n = vals.length;
        if (n < 2) return;
        float dx = (x1 - x0) / (n - 1);
        out.moveTo(x0, y(vals[0], yTop, yBot, min, max));
        for (int i = 0; i < n - 1; i++) {
            float ax = x0 + i * dx, bx = x0 + (i + 1) * dx;
            float ay = y(vals[i], yTop, yBot, min, max), by = y(vals[i + 1], yTop, yBot, min, max);
            float mx = (ax + bx) / 2;
            out.cubicTo(mx, ay, mx, by, bx, by);
        }
    }

    static float y(float v, float yTop, float yBot, float min, float max) {
        float t = (v - min) / (max - min);
        return yBot - Math.max(0, Math.min(1, t)) * (yBot - yTop);
    }

    /**
     * Area + line sparkline the way every reference wave draws it: fill first
     * (vertical fade from fillColor to transparent), stroke on top.
     */
    static void wave(Canvas c, Path line, Path area, float[] vals, RectF box,
                     float min, float max, int strokeColor, int fillColor,
                     float strokeW, Paint scratch) {
        if (vals.length < 2) return;
        spline(line, vals, box.left, box.right, box.top, box.bottom, min, max);
        area.set(line);
        area.lineTo(box.right, box.bottom);
        area.lineTo(box.left, box.bottom);
        area.close();

        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStyle(Paint.Style.FILL);
        scratch.setShader(new LinearGradient(0, box.top, 0, box.bottom,
                fillColor, fillColor & 0x00FFFFFF, Shader.TileMode.CLAMP));
        c.drawPath(area, scratch);
        scratch.setShader(null);

        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(strokeW);
        scratch.setStrokeJoin(Paint.Join.ROUND);
        scratch.setColor(strokeColor);
        c.drawPath(line, scratch);
    }

    /** Block-segment meter: `lit` of `total` cells across `box` with `gap` between. */
    static void segMeter(Canvas c, RectF box, int total, int lit, float gap,
                         int unlit, int on, Paint scratch) {
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStyle(Paint.Style.FILL);
        float cell = (box.width() - gap * (total - 1)) / total;
        float r = Math.min(2f, cell / 4);
        for (int i = 0; i < total; i++) {
            float x = box.left + i * (cell + gap);
            scratch.setColor(i < lit ? on : unlit);
            c.drawRoundRect(x, box.top, x + cell, box.bottom, r, r, scratch);
        }
    }

    /**
     * The Aurora dial: a 274° arc opening downward, exactly the reference's
     * dasharray-on-rotate(133°) construction (sweep = .76 of the circle).
     */
    static void dial(Canvas c, float cx, float cy, float r, float frac, float strokeW,
                     int track, int color, Paint scratch) {
        final float START = 133f, SWEEP = 360f * .76f;
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeCap(Paint.Cap.ROUND);
        scratch.setStrokeWidth(strokeW);
        RectF oval = new RectF(cx - r, cy - r, cx + r, cy + r);
        scratch.setColor(track);
        c.drawArc(oval, START, SWEEP, false, scratch);
        if (frac > 0) {
            scratch.setColor(color);
            c.drawArc(oval, START, SWEEP * Math.max(0, Math.min(1, frac)), false, scratch);
        }
    }

    /** Pill progress bar with an optional horizontal gradient fill. */
    static void pillBar(Canvas c, RectF box, float frac, int track,
                        int fillFrom, int fillTo, Paint scratch) {
        scratch.reset();
        scratch.setAntiAlias(true);
        scratch.setStyle(Paint.Style.FILL);
        float r = box.height() / 2;
        scratch.setColor(track);
        c.drawRoundRect(box, r, r, scratch);
        if (frac <= 0) return;
        float w = Math.max(box.height(), box.width() * Math.min(1, frac));
        RectF fill = new RectF(box.left, box.top, box.left + w, box.bottom);
        // gradient across the FILL, not the track — the reference's 90deg
        // gradient lives on the fill element, so its bright end is always visible
        scratch.setShader(new LinearGradient(box.left, 0, fill.right, 0,
                fillFrom, fillTo, Shader.TileMode.CLAMP));
        c.drawRoundRect(fill, r, r, scratch);
        scratch.setShader(null);
    }
}
