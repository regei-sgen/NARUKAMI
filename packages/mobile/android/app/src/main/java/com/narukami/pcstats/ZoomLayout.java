package com.narukami.pcstats;

import android.content.Context;
import android.util.AttributeSet;
import android.util.TypedValue;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.util.HashMap;
import java.util.Map;

/**
 * Pinch-to-zoom that RE-LAYS-OUT the content instead of magnifying it.
 *
 * A plain scaleX/scaleY transform treats the panel as a fixed picture: zooming
 * in pushes content off-screen and forces panning, and zooming out just leaves
 * empty margins. Here the scale is applied to the real layout properties — text
 * sizes, card heights, padding and margins — and the tree is re-measured. The
 * panel therefore always fits the screen width: zooming out genuinely fits more
 * on screen, zooming in makes the figures bigger and the column simply gets
 * taller and scrolls.
 *
 * Base values are captured once, so repeated scaling never compounds rounding
 * error (scale 1.0 always restores exactly the designed layout).
 */
public class ZoomLayout extends FrameLayout {

    public static final float MIN_SCALE = 0.6f;
    public static final float MAX_SCALE = 3.0f;
    /** Ratio applied by the zoom in/out menu items. */
    public static final float STEP = 1.25f;

    private final ScaleGestureDetector detector;
    private float scale = 1f;
    private boolean captured;
    private Runnable onScaleChanged;

    private final Map<TextView, Float> baseTextPx = new HashMap<>();
    private final Map<View, int[]> basePadding = new HashMap<>();
    private final Map<View, int[]> baseMargins = new HashMap<>();
    private final Map<View, int[]> baseSize = new HashMap<>();

    public ZoomLayout(Context c) { this(c, null); }

    public ZoomLayout(Context c, AttributeSet a) {
        super(c, a);
        detector = new ScaleGestureDetector(c, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector d) {
                setScale(scale * d.getScaleFactor());
                return true;
            }
        });
    }

    /** Keep a requested scale inside the supported range. Pure. */
    public static float clampScale(float s) {
        if (Float.isNaN(s)) return 1f;
        return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
    }

    /**
     * Scale a pixel dimension. Never returns 0 for a previously non-zero value:
     * a padding or bar height that collapses to nothing at small scales makes
     * the layout look broken rather than small. Pure.
     */
    public static int scaledPx(int base, float scale) {
        if (base <= 0) return base; // 0, MATCH_PARENT (-1), WRAP_CONTENT (-2) pass through
        return Math.max(1, Math.round(base * scale));
    }

    public float getScale() {
        return scale;
    }

    public void setOnScaleChanged(Runnable r) {
        onScaleChanged = r;
    }

    public void setScale(float s) {
        float next = clampScale(s);
        if (Math.abs(next - scale) < 0.001f && captured) return;
        scale = next;
        applyScale();
        if (onScaleChanged != null) onScaleChanged.run();
    }

    public void zoomIn() { setScale(scale * STEP); }

    public void zoomOut() { setScale(scale / STEP); }

    public void resetZoom() { setScale(1f); }

    // ── capture / apply ─────────────────────────────────────────────────────

    private void capture(View v) {
        if (v instanceof TextView) {
            baseTextPx.put((TextView) v, ((TextView) v).getTextSize());
        }
        basePadding.put(v, new int[]{
                v.getPaddingLeft(), v.getPaddingTop(), v.getPaddingRight(), v.getPaddingBottom()});

        ViewGroup.LayoutParams lp = v.getLayoutParams();
        if (lp != null) {
            baseSize.put(v, new int[]{lp.width, lp.height});
            if (lp instanceof ViewGroup.MarginLayoutParams) {
                ViewGroup.MarginLayoutParams m = (ViewGroup.MarginLayoutParams) lp;
                baseMargins.put(v, new int[]{m.leftMargin, m.topMargin, m.rightMargin, m.bottomMargin});
            }
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) capture(g.getChildAt(i));
        }
    }

    private void applyTo(View v) {
        Float t = baseTextPx.get(v);
        if (t != null) {
            ((TextView) v).setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(1f, t * scale));
        }
        int[] p = basePadding.get(v);
        if (p != null) {
            v.setPadding(scaledPx(p[0], scale), scaledPx(p[1], scale),
                    scaledPx(p[2], scale), scaledPx(p[3], scale));
        }
        ViewGroup.LayoutParams lp = v.getLayoutParams();
        int[] s = baseSize.get(v);
        if (lp != null && s != null) {
            // MATCH_PARENT / WRAP_CONTENT are negative sentinels — leave them be
            // so the panel keeps filling the width and reflowing.
            if (s[0] > 0) lp.width = scaledPx(s[0], scale);
            if (s[1] > 0) lp.height = scaledPx(s[1], scale);
            int[] m = baseMargins.get(v);
            if (m != null && lp instanceof ViewGroup.MarginLayoutParams) {
                ((ViewGroup.MarginLayoutParams) lp).setMargins(
                        scaledPx(m[0], scale), scaledPx(m[1], scale),
                        scaledPx(m[2], scale), scaledPx(m[3], scale));
            }
            v.setLayoutParams(lp);
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) applyTo(g.getChildAt(i));
        }
    }

    private void applyScale() {
        View child = getChildCount() > 0 ? getChildAt(0) : null;
        if (child == null) return;
        if (!captured) {
            capture(child);
            captured = true;
        }
        applyTo(child);
        requestLayout();
        invalidate();
    }

    /**
     * Capture the designed sizes only once the tree has been laid out, so text
     * sizes read back as real pixels rather than zero.
     */
    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        post(() -> {
            if (!captured) applyScale();
        });
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent ev) {
        detector.onTouchEvent(ev);
        // Only take the gesture for a genuine two-finger pinch; single-finger
        // drags stay with the ScrollView so the panel still scrolls normally.
        return ev.getPointerCount() > 1;
    }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        detector.onTouchEvent(ev);
        return true;
    }
}
