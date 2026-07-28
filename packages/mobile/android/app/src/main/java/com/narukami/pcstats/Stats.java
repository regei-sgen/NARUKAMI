package com.narukami.pcstats;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The /api/pcstats payload, parsed into plain fields.
 *
 * Every reading is nullable on purpose: the PC reports "this machine has no
 * such sensor" (a missing CPU die temp, a card that doesn't publish fan speed)
 * and the UI must show that honestly rather than draw a zero.
 */
public class Stats {

    public static class Gpu {
        public String name = "";
        public Double tempC, utilPct, memUsedMB, memTotalMB, powerW, powerLimitW, clockMHz, fanPct;
    }

    public String host = "";
    public String platform = "";
    public String arch = "";

    public String cpuModel = "";
    public Integer cpuCores, cpuPhysicalCores, cpuTjMaxC;
    public double cpuSpeedMHz, cpuLoadPct;
    public Double cpuTempC;
    /** why the CPU temp is absent, or which provider supplied it */
    public String cpuTempNote = "";

    public double memUsedMB, memTotalMB;

    public Gpu gpu;
    public String gpuSource;

    public long uptimeSec;
    public Double diskFreeGB, diskTotalGB;
    public Integer batteryPct;
    public boolean batteryCharging;
    public String batteryLabel = "";

    public final List<Double> cpuTempSeries = new ArrayList<>();
    public final List<Double> gpuTempSeries = new ArrayList<>();

    private static Double optD(JSONObject o, String k) {
        return o == null || o.isNull(k) ? null : o.optDouble(k);
    }

    private static Integer optI(JSONObject o, String k) {
        return o == null || o.isNull(k) ? null : o.optInt(k);
    }

    private static void series(JSONObject o, String k, List<Double> out) {
        if (o == null) return;
        JSONArray a = o.optJSONArray(k);
        if (a == null) return;
        for (int i = 0; i < a.length(); i++) out.add(a.optDouble(i));
    }

    /** Parse a payload. Returns null only if the JSON itself is unusable. */
    public static Stats parse(String json) {
        try {
            JSONObject root = new JSONObject(json);
            Stats s = new Stats();

            JSONObject cpu = root.optJSONObject("cpu");
            if (cpu != null) {
                s.cpuModel = cpu.optString("model", "");
                s.cpuCores = optI(cpu, "cores");
                s.cpuPhysicalCores = optI(cpu, "physicalCores");
                s.cpuSpeedMHz = cpu.optDouble("speedMHz", 0);
                s.cpuLoadPct = cpu.optDouble("loadPct", 0);
                s.cpuTjMaxC = optI(cpu, "tjMaxC");
            }

            JSONObject mem = root.optJSONObject("mem");
            if (mem != null) {
                s.memUsedMB = mem.optDouble("usedMB", 0);
                s.memTotalMB = mem.optDouble("totalMB", 1);
            }

            JSONArray temps = root.optJSONArray("temps");
            if (temps != null) {
                for (int i = 0; i < temps.length(); i++) {
                    JSONObject t = temps.optJSONObject(i);
                    if (t == null) continue;
                    String label = t.optString("label", "");
                    if (label.startsWith("CPU")) {
                        s.cpuTempC = optD(t, "celsius");
                        s.cpuTempNote = t.optString("note", "");
                    }
                }
            }

            JSONArray gpus = root.optJSONArray("gpus");
            if (gpus != null && gpus.length() > 0) {
                JSONObject g = gpus.optJSONObject(0);
                Gpu gp = new Gpu();
                gp.name = g.optString("name", "");
                gp.tempC = optD(g, "tempC");
                gp.utilPct = optD(g, "utilPct");
                gp.memUsedMB = optD(g, "memUsedMB");
                gp.memTotalMB = optD(g, "memTotalMB");
                gp.powerW = optD(g, "powerW");
                gp.powerLimitW = optD(g, "powerLimitW");
                gp.clockMHz = optD(g, "clockMHz");
                gp.fanPct = optD(g, "fanPct");
                s.gpu = gp;
            }
            s.gpuSource = root.isNull("gpuSource") ? null : root.optString("gpuSource");

            JSONObject st = root.optJSONObject("status");
            if (st != null) {
                s.host = st.optString("hostname", "");
                s.platform = st.optString("platform", "");
                s.arch = st.optString("arch", "");
                s.uptimeSec = st.optLong("uptimeSec", 0);
                JSONObject d = st.optJSONObject("disk");
                if (d != null) {
                    s.diskFreeGB = optD(d, "freeGB");
                    s.diskTotalGB = optD(d, "totalGB");
                }
                JSONObject b = st.optJSONObject("battery");
                if (b != null) {
                    s.batteryPct = optI(b, "percent");
                    s.batteryCharging = b.optBoolean("charging", false);
                    s.batteryLabel = b.optString("label", "");
                }
            }

            JSONObject ser = root.optJSONObject("series");
            series(ser, "cpuTemp", s.cpuTempSeries);
            series(ser, "gpuTemp", s.gpuTempSeries);

            return s;
        } catch (Exception e) {
            return null;
        }
    }

    /** "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz" -> "Intel Core i7-9750H". */
    public String shortCpuName() {
        return cpuModel.replaceAll("\\((R|TM)\\)", "").replaceAll("\\s*CPU\\s*@.*$", "")
                .replaceAll("\\s+", " ").trim();
    }

    public String coreLabel() {
        if (cpuPhysicalCores != null && cpuCores != null) return cpuPhysicalCores + "C/" + cpuCores + "T";
        return cpuCores == null ? "" : cpuCores + "T";
    }

    public String shortGpuName() {
        if (gpu == null) return "";
        return gpu.name.replace("NVIDIA GeForce ", "").replace(" with Max-Q Design", " Max-Q");
    }

    /** "3h 52m" / "6d 10h" / "41m". */
    public static String uptime(long sec) {
        if (sec < 0) return "—";
        long d = sec / 86400, h = (sec % 86400) / 3600, m = (sec % 3600) / 60;
        if (d > 0) return d + "d " + h + "h";
        if (h > 0) return h + "h " + m + "m";
        return m + "m";
    }
}
