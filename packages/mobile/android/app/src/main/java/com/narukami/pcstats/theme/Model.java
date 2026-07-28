package com.narukami.pcstats.theme;

import com.narukami.pcstats.Stats;

import java.util.List;
import java.util.Locale;

/**
 * The view-model every theme renderer draws from — plain Java on purpose so the
 * mapping rules from the design spec are unit-testable on the JVM.
 *
 * Carries the spec's data-mapping law: everything thermal is a fraction of the
 * 30–100 °C scale, never the raw reading, and a missing sensor stays null so a
 * renderer can show "—" honestly instead of a fabricated zero.
 */
public class Model {

    /** The drawn temperature scale, shared with the desktop readout. */
    public static final double SCALE_LO = 30, SCALE_HI = 100;

    public static class Unit {
        public String tag = "";        // "CPU" / "GPU"
        public String name = "";       // "Intel Core i7-9750H"
        public String spec = "";       // "6C/12T · 2.59 GHz"
        public Double loadFrac;        // 0..1, null when unreported
        public String loadText = "—";
        public String memLabel = "MEMORY"; // "VRAM" on the GPU
        public Double memFrac;
        public String memText = "—";
        public Double tempC;           // null = no sensor
        public Double tempFrac;        // (t-30)/70 clamped, null with tempC
        public String tempText = "—";
        public String note = "";       // headroom / power chips / sensor note
        public Integer tjMaxC;
        public double[] tempSeries = new double[0];
        /** Extra readings some themes surface directly; null = unreported. */
        public Double powerW, powerLimitW, clockMHz, fanPct;
    }

    public final Unit cpu = new Unit();
    public final Unit gpu = new Unit();
    public boolean hasGpu;
    /** Non-null when the server is unreachable — themes must surface it. */
    public String error;

    // ── mapping rules (unit-tested) ─────────────────────────────────────────

    /** Temperature onto the 30–100 scale; the number every bar and dial uses. */
    public static double tempFrac(double c) {
        return clamp01((c - SCALE_LO) / (SCALE_HI - SCALE_LO));
    }

    public static double clamp01(double v) {
        return Math.max(0, Math.min(1, v));
    }

    /** Cells lit in a segmented meter: round(total × frac), spec rule. */
    public static int litCells(int total, Double frac) {
        if (frac == null) return 0;
        return (int) Math.round(total * clamp01(frac));
    }

    /** Whole degrees to Tj max, floored at zero. Null when either side is unknown. */
    public static Integer headroomC(Integer tjMaxC, Double tempC) {
        if (tjMaxC == null || tempC == null) return null;
        return (int) Math.max(0, Math.round(tjMaxC - tempC));
    }

    /** "72 → 92 °C" — the observed range caption on Aurora's strip. */
    public static String rangeLabel(double[] series) {
        if (series.length == 0) return "";
        double lo = series[0], hi = series[0];
        for (double v : series) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        return Math.round(lo) + " → " + Math.round(hi) + " °C";
    }

    public static double peak(double[] series) {
        double hi = Double.NEGATIVE_INFINITY;
        for (double v : series) hi = Math.max(hi, v);
        return hi;
    }

    /** "18.4/32G" — memory as used/total in GB, one decimal on the used side. */
    public static String memText(double usedMB, double totalMB) {
        return String.format(Locale.US, "%.1f/%.0fG", usedMB / 1024, totalMB / 1024);
    }

    public static String pctText(Double pct) {
        return pct == null ? "—" : Math.round(pct) + "%";
    }

    private static double[] toArray(List<Double> src) {
        double[] out = new double[src.size()];
        for (int i = 0; i < out.length; i++) {
            Double v = src.get(i);
            out[i] = v == null || v.isNaN() ? 0 : v;
        }
        return out;
    }

    // ── construction ────────────────────────────────────────────────────────

