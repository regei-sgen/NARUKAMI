package com.narukami.pcstats;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The zoom clamp is pure, so it can be checked without inflating a view.
 * An unclamped pinch would let the panel be scaled to nothing or blown up far
 * past anything readable, with no way back except reinstalling.
 */
public class ZoomLayoutTest {

    @Test
    public void keepsScaleInsideTheSupportedRange() {
        assertEquals(1f, ZoomLayout.clampScale(1f), 0.0001f);
        assertEquals(ZoomLayout.MIN_SCALE, ZoomLayout.clampScale(0.01f), 0.0001f);
        assertEquals(ZoomLayout.MAX_SCALE, ZoomLayout.clampScale(99f), 0.0001f);
        assertEquals(ZoomLayout.MIN_SCALE, ZoomLayout.clampScale(-5f), 0.0001f);
    }

    @Test
    public void survivesNaNRatherThanFreezingTheView() {
        // A pinch that divides by zero yields NaN; a NaN scale makes the child
        // vanish permanently with no gesture able to restore it.
        assertEquals(1f, ZoomLayout.clampScale(Float.NaN), 0.0001f);
    }

    @Test
    public void steppingRepeatedlyStaysWithinBounds() {
        float s = 1f;
        for (int i = 0; i < 40; i++) s = ZoomLayout.clampScale(s * ZoomLayout.STEP);
        assertEquals(ZoomLayout.MAX_SCALE, s, 0.0001f);
        for (int i = 0; i < 80; i++) s = ZoomLayout.clampScale(s / ZoomLayout.STEP);
        assertEquals(ZoomLayout.MIN_SCALE, s, 0.0001f);
    }

    @Test
    public void scalesRealLayoutDimensions() {
        assertEquals(180, ZoomLayout.scaledPx(180, 1f));
        assertEquals(225, ZoomLayout.scaledPx(180, 1.25f));
        assertEquals(108, ZoomLayout.scaledPx(180, 0.6f));
    }

    @Test
    public void neverCollapsesASizeToNothing() {
        // A 1px divider or 4px bar scaled by 0.6 rounds to 1, not 0 — a zero
        // would make the layout look broken rather than merely smaller.
        assertEquals(1, ZoomLayout.scaledPx(1, 0.6f));
        assertTrue(ZoomLayout.scaledPx(4, MIN) >= 1);
    }

    @Test
    public void passesLayoutSentinelsThroughUntouched() {
        // MATCH_PARENT (-1) and WRAP_CONTENT (-2) must survive, or the panel
        // stops filling the width and stops reflowing.
        assertEquals(-1, ZoomLayout.scaledPx(-1, 2f));
        assertEquals(-2, ZoomLayout.scaledPx(-2, 2f));
        assertEquals(0, ZoomLayout.scaledPx(0, 2f));
    }

    @Test
    public void scalingIsReversibleFromTheCapturedBase() {
        // Applying from the ORIGINAL base each time means 1.0 restores the
        // designed layout exactly, with no compounding drift.
        int base = 180;
        int zoomed = ZoomLayout.scaledPx(base, 3f);
        assertEquals(540, zoomed);
        assertEquals(base, ZoomLayout.scaledPx(base, 1f));
    }

    private static final float MIN = ZoomLayout.MIN_SCALE;

    @Test
    public void rangeIsUsable() {
        assertTrue("must be able to shrink", ZoomLayout.MIN_SCALE < 1f);
        assertTrue("must be able to enlarge", ZoomLayout.MAX_SCALE > 1f);
        assertTrue("step must actually change the scale", ZoomLayout.STEP > 1f);
    }
}
