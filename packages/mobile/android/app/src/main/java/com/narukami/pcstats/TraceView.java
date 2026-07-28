package com.narukami.pcstats;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;

import java.util.List;

/**
 * The temperature trace behind a card: a filled area, a soft glow, and the line
 * itself — all tinted by how hot the part currently is.
 *
 * Mirrors the desktop panel exactly: the same 30-100 °C range and the same
 * cold-to-hot ramp, so the phone and the PC never disagree about what "hot"
 * looks like.
 */
public class TraceView extends View {

    private static final float LO = 30f, HI = 100f;

    private static final float[] STOPS = {0f, .30f, .52f, .72f, .88f, 1f};
    private static final int[] RAMP = {
            Color.rgb(36, 229, 142),   // green
            Color.rgb(156, 240, 60),   // lime
            Color.rgb(255, 212, 41),   // yellow
            Color.rgb(255, 158, 36),   // amber
            Color.rgb(255, 68, 56),    // red
            Color.rgb(255, 106, 85),   // coral
    };

    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint grid = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path linePath = new Path();
    private final Path areaPath = new Path();

    private List<Double> series;
    private Double current;

    public TraceView(Context c) { this(c, null); }

    public TraceView(Context c, AttributeSet a) {
        super(c, a);
        line.setStyle(Paint.Style.STROKE);
        line.setStrokeJoin(Paint.Join.ROUND);
        line.setStrokeCap(Paint.Cap.ROUND);
        glow.setStyle(Paint.Style.STROKE);
        glow.setStrokeJoin(Paint.Join.ROUND);
        fill.setStyle(Paint.Style.FILL);
        grid.setStyle(Paint.Style.STROKE);
        grid.setColor(Color.argb(20, 255, 255, 255));
        grid.setStrokeWidth(1f);
    }

    /** Interpolate the ramp at t (0..1). */
    public static int ramp(float t) {
        float x = Math.max(0f, Math.min(1f, Float.isNaN(t) ? 0f : t));
        for (int i = 0; i < STOPS.length - 1; i++) {
            if (x <= STOPS[i + 1]) {
                float k = (x - STOPS[i]) / (STOPS[i + 1] - STOPS[i]);
                int a = RAMP[i], b = RAMP[i + 1];
                return Color.rgb(
                        Math.round(Color.red(a) + (Color.red(b) - Color.red(a)) * k),
                        Math.round(Color.green(a) + (Color.green(b) - Color.green(a)) * k),
                        Math.round(Color.blue(a) + (Color.blue(b) - Color.blue(a)) * k));
            }
        }
        return RAMP[RAMP.length - 1];
    }

    /** Normalise a temperature onto the drawn range. */
    public static float norm(double c) {
        return (float) Math.max(0, Math.min(1, (c - LO) / (HI - LO)));
    }

    // ── smoothing + animation ───────────────────────────────────────────────

    /** Points the trace is drawn from right now; eased toward the target. */
    private float[] shown;
    private float[] goal;
    private float shownTemp = Float.NaN, goalTemp = Float.NaN;
    private boolean animating;

    /** Fixed point count so a growing history can be tweened element-wise. */
    private static final int POINTS = 72;

    /** Resample any series onto POINTS by linear interpolation. */
    private static float[] resample(List<Double> src) {
        float[] out = new float[POINTS];
        if (src == null || src.isEmpty()) return null;
        if (src.size() == 1) {
            java.util.Arrays.fill(out, src.get(0).floatValue());
            return out;
        }
        for (int i = 0; i < POINTS; i++) {
            float t = (float) i / (POINTS - 1) * (src.size() - 1);
            int lo = (int) Math.floor(t);
            int hi = Math.min(src.size() - 1, lo + 1);
            out[i] = (float) (src.get(lo) + (src.get(hi) - src.get(lo)) * (t - lo));
        }
        return out;
    }

    /**
     * Feed a new sample set. The view eases toward it over the following frames
     * rather than snapping, so a 2 s poll interval still reads as motion.
     */
    public void setData(List<Double> series, Double current) {
        this.series = series;
        this.current = current;
        goal = resample(series);
        goalTemp = current == null ? Float.NaN : current.floatValue();
        if (shown == null || goal == null || shown.length != goal.length) {
            shown = goal == null ? null : goal.clone();
            shownTemp = goalTemp;
        }
        if (!animating) {
            animating = true;
            postInvalidateOnAnimation();
        }
        invalidate();
    }