    /** Build the whole model from a parsed payload. Pure — safe to unit test. */
    public static Model from(Stats s) {
        Model m = new Model();

        m.cpu.tag = "CPU";
        m.cpu.name = s.shortCpuName();
        m.cpu.spec = (s.coreLabel().isEmpty() ? "" : s.coreLabel() + " · ")
                + String.format(Locale.US, "%.2f GHz", s.cpuSpeedMHz / 1000);
        m.cpu.loadFrac = clamp01(s.cpuLoadPct / 100);
        m.cpu.loadText = pctText(s.cpuLoadPct);
        m.cpu.memFrac = s.memTotalMB > 0 ? clamp01(s.memUsedMB / s.memTotalMB) : null;
        m.cpu.memText = s.memTotalMB > 0 ? memText(s.memUsedMB, s.memTotalMB) : "—";
        m.cpu.tjMaxC = s.cpuTjMaxC;
        m.cpu.clockMHz = s.cpuSpeedMHz > 0 ? s.cpuSpeedMHz : null;
        m.cpu.tempSeries = toArray(s.cpuTempSeries);
        if (s.cpuTempC != null) {
            m.cpu.tempC = s.cpuTempC;
            m.cpu.tempFrac = tempFrac(s.cpuTempC);
            m.cpu.tempText = Math.round(s.cpuTempC) + "°C";
            Integer head = headroomC(s.cpuTjMaxC, s.cpuTempC);
            m.cpu.note = head != null ? head + "°C of headroom" : s.cpuTempNote;
        } else {
            m.cpu.note = s.cpuTempNote.isEmpty() ? "no sensor" : s.cpuTempNote;
        }

        m.gpu.tag = "GPU";
        m.gpu.memLabel = "VRAM";
        m.hasGpu = s.gpu != null;
        if (s.gpu != null) {
            Stats.Gpu g = s.gpu;
            m.gpu.name = s.shortGpuName();
            StringBuilder spec = new StringBuilder();
            if (g.memTotalMB != null) spec.append(Math.round(g.memTotalMB / 1024)).append(" GB");
            if (g.clockMHz != null) {
                if (spec.length() > 0) spec.append(" · ");
                spec.append(Math.round(g.clockMHz)).append(" MHz");
            }
            if (g.powerW != null) {
                if (spec.length() > 0) spec.append(" · ");
                spec.append(String.format(Locale.US, "%.1f W", g.powerW));
            }
            m.gpu.spec = spec.toString();
            m.gpu.loadFrac = g.utilPct == null ? null : clamp01(g.utilPct / 100);
            m.gpu.loadText = pctText(g.utilPct);
            m.gpu.powerW = g.powerW;
            m.gpu.powerLimitW = g.powerLimitW;
            m.gpu.clockMHz = g.clockMHz;
            m.gpu.fanPct = g.fanPct;
            if (g.memUsedMB != null && g.memTotalMB != null && g.memTotalMB > 0) {
                m.gpu.memFrac = clamp01(g.memUsedMB / g.memTotalMB);
                m.gpu.memText = memText(g.memUsedMB, g.memTotalMB);
            }
            m.gpu.tempSeries = toArray(s.gpuTempSeries);
            if (g.tempC != null) {
                m.gpu.tempC = g.tempC;
                m.gpu.tempFrac = tempFrac(g.tempC);
                m.gpu.tempText = Math.round(g.tempC) + "°C";
            }
            StringBuilder note = new StringBuilder();
            note.append(g.powerW == null ? "W —"
                    : String.format(Locale.US, "%.1f W", g.powerW));
            note.append(" · ").append(g.clockMHz == null ? "clock —" : Math.round(g.clockMHz) + " MHz");
            note.append(" · ").append(g.fanPct == null ? "fan —"
                    : Math.round(g.fanPct) == 0 ? "fan idle" : "fan " + Math.round(g.fanPct) + "%");
            m.gpu.note = note.toString();
        } else {
            m.gpu.name = "no GPU telemetry";
        }
        return m;
    }
}
