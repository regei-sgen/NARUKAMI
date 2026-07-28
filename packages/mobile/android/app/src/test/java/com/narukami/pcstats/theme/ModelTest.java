package com.narukami.pcstats.theme;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.narukami.pcstats.Stats;

import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * The design spec's data-mapping rules, pinned. The reference numbers come
 * straight from the spec document: CPU 77 °C → 67 % of the 30–100 scale,
 * GPU 60 °C → 43 %, and every meter derives from those fractions.
 */
public class ModelTest {

    private static final double EPS = 0.005;

    @Test
    public void tempFracMatchesTheSpecReference() {
        assertEquals(0.67, Model.tempFrac(77), EPS);   // spec: "CPU 67 %"
        assertEquals(0.43, Model.tempFrac(60), EPS);   // spec: "GPU 43 %"
    }

    @Test
    public void tempFracClampsToTheDrawnScale() {
        assertEquals(0.0, Model.tempFrac(20), 0);      // below 30 °C
        assertEquals(1.0, Model.tempFrac(120), 0);     // above 100 °C
    }

    @Test
    public void litCellsRoundsLikeTheReferenceScript() {
        // round(28 × pct) — Phosphor's markup encodes load 18 % → data-seg 18
        assertEquals(5, Model.litCells(28, 0.18));     // 5.04 → 5
        assertEquals(16, Model.litCells(28, 0.575));   // 16.1 → 16
        assertEquals(28, Model.litCells(28, 1.0));
        assertEquals(0, Model.litCells(28, 0.0));
        assertEquals(0, Model.litCells(28, null));     // no sensor → nothing lit
    }

    @Test
    public void headroomFloorsAtZeroAndNeedsBothReadings() {
        assertEquals((Integer) 23, Model.headroomC(100, 77.0));
        assertEquals((Integer) 0, Model.headroomC(100, 104.0));
        assertNull(Model.headroomC(null, 77.0));
        assertNull(Model.headroomC(100, null));
    }

    @Test
    public void rangeLabelIsTheObservedSpan() {
        double[] cpu = {72, 72, 86, 79, 76, 92, 80, 84, 77};
        assertEquals("72 → 92 °C", Model.rangeLabel(cpu));  // Aurora's strip caption
        assertEquals("", Model.rangeLabel(new double[0]));
    }

    @Test
    public void peakFindsTheSeriesMaximum() {
        assertEquals(92.0, Model.peak(new double[]{72, 92, 77}), 0);
    }

    @Test
    public void memTextUsesGigabytesOneDecimalOverWhole() {
        assertEquals("18.4/32G", Model.memText(18841.6, 32768));
        assertEquals("1.8/8G", Model.memText(1843.2, 8192));
    }

    @Test
    public void modelFromSamplePayloadCarriesTheMappings() throws Exception {
        Stats s = Stats.parse(sampleJson());
        assertNotNull(s);
        Model m = Model.from(s);

        // fractions and text agree with the raw payload
        assertNotNull(m.cpu.loadFrac);
        assertTrue(m.cpu.loadFrac >= 0 && m.cpu.loadFrac <= 1);
        if (m.cpu.tempC != null) {
            assertNotNull(m.cpu.tempFrac);
            assertEquals(Model.tempFrac(m.cpu.tempC), m.cpu.tempFrac, 0);
            assertTrue(m.cpu.tempText.endsWith("°C"));
        }
        assertEquals("CPU", m.cpu.tag);
        assertEquals("GPU", m.gpu.tag);
        assertEquals("VRAM", m.gpu.memLabel);
        assertEquals(m.hasGpu, s.gpu != null);
        // series lengths survive the copy
        assertEquals(s.cpuTempSeries.size(), m.cpu.tempSeries.length);
        assertEquals(s.gpuTempSeries.size(), m.gpu.tempSeries.length);
    }

    @Test
    public void missingSensorStaysHonest() {
        Stats s = Stats.parse("{\"cpu\":{\"model\":\"X\",\"cores\":8,\"speedMHz\":3000,"
                + "\"loadPct\":10},\"mem\":{\"usedMB\":1024,\"totalMB\":2048},"
                + "\"status\":{\"hostname\":\"h\"}}");
        assertNotNull(s);
        Model m = Model.from(s);
        assertNull(m.cpu.tempC);
        assertNull(m.cpu.tempFrac);
        assertEquals("—", m.cpu.tempText);
        assertEquals("no sensor", m.cpu.note);
        assertEquals("no GPU telemetry", m.gpu.name);
        assertEquals("—", m.gpu.loadText);
    }

    private static String sampleJson() throws Exception {
        try (InputStream in = ModelTest.class.getClassLoader()
                .getResourceAsStream("pcstats-sample.json")) {
            assertNotNull("test resource pcstats-sample.json missing", in);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
