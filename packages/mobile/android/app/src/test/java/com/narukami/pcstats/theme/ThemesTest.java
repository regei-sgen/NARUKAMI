package com.narukami.pcstats.theme;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashSet;

/**
 * Registry behaviour that must hold on the JVM. Renderer construction touches
 * android.graphics, so instantiation is exercised on-device; here we pin the
 * ids, the classic fallback, and the resampling the tween depends on.
 */
public class ThemesTest {

    @Test
    public void idsAndNamesStayPaired() {
        assertEquals(Themes.ids().length, Themes.names().length);
        assertEquals(new HashSet<>(java.util.Arrays.asList(Themes.ids())).size(),
                Themes.ids().length);   // no duplicate ids
    }

    @Test
    public void classicAndUnknownResolveToNoRenderer() {
        assertNull(Themes.byId(Themes.CLASSIC));
        assertNull(Themes.byId("does-not-exist"));
        assertNull(Themes.byId(null));
    }

    @Test
    public void stalePrefsNormaliseToClassic() {
        assertEquals(Themes.CLASSIC, Themes.normalise("vaporwave"));  // never shipped
        assertEquals(Themes.CLASSIC, Themes.normalise(null));
        assertEquals("phosphor", Themes.normalise("phosphor"));
        assertEquals("splitflap", Themes.normalise("splitflap"));     // shipped in the full set
        assertEquals("radar", Themes.normalise("radar"));
    }

    @Test
    public void allEighteenDesignsAreRegistered() {
        assertEquals(19, Themes.ids().length);   // classic + the 18 designs
    }

    @Test
    public void resampleKeepsEndpointsAndLength() {
        double[] src = {72, 92, 77};
        float[] out = ThemeView.resample(src);
        assertEquals(64, out.length);
        assertEquals(72f, out[0], 0.001f);
        assertEquals(77f, out[out.length - 1], 0.001f);
        for (float v : out) assertTrue(v >= 72 && v <= 92);  // stays within the data's span
    }

    @Test
    public void cardWidthScalesAndClampsWithTheColumnZoom() {
        assertEquals(1000, ThemeView.cardWidth(1000, 1f));
        assertEquals(1600, ThemeView.cardWidth(1000, 1.6f));
        assertEquals(600, ThemeView.cardWidth(1000, 0.6f));
        assertEquals(3000, ThemeView.cardWidth(1000, 99f));   // clamped to MAX_SCALE 3.0
        assertEquals(600, ThemeView.cardWidth(1000, 0.01f));  // clamped to MIN_SCALE 0.6
    }

    @Test
    public void viewNeverNarrowsBelowTheBaseline() {
        // zoomed out: full-width field, card centred inside it
        assertEquals(1000, ThemeView.viewWidth(1000, 0.8f));
        assertEquals(100f, ThemeView.cardLeft(1000, 0.8f), 0.5f);   // (1000-800)/2
        // zoomed in: view == card, no centring offset — the scroller pans
        assertEquals(1600, ThemeView.viewWidth(1000, 1.6f));
        assertEquals(0f, ThemeView.cardLeft(1000, 1.6f), 0f);
        // fit: exactly the baseline
        assertEquals(1000, ThemeView.viewWidth(1000, 1f));
        assertEquals(0f, ThemeView.cardLeft(1000, 1f), 0f);
    }

    @Test
    public void railPaletteCoversEveryThemeAndOnlyThemes() {
        assertNull(Themes.railPalette(Themes.CLASSIC));
        assertNull(Themes.railPalette("nope"));       // normalises to classic
        for (String id : Themes.ids()) {
            if (id.equals(Themes.CLASSIC)) continue;
            int[] p = Themes.railPalette(id);
            assertEquals("palette for " + id, 4, p.length);
        }
    }

    @Test
    public void cardFillsSquarerViewportsAndTypeScalesWithIt() {
        // phone-ish: viewport barely taller than the reference aspect
        assertEquals(1216, ThemeView.cardHeight(2494, 1f, 1216));
        // tablet: viewport much taller — the card stretches to fill it
        assertEquals(1400, ThemeView.cardHeight(2344, 1f, 1400));
        // reference aspect is the floor when the viewport is shorter
        assertEquals(Math.round(2494 * (1187f / 2560f)), ThemeView.cardHeight(2494, 1f, 800));
        // zoom scales the filled height proportionally
        assertEquals(Math.round(1400 * 1.6f), ThemeView.cardHeight(2344, 1.6f, 1400));
        // type grows with the extra height, never shrinks below 1
        assertEquals(1.288f, ThemeView.typeScale(2344, 1400), 0.01f);
        assertEquals(1f, ThemeView.typeScale(2494, 800), 0f);
    }

    @Test
    public void resampleRefusesUnusableHistories() {
        assertNull(ThemeView.resample(null));
        assertNull(ThemeView.resample(new double[0]));
        assertNull(ThemeView.resample(new double[]{60}));   // one sample is not a line
    }
}
