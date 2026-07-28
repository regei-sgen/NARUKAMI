package com.narukami.pcstats;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.Toast;

import com.narukami.pcstats.theme.Model;
import com.narukami.pcstats.theme.ThemeView;
import com.narukami.pcstats.theme.Themes;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * NARUKAMI PC Stats — a native readout.
 *
 * It talks to the PC's read-only stats server over plain HTTP+JSON and draws
 * everything with Android views and a Canvas trace: no WebView, no bundled web
 * assets. Landscape is the primary layout (see res/layout-land).
 *
 * Reaching the PC:
 *   Wi-Fi — http://&lt;pc-ip&gt;:4311 plus the token the PC prints.
 *   USB   — adb reverse tcp:4311 tcp:4311, then http://127.0.0.1:4311.
 * Either way the endpoint is the SAME read-only server, which exposes the stats
 * and nothing else.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "narukami";
    private static final String KEY_SERVER = "server";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_FULLSCREEN = "fullscreen";
    private static final String KEY_ZOOM = "zoom";
    private static final String KEY_THEME = "theme";
    private static final String KEY_PET = "pet.enabled";
    private static final String KEY_PET_ACTS = "pet.acts";
    private static final String KEY_PET_RATE = "pet.rate";
    private static final String DEFAULT_SERVER = "http://127.0.0.1:4311";
    private static final long POLL_MS = 2000;

    private UnitView cpuCard, gpuCard;
    private RailView rail;
    private ZoomLayout zoom;
    private ThemeView themeView;
    private View themeScroll;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Runnable ticker;
    private int ageSec = 0;
    private boolean fullscreen;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_main);

        cpuCard = findViewById(R.id.cpu);
        gpuCard = findViewById(R.id.gpu);
        rail = findViewById(R.id.rail);
        themeView = findViewById(R.id.themeView);
        themeScroll = findViewById(R.id.themeScroll);
        rail.setOnMenuClick(v -> showMenu(v));
        // Debug/QA hooks: `adb shell am start ... --es theme phosphor --ef zoom 1.6`
        // force a theme/zoom, so captures and tests need no scripted UI taps.
        // `--es server http://… --es token …` point a test device at a server
        // without walking through the dialog (same prefs the dialog writes).
        String forced = getIntent().getStringExtra("theme");
        if (forced != null) {
            prefs().edit().putString(KEY_THEME, Themes.normalise(forced)).apply();
        }
        String forcedServer = getIntent().getStringExtra("server");
        if (forcedServer != null && !forcedServer.isEmpty()) {
            prefs().edit().putString(KEY_SERVER, forcedServer.replaceAll("/+$", "")).apply();
        }
        String forcedToken = getIntent().getStringExtra("token");
        if (forcedToken != null) {
            prefs().edit().putString(KEY_TOKEN, forcedToken).apply();
        }
        float forcedZoom = getIntent().getFloatExtra("zoom", -1f);
        if (forcedZoom > 0) {
            prefs().edit().putFloat(KEY_ZOOM, ZoomLayout.clampScale(forcedZoom)).apply();
        }
        int panX = getIntent().getIntExtra("panx", -1);
        if (panX >= 0 && themeScroll != null) {
            themeScroll.postDelayed(() -> themeScroll.scrollTo(panX, 0), 500);
        }
        applyTheme(prefs().getString(KEY_THEME, Themes.CLASSIC));
        applyPetOptions();
        if (themeScroll != null && themeView != null) {
            // fit-width baseline follows the scroller's real width (rotation-safe)
            themeScroll.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or_, ob) ->
                    themeView.setBaseWidth(r - l));
            // fill-height baseline: the visible scroll area minus the column
            // padding — the card owns the screen, the rail scrolls in below
            View root = findViewById(R.id.root);
            if (root != null) {
                root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or_, ob) -> {
                    int pad = (int) (20 * getResources().getDisplayMetrics().density);
                    themeView.setViewportHeight(b - t - pad);
                });
            }
        }
        int petDemo = getIntent().getIntExtra("petdemo", -1);
        if (petDemo > 0 && themeView != null) {
            themeView.setPetDemoSeconds(petDemo);
        }
        int petAct = getIntent().getIntExtra("petact", -1);
        if (petAct >= 0 && themeView != null) {
            themeView.forcePetAct(petAct);
        }
        int panY = getIntent().getIntExtra("pany", -1);
        if (panY >= 0) {
            View root = findViewById(R.id.root);
            if (root != null) root.postDelayed(() -> root.scrollTo(0, panY), 600);
        }

        zoom = findViewById(R.id.zoom);
        if (zoom != null) {
            // Restore the last zoom AFTER layout, so panning has real bounds to
            // clamp against (a zero-sized child would clamp the pan to nothing).
            zoom.post(() -> zoom.setScale(prefs().getFloat(KEY_ZOOM, 1f)));
            zoom.setOnScaleChanged(() -> {
                prefs().edit().putFloat(KEY_ZOOM, zoom.getScale()).apply();
                // one zoom, both worlds: the themed card scales with the column
                if (themeView != null) themeView.setZoom(zoom.getScale());
            });
        }

        fullscreen = prefs().getBoolean(KEY_FULLSCREEN, false);
        applyFullscreen();

        cpuCard.setHeader("CPU", "connecting…", "");
        gpuCard.setHeader("GPU", "", "");
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private String server() {
        return prefs().getString(KEY_SERVER, DEFAULT_SERVER);
    }

    private String token() {
        return prefs().getString(KEY_TOKEN, "");
    }

    // ── pet settings ────────────────────────────────────────────────────────

    /** Push the persisted pet preferences into the theme view. */
    private void applyPetOptions() {
        if (themeView == null) return;
        String rate = prefs().getString(KEY_PET_RATE, "normal");
        long base, jitter;
        switch (rate) {
            case "frequent": base = 45_000; jitter = 30_000; break;
            case "rare": base = 480_000; jitter = 240_000; break;
            default: base = 150_000; jitter = 60_000; break;
        }
        themeView.setPetOptions(
                prefs().getBoolean(KEY_PET, true),
                prefs().getBoolean(KEY_PET_ACTS, true),
                base, jitter);
    }

    // ── themes ──────────────────────────────────────────────────────────────

    /** "classic" shows the original cards; anything else swaps in a ThemeView. */
    private void applyTheme(String id) {
        String theme = Themes.normalise(id);
        boolean classic = Themes.CLASSIC.equals(theme) || themeView == null;
        cpuCard.setVisibility(classic ? View.VISIBLE : View.GONE);
        gpuCard.setVisibility(classic ? View.VISIBLE : View.GONE);
        if (themeScroll != null) {
            themeScroll.setVisibility(classic ? View.GONE : View.VISIBLE);
        }
        if (themeView != null && !classic) {
            themeView.setRenderer(Themes.byId(theme));
            if (zoom != null) themeView.setZoom(zoom.getScale());
        }
        // the bottom container follows the theme too
        if (rail != null) rail.setPalette(Themes.railPalette(theme));
    }

    // ── polling ─────────────────────────────────────────────────────────────

    @Override
    protected void onResume() {
        super.onResume();
        ticker = new Runnable() {
            @Override
            public void run() {
                fetch();
                ui.postDelayed(this, POLL_MS);
            }
        };
        ui.post(ticker);
        // second-resolution "Ns ago" without hammering the network
        ui.postDelayed(secondTick, 1000);
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacksAndMessages(null);
    }

    private final Runnable secondTick = new Runnable() {
        @Override
        public void run() {
            ageSec++;
            ui.postDelayed(this, 1000);
        }
    };

    private void fetch() {
        final String base = server();
        final String tok = token();
        io.execute(() -> {
            String body = null;
            String error = null;
            HttpURLConnection conn = null;
            try {
                URL url = new URL(base + "/api/pcstats");
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(4000);
                conn.setRequestProperty("Accept", "application/json");
                if (!tok.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + tok);
                int code = conn.getResponseCode();
                if (code == 200) {
                    body = read(conn.getInputStream());
                } else if (code == 401) {
                    error = "401 — wrong or missing token";
                } else {
                    error = "HTTP " + code;
                }
            } catch (Exception e) {
                error = e.getClass().getSimpleName().replace("Exception", "");
            } finally {
                if (conn != null) conn.disconnect();
            }

            final Stats s = body == null ? null : Stats.parse(body);
            final String err = error;
            ui.post(() -> {
                if (s != null) {
                    ageSec = 0;
                    bind(s);
                } else {
                    cpuCard.setHeader("CPU", "can't reach " + base, err == null ? "" : err);
                    cpuCard.setTemp(null, err == null ? "no data" : err, null);
                    if (themeView != null) {
                        themeView.setError("can't reach " + base
                                + (err == null ? "" : " · " + err));
                    }
                }
            });
        });
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    // ── binding ─────────────────────────────────────────────────────────────

    private void bind(Stats s) {
        String tj = s.cpuTjMaxC == null ? "" : " · Tj max " + s.cpuTjMaxC;
        cpuCard.setHeader("CPU",
                s.shortCpuName() + " · " + s.coreLabel() + " · "
                        + String.format(java.util.Locale.US, "%.2f GHz", s.cpuSpeedMHz / 1000),
                "die temp · 30–100°C" + tj);
        cpuCard.setMetrics(
                "LOAD", Math.round(s.cpuLoadPct) + "%", s.cpuLoadPct / 100,
                "MEMORY", String.format(java.util.Locale.US, "%.1f/%.0fG",
                        s.memUsedMB / 1024, s.memTotalMB / 1024),
                s.memTotalMB > 0 ? s.memUsedMB / s.memTotalMB : null);
        String cpuNote;
        if (s.cpuTempC == null) {
            cpuNote = s.cpuTempNote.isEmpty() ? "no sensor" : s.cpuTempNote;
        } else if (s.cpuTjMaxC != null) {
            cpuNote = Math.max(0, Math.round(s.cpuTjMaxC - s.cpuTempC)) + "°C of headroom";
        } else {
            cpuNote = s.cpuTempNote;
        }
        cpuCard.setTemp(s.cpuTempC, cpuNote, s.cpuTempSeries);

        if (s.gpu == null) {
            gpuCard.setHeader("GPU", "no GPU telemetry available", "");
            gpuCard.setMetrics("LOAD", "—", null, "VRAM", "—", null);
            gpuCard.setTemp(null, "", null);
        } else {
            Stats.Gpu g = s.gpu;
            String vram = g.memTotalMB == null ? "" : " · " + Math.round(g.memTotalMB / 1024) + " GB";
            gpuCard.setHeader("GPU", s.shortGpuName() + vram, "die temp · 30–100°C");
            gpuCard.setMetrics(
                    "LOAD", g.utilPct == null ? "—" : Math.round(g.utilPct) + "%",
                    g.utilPct == null ? null : g.utilPct / 100,
                    "VRAM", g.memUsedMB == null ? "—"
                            : String.format(java.util.Locale.US, "%.1f/%.0fG",
                            g.memUsedMB / 1024, g.memTotalMB == null ? 0 : g.memTotalMB / 1024),
                    g.memUsedMB == null || g.memTotalMB == null || g.memTotalMB == 0
                            ? null : g.memUsedMB / g.memTotalMB);
            StringBuilder chips = new StringBuilder();
            chips.append(g.powerW == null ? "W —" : String.format(java.util.Locale.US, "%.1f W", g.powerW));
            chips.append("  ").append(g.clockMHz == null ? "clock —" : Math.round(g.clockMHz) + " MHz");
            chips.append("  ").append(g.fanPct == null ? "fan —" : "fan " + Math.round(g.fanPct) + "%");
            gpuCard.setTemp(g.tempC, chips.toString(), s.gpuTempSeries);
        }

        String conn = server().replaceAll("^https?://", "");
        rail.bind(s, conn.startsWith("127.0.0.1") ? "usb · " + conn : "wi-fi · " + conn, ageSec);

        if (themeView != null && themeScroll != null
                && themeScroll.getVisibility() == View.VISIBLE) {
            themeView.setModel(Model.from(s));
        }
    }

    // ── fullscreen ──────────────────────────────────────────────────────────

    /**
     * Immersive fullscreen: hide the status and navigation bars so the panel
     * owns the whole screen. A swipe from an edge brings them back temporarily,
     * which is what "sticky" behaviour gives us.
     */
    private void applyFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                if (fullscreen) {
                    c.hide(WindowInsets.Type.systemBars());
                    c.setSystemBarsBehavior(
                            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    c.show(WindowInsets.Type.systemBars());
                }
            }
        } else {
            View d = getWindow().getDecorView();
            d.setSystemUiVisibility(fullscreen
                    ? (View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
                    : View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    private void toggleFullscreen() {
        fullscreen = !fullscreen;
        prefs().edit().putBoolean(KEY_FULLSCREEN, fullscreen).apply();
        applyFullscreen();
        Toast.makeText(this, fullscreen ? "Fullscreen on — swipe an edge for the bars"
                : "Fullscreen off", Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        // Re-assert immersive mode: the system restores the bars after dialogs.
        if (has && fullscreen) applyFullscreen();
    }

    // ── menu / settings ─────────────────────────────────────────────────────

    private void showMenu(View anchor) {
        PopupMenu m = new PopupMenu(this, anchor);
        m.getMenu().add(0, 1, 0, fullscreen ? "Exit fullscreen" : "Fullscreen");
        m.getMenu().add(0, 5, 1, "Zoom in");
        m.getMenu().add(0, 6, 2, "Zoom out");
        m.getMenu().add(0, 7, 3, "Reset zoom");
        android.view.SubMenu themes = m.getMenu().addSubMenu(0, 8, 4, "Theme");
        String current = Themes.normalise(prefs().getString(KEY_THEME, Themes.CLASSIC));
        String[] ids = Themes.ids(), names = Themes.names();
        for (int i = 0; i < ids.length; i++) {
            themes.add(1, 100 + i, i, names[i] + (ids[i].equals(current) ? "   ✓" : ""));
        }
        android.view.SubMenu pet = m.getMenu().addSubMenu(0, 9, 5, "Pet");
        boolean petOn = prefs().getBoolean(KEY_PET, true);
        boolean actsOn = prefs().getBoolean(KEY_PET_ACTS, true);
        String rate = prefs().getString(KEY_PET_RATE, "normal");
        pet.add(2, 200, 0, "Show pet" + (petOn ? "   ✓" : ""));
        pet.add(2, 201, 1, "Idle actions" + (actsOn ? "   ✓" : ""));
        pet.add(2, 210, 2, "Act often (~1 min)" + ("frequent".equals(rate) ? "   ✓" : ""));
        pet.add(2, 211, 3, "Act normally (~3 min)" + ("normal".equals(rate) ? "   ✓" : ""));
        pet.add(2, 212, 4, "Act rarely (~10 min)" + ("rare".equals(rate) ? "   ✓" : ""));
        pet.add(2, 220, 5, "Send pet home (this theme)");
        pet.add(2, 221, 6, "Send all pets home");
        m.getMenu().add(0, 2, 6, "Set server…");
        m.getMenu().add(0, 3, 7, "Use USB default");
        m.getMenu().add(0, 4, 8, "Refresh now");
        m.setOnMenuItemClickListener(item -> {
            int id = item.getItemId();
            if (id >= 100 && id < 100 + ids.length) {
                prefs().edit().putString(KEY_THEME, ids[id - 100]).apply();
                applyTheme(ids[id - 100]);
                fetch();
                return true;
            }
            if (id >= 200 && id <= 221) {
                switch (id) {
                    case 200: prefs().edit().putBoolean(KEY_PET, !petOn).apply(); break;
                    case 201: prefs().edit().putBoolean(KEY_PET_ACTS, !actsOn).apply(); break;
                    case 210: prefs().edit().putString(KEY_PET_RATE, "frequent").apply(); break;
                    case 211: prefs().edit().putString(KEY_PET_RATE, "normal").apply(); break;
                    case 212: prefs().edit().putString(KEY_PET_RATE, "rare").apply(); break;
                    case 220: if (themeView != null) themeView.resetPetPosition(); break;
                    case 221:
                        android.content.SharedPreferences.Editor e = prefs().edit();
                        for (String t : Themes.ids()) {
                            e.remove("pet." + t + ".x").remove("pet." + t + ".y");
                        }
                        e.apply();
                        if (themeView != null) themeView.resetPetPosition();
                        break;
                }
                applyPetOptions();
                return true;
            }
            switch (id) {
                case 1: toggleFullscreen(); return true;
                case 2: showServerDialog(); return true;
                case 3:
                    prefs().edit().putString(KEY_SERVER, DEFAULT_SERVER).apply();
                    fetch();
                    return true;
                case 4: fetch(); return true;
                case 5: if (zoom != null) { zoom.zoomIn(); showZoom(); } return true;
                case 6: if (zoom != null) { zoom.zoomOut(); showZoom(); } return true;
                case 7: if (zoom != null) { zoom.resetZoom(); showZoom(); } return true;
                default: return false;
            }
        });
        m.show();
    }

    private void showZoom() {
        if (zoom == null) return;
        Toast.makeText(this, Math.round(zoom.getScale() * 100) + "%", Toast.LENGTH_SHORT).show();
    }

    private void showServerDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, 0);

        final EditText host = new EditText(this);
        host.setHint("http://192.168.1.15:4311");
        host.setSingleLine(true);
        host.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        host.setText(server());

        final EditText tok = new EditText(this);
        tok.setHint("token from the PC");
        tok.setSingleLine(true);
        tok.setText(token());

        box.addView(host);
        box.addView(tok);

        new AlertDialog.Builder(this)
                .setTitle("NARUKAMI server")
                .setMessage("Wi-Fi: turn on the phone server on the PC and enter the address "
                        + "and token it shows.\n\nUSB: run adb reverse tcp:4311 tcp:4311, "
                        + "then use the default address (the token is still required).")
                .setView(box)
                .setPositiveButton("Save", (d, w) -> {
                    String v = host.getText().toString().trim().replaceAll("/+$", "");
                    if (!v.isEmpty()) {
                        prefs().edit()
                                .putString(KEY_SERVER, v)
                                .putString(KEY_TOKEN, tok.getText().toString().trim())
                                .apply();
                        fetch();
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        io.shutdownNow();
    }
}