    /** One easing step; returns true while there is still motion to render. */
    private boolean advance() {
        boolean moving = false;
        if (goal != null && shown != null && shown.length == goal.length) {
            for (int i = 0; i < shown.length; i++) {
                float d = goal[i] - shown[i];
                if (Math.abs(d) > 0.01f) {
                    shown[i] += d * 0.12f;
                    moving = true;
                } else {
                    shown[i] = goal[i];
                }
            }
        }
        if (!Float.isNaN(goalTemp)) {
            if (Float.isNaN(shownTemp)) shownTemp = goalTemp;
            float d = goalTemp - shownTemp;
            if (Math.abs(d) > 0.02f) {
                shownTemp += d * 0.14f;
                moving = true;
            } else {
                shownTemp = goalTemp;
            }
        }
        return moving;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        final float w = getWidth(), h = getHeight();
        if (w <= 0 || h <= 0) return;

        // reference gridlines at 40/60/80 °C
        for (int v : new int[]{80, 60, 40}) {
            float y = h - norm(v) * (h - 6) - 3;
            canvas.drawLine(0, y, w, y, grid);
        }
        final boolean moving = advance();
        if (shown == null || shown.length < 2) {
            animating = false;
            return;
        }

        final int colour = ramp(Float.isNaN(shownTemp) ? 0 : norm(shownTemp));
        final int n = shown.length;
        final float step = w / (n - 1);

        // Point coordinates first, so the spline can look at neighbours.
        final float[] px = new float[n], py = new float[n];
        for (int i = 0; i < n; i++) {
            px[i] = i * step;
            py[i] = h - norm(shown[i]) * (h - 6) - 3;
        }

        linePath.reset();
        areaPath.reset();
        linePath.moveTo(px[0], py[0]);
        areaPath.moveTo(0, h);
        areaPath.lineTo(px[0], py[0]);
        for (int i = 0; i < n - 1; i++) {
            float p0x = i > 0 ? px[i - 1] : px[i], p0y = i > 0 ? py[i - 1] : py[i];
            float p3x = i + 2 < n ? px[i + 2] : px[i + 1], p3y = i + 2 < n ? py[i + 2] : py[i + 1];
            float c1x = px[i] + (px[i + 1] - p0x) / 6f;
            float c2x = px[i + 1] - (p3x - px[i]) / 6f;
            // Clamp vertical tangents to the segment: an unclamped spline
            // overshoots and would paint a temperature hotter than any sample.
            float lo = Math.min(py[i], py[i + 1]), hi = Math.max(py[i], py[i + 1]);
            float c1y = Math.max(lo, Math.min(hi, py[i] + (py[i + 1] - p0y) / 6f));
            float c2y = Math.max(lo, Math.min(hi, py[i + 1] - (p3y - py[i]) / 6f));
            linePath.cubicTo(c1x, c1y, c2x, c2y, px[i + 1], py[i + 1]);
            areaPath.cubicTo(c1x, c1y, c2x, c2y, px[i + 1], py[i + 1]);
        }
        areaPath.lineTo(w, h);
        areaPath.close();

        fill.setShader(new LinearGradient(0, 0, 0, h,
                new int[]{
                        Color.argb(138, Color.red(colour), Color.green(colour), Color.blue(colour)),
                        Color.argb(38, Color.red(colour), Color.green(colour), Color.blue(colour)),
                        Color.argb(0, Color.red(colour), Color.green(colour), Color.blue(colour)),
                },
                new float[]{0f, .6f, 1f}, Shader.TileMode.CLAMP));
        canvas.drawPath(areaPath, fill);

        glow.setColor(Color.argb(87, Color.red(colour), Color.green(colour), Color.blue(colour)));
        glow.setStrokeWidth(dp(7));
        canvas.drawPath(linePath, glow);

        line.setColor(colour);
        line.setStrokeWidth(dp(2f));
        canvas.drawPath(linePath, line);

        if (moving) postInvalidateOnAnimation();
        else animating = false;
    }

    private float dp(float v) {
        return v * getResources().getDisplayMetrics().density;
    }
}
