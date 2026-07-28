package com.narukami.pcstats.theme;

/**
 * The theme registry. "classic" is the app's original look (the UnitView
 * cards, untouched); everything else is a full-canvas renderer from the
 * design set. Order here is menu order — the spec's numbering.
 */
public final class Themes {

    public static final String CLASSIC = "classic";

    private static final String[] IDS = {CLASSIC,
            "phosphor", "blueprint", "aurora", "thermal", "nixie", "splitflap",
            "blocks", "isotope", "deck", "chrono", "cute", "redline", "servo",
            "nocturne", "iris", "areas", "donuts", "radar"};
    private static final String[] NAMES = {"Classic",
            "Phosphor", "Blueprint", "Aurora", "Thermal", "Nixie", "Splitflap",
            "Blocks", "Isotope", "Deck", "Chrono", "Cute", "Redline", "Servo",
            "Nocturne", "Iris", "Areas", "Donuts", "Radar"};

    private Themes() {}

    public static String[] ids() { return IDS.clone(); }

    public static String[] names() { return NAMES.clone(); }

    /** A fresh renderer for the id, or null for classic / anything unknown. */
    public static ThemeRenderer byId(String id) {
        switch (id == null ? CLASSIC : id) {
            case "phosphor": return new PhosphorRenderer();
            case "blueprint": return new BlueprintRenderer();
            case "aurora": return new AuroraRenderer();
            case "thermal": return new ThermalRenderer();
            case "nixie": return new NixieRenderer();
            case "splitflap": return new SplitflapRenderer();
            case "blocks": return new BlocksRenderer();
            case "isotope": return new IsotopeRenderer();
            case "deck": return new DeckRenderer();
            case "chrono": return new ChronoRenderer();
            case "cute": return new CuteRenderer();
            case "redline": return new RedlineRenderer();
            case "servo": return new ServoRenderer();
            case "nocturne": return new NocturneRenderer();
            case "iris": return new IrisRenderer();
            case "areas": return new AreasRenderer();
            case "donuts": return new DonutsRenderer();
            case "radar": return new RadarRenderer();
            default: return null;
        }
    }

    /** Valid stored ids only — a stale pref falls back to classic. */
    public static String normalise(String id) {
        for (String known : IDS) if (known.equals(id)) return id;
        return CLASSIC;
    }

    /**
     * Rail palette for a theme — {bg, ink, dim, accent} — or null for the
     * classic rail. Colours are the theme's own caption/value/signature tones,
     * so the bottom container reads as part of the card above it.
     */
    public static int[] railPalette(String id) {
        switch (normalise(id)) {
            case "phosphor": return new int[]{0xF20A0F0A, 0xFF7DFAA8, 0xFF639178, 0xFFFFC247};
            case "blueprint": return new int[]{0xFFECEEF1, 0xFF111820, 0xFF5B6472, 0xFF1F4FD8};
            case "aurora": return new int[]{0xF2101226, 0xFFE7E9F5, 0xFF8A90B8, 0xFFF4A03C};
            case "thermal": return new int[]{0xFF0A0A0C, 0xFFEFEAE4, 0xFF8A857E, 0xFFFFB02E};
            case "nixie": return new int[]{0xFF16110B, 0xFFD8C9A6, 0xFF8C7A55, 0xFFFF9A2E};
            case "splitflap": return new int[]{0xFF0C0C0D, 0xFFF2F2F0, 0xFF8D8D90, 0xFFFF8A1F};
            case "blocks": return new int[]{0xFFFFFFFF, 0xFF0B0B0B, 0xFF4A4A4A, 0xFFFF5C39};
            case "isotope": return new int[]{0xFFE9E7E2, 0xFF111111, 0xFF5C5952, 0xFFD7263D};
            case "deck": return new int[]{0xFF15171B, 0xFFCFD4DA, 0xFF7A828C, 0xFFFFB74D};
            case "chrono": return new int[]{0xFF131316, 0xFFEFE9DD, 0xFF8E887C, 0xFFC8A45C};
            case "cute": return new int[]{0xFFFFFDFA, 0xFF4A3F55, 0xFF9A8FA8, 0xFFFF9DB8};
            case "redline": return new int[]{0xFF0E0000, 0xFFFFD9D9, 0xFFC96B6B, 0xFFFF1E1E};
            case "servo": return new int[]{0xFF15171B, 0xFFE8EAED, 0xFF7F868F, 0xFFF2C200};
            case "nocturne": return new int[]{0xFF0E1526, 0xFFEAF0FB, 0xFF6B7A97, 0xFFECC199};
            case "iris": return new int[]{0xFF1D1929, 0xFFEFEAFF, 0xFF8D84AD, 0xFFB4A5E0};
            case "areas": return new int[]{0xFF0D1117, 0xFFE6EDF3, 0xFF8B949E, 0xFFE3A765};
            case "donuts": return new int[]{0xFF0F1220, 0xFFEAEEFB, 0xFF7A82A8, 0xFF8AA4D6};
            case "radar": return new int[]{0xFF0B0F14, 0xFFE8EEF4, 0xFF8B98A5, 0xFFE0A45F};
            default: return null;
        }
    }
}
