package com.narukami.pcstats;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ProgressBar;
import android.widget.TextView;

/** The system rail: identity, storage / power / uptime, and source attribution. */
public class RailView extends FrameLayout {

    private final TextView host, stamp, sources;
    private final ImageButton menu;
    private final View storage, power, uptime, dot;

    public RailView(Context c) { this(c, null); }

    public RailView(Context c, AttributeSet a) {
        super(c, a);
        inflate(c, R.layout.view_rail, this);
        setBackgroundResource(R.drawable.card);
        host = findViewById(R.id.host);
        stamp = findViewById(R.id.stamp);
        sources = findViewById(R.id.sources);
        menu = findViewById(R.id.menu);
        storage = findViewById(R.id.rowStorage);
        power = findViewById(R.id.rowPower);
        uptime = findViewById(R.id.rowUptime);
        dot = findViewById(R.id.dot);
    }

    public void setOnMenuClick(OnClickListener l) {
        menu.setOnClickListener(l);
    }

    // ── theming ─────────────────────────────────────────────────────────────

    /**
     * Recolour the rail to the active theme: {bg, ink, dim, accent}, or null
     * to restore the classic look. Sizes never change — only colour, so the
     * zoom re-layout and the palette never fight over the same properties.
     */
    public void setPalette(int[] p) {
        if (p == null) {
            setBackgroundResource(R.drawable.card);
            applyColors(color(R.color.ink), color(R.color.dim), color(R.color.dimmer),
                    color(R.color.accent));
            menu.setColorFilter(null);
            return;
        }
        float d = getResources().getDisplayMetrics().density;
        android.graphics.drawable.GradientDrawable bg =
                new android.graphics.drawable.GradientDrawable();
        bg.setCornerRadius(14 * d);
        bg.setColor(p[0]);
        bg.setStroke(Math.max(1, Math.round(d)), 0x21FFFFFF);
        setBackground(bg);
        applyColors(p[1], p[2], 0xB3000000 | (p[2] & 0xFFFFFF), p[3]);
        menu.setColorFilter(p[2]);
    }

    private int color(int res) {
        return getResources().getColor(res, null);
    }

    private void applyColors(int ink, int dim, int dimmer, int accent) {
        host.setTextColor(ink);
        stamp.setTextColor(dimmer);
        sources.setTextColor(dimmer);
        if (dot.getBackground() != null) dot.getBackground().setTint(accent);
        for (View r : new View[]{storage, power, uptime}) {
            ((TextView) r.findViewById(R.id.rKey)).setTextColor(dim);
            ((TextView) r.findViewById(R.id.rValue)).setTextColor(ink);
            ((TextView) r.findViewById(R.id.rSub)).setTextColor(dimmer);
        }
    }

    private void row(View r, String key, String value, Double pct, String sub) {
        ((TextView) r.findViewById(R.id.rKey)).setText(key);
        ((TextView) r.findViewById(R.id.rValue)).setText(value);
        ((TextView) r.findViewById(R.id.rSub)).setText(sub);
        ProgressBar bar = r.findViewById(R.id.rBar);
        if (pct == null) {
            bar.setVisibility(GONE);
        } else {
            bar.setVisibility(VISIBLE);
            bar.setProgress((int) Math.round(Math.max(0, Math.min(1, pct)) * 100));
            bar.getProgressDrawable().setTint(TraceView.ramp((float) (double) pct));
        }
    }

    public void bind(Stats s, String connection, int ageSec) {
        host.setText(s.host.toUpperCase());
        stamp.setText(connection + " · " + ageSec + "s ago");

        if (s.diskFreeGB != null && s.diskTotalGB != null && s.diskTotalGB > 0) {
            double used = s.diskTotalGB - s.diskFreeGB;
            row(storage, "STORAGE", Math.round(s.diskFreeGB) + " G free", used / s.diskTotalGB,
                    Math.round(used) + " G used of " + Math.round(s.diskTotalGB) + " G · "
                            + Math.round(s.diskFreeGB / s.diskTotalGB * 100) + "% free");
            storage.setVisibility(VISIBLE);
        } else {
            storage.setVisibility(GONE);
        }

        if (s.batteryPct != null) {
            row(power, "POWER", s.batteryCharging ? "AC" : "BATT", s.batteryPct / 100.0,
                    "battery " + s.batteryPct + "% · " + s.batteryLabel);
        } else {
            row(power, "POWER", "AC", null, "no battery · on AC");
        }

        row(uptime, "UPTIME", Stats.uptime(s.uptimeSec), null,
                "up since boot");

        sources.setText(
                "cpu · " + (s.cpuTempC != null ? s.cpuTempNote.replace("via ", "") : "no sensor") + "\n"
                        + "gpu · " + (s.gpuSource == null ? "unavailable" : s.gpuSource) + "\n"
                        + "poll 2s · " + s.cpuTempSeries.size() + " samples");
    }
}
