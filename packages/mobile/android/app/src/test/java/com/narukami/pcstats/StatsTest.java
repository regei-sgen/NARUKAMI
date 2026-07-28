package com.narukami.pcstats;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;

/**
 * Parses a payload captured from the real machine, so the JSON contract between
 * the backend and the native app is verified rather than assumed.
 */
public class StatsTest {

    private static String sample() {
        InputStream in = StatsTest.class.getResourceAsStream("/pcstats-sample.json");
        assertNotNull("captured payload missing", in);
        try (Scanner s = new Scanner(in, StandardCharsets.UTF_8.name())) {
            return s.useDelimiter("\\A").next();
        }
    }

    @Test
    public void parsesTheRealPayload() {
        Stats s = Stats.parse(sample());
        assertNotNull("real payload must parse", s);

        assertEquals("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz", s.cpuModel);
        assertEquals(Integer.valueOf(12), s.cpuCores);
        assertEquals(Integer.valueOf(6), s.cpuPhysicalCores);
        assertEquals(Integer.valueOf(100), s.cpuTjMaxC);
        assertTrue(s.memTotalMB > 30000);
        assertTrue("cpu trace must have history", s.cpuTempSeries.size() > 2);
        assertNotNull("gpu should be present on this machine", s.gpu);
        assertEquals("nvidia-smi", s.gpuSource);
    }

    @Test
    public void formatsIdentityForTheHeader() {
        Stats s = Stats.parse(sample());
        assertEquals("Intel Core i7-9750H", s.shortCpuName());
        assertEquals("6C/12T", s.coreLabel());
        assertTrue(s.shortGpuName().contains("Max-Q"));
        // the full vendor boilerplate must not survive into the header
        assertTrue(!s.shortCpuName().contains("(R)"));
        assertTrue(!s.shortCpuName().contains("@"));
    }

    @Test
    public void keepsUnreportedSensorsNullRatherThanZero() {
        // fan speed is [N/A] on this card; a zero would read as "fan stopped"
        String json = "{\"gpus\":[{\"name\":\"X\",\"tempC\":56,\"fanPct\":null,\"powerLimitW\":null}]}";
        Stats s = Stats.parse(json);
        assertNotNull(s);
        assertNotNull(s.gpu);
        assertEquals(Double.valueOf(56), s.gpu.tempC);
        assertNull("fan must stay unknown", s.gpu.fanPct);
    }

    @Test
    public void carriesTheReasonWhenTheCpuHasNoSensor() {
        String json = "{\"temps\":[{\"label\":\"CPU\",\"celsius\":null,"
                + "\"note\":\"admin-gated sensor\"}]}";
        Stats s = Stats.parse(json);
        assertNotNull(s);
        assertNull(s.cpuTempC);
        assertEquals("admin-gated sensor", s.cpuTempNote);
    }

    @Test
    public void survivesGarbageInsteadOfCrashingTheApp() {
        assertNull(Stats.parse("not json"));
        assertNull(Stats.parse(""));
        // structurally valid but empty must yield a usable object, not a crash
        assertNotNull(Stats.parse("{}"));
    }

    @Test
    public void formatsUptime() {
        assertEquals("11h 41m", Stats.uptime(42060));
        assertEquals("2d 7h", Stats.uptime(200000));
        assertEquals("41m", Stats.uptime(2460));
        assertEquals("—", Stats.uptime(-1));
    }
}
