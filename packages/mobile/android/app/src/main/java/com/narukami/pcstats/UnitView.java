package com.narukami.pcstats;

import android.content.Context;
import android.graphics.Color;
import android.util.AttributeSet;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.List;

/**
 * One instrument card (CPU or GPU): trace behind, readouts in front. Keeps its
 * own view lookups so the activity just feeds it values.
 */
public class UnitView extends FrameLayout {

    private TraceView trace;
    private TextView tag, part, ceil, dieTemp, dieNote;
    private TextView l1, v1, l2, v2;
    private ProgressBar b1, b2;

    public UnitView(Context c) { this(c, null); }

    public UnitView(Context c, AttributeSet a) {
        super(c, a);
        inflate(c, R.layout.view_unit, this);
        setBackgroundResource(R.drawable.card);
        setClipToOutline(true);

        trace = findViewById(R.id.trace);
        tag = findViewById(R.id.tag);
        part = findViewById(R.id.part);
        ceil = findViewById(R.id.ceil);
        dieTemp = findViewById(R.id.dieTemp);
        dieNote = findViewById(R.id.dieNote);

        android.view.View m1 = findViewById(R.id.m1);
        android.view.View m2 = findViewById(R.id.m2);
        l1 = m1.findViewById(R.id.mLabel);
        v1 = m1.findViewById(R.id.mValue);
        b1 = m1.findViewById(R.id.mBar);
        l2 = m2.findViewById(R.id.mLabel);
        v2 = m2.findViewById(R.id.mValue);
        b2 = m2.findViewById(R.id.mBar);
    }

    public void setHeader(String tagText, String partText, String ceilText) {
        tag.setText(tagText);
        part.setText(partText);
        ceil.setText(ceilText);
    }

    public void setMetrics(String label1, String value1, Double pct1,
                           String label2, String value2, Double pct2) {
        l1.setText(label1);
        v1.setText(value1);
        applyBar(b1, pct1);
        l2.setText(label2);
        v2.setText(value2);
        applyBar(b2, pct2);
    }

    private void applyBar(ProgressBar bar, Double pct) {
        if (pct == null) {
            bar.setProgress(0);
            return;
        }
        int p = (int) Math.round(Math.max(0, Math.min(1, pct)) * 100);
        bar.setProgress(p);
        // tint the fill with the same ramp the trace uses
        bar.getProgressDrawable().setTint(TraceView.ramp((float) (double) pct));
    }

    /**
     * The die temperature, lit in its own state colour. A null reading shows an
     * em dash plus the reason — never a fabricated zero.
     */
    public void setTemp(Double tempC, String note, List<Double> series) {
        if (tempC == null) {
            dieTemp.setText("—");
            dieTemp.setTextColor(Color.parseColor("#6E6860"));
        } else {
            int c = TraceView.ramp(TraceView.norm(tempC));
            dieTemp.setText(Math.round(tempC) + "°C");
            dieTemp.setTextColor(c);
            dieTemp.setShadowLayer(24f, 0, 0, c);
        }
        dieNote.setText(note == null ? "" : note);
        trace.setData(series, tempC);
    }
}
