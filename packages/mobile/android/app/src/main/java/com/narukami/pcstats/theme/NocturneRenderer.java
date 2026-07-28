package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * 14 · Nocturne — deep navy, capsule stats, very soft glow. The calm one:
 * colour only where it means something — a warm tint on the CPU die temp,
 * mint on the GPU's. The surface changes, never the number.
 */
class NocturneRenderer extends ThemeRenderer {

    private static final int INK = 0xFFEAF0FB, VAL = 0xFFEEF3FC, CAPTION = 0xFF6B7A97;
    private static final int CAP_BORDER = 0x24A0B9E1, ARC_TRACK = 0x29A0B9E1;
    private static final int PERIWINKLE = 0xFF8AA4D6;
    private static final int WARM_V = 0xFFECC199, WARM_FILL = 0xFFE0A878;
    private static final int WARM_BG = 0x24E0A878, WARM_BORDER = 0x42E0A878;
    private static final int MINT_V = 0xFFA5DCC4, MINT_FILL = 0xFF7EC4A8;
    private static final int MINT_BG = 0x217EC4A8, MINT_BORDER = 0x3D7EC4A8;

    @Override
    public String id() { return "nocturne"; }

    private final Critter critter = new Critter(Critter.BLOB, Critter.EARS_NONE,
            Critter.EYE_GLOW, Critter.M_MOON, 0xFF16203A, 0x3D8AA4D6, 0xFF121A2E,
            0xFF8AA4D6, 0xFF8AA4D6, 0xFFE0A878, 0xFF7EC4A8, false, 0.5f, 0.96f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return CAPTION; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.sansMedium; }

    @Override
    protected int clockFill() { return 0xFF16203A; }

    @Override
    protected int clockStroke() { return 0x24A0B9E1; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        scratch.reset();
        scratch.setShader(new LinearGradient(0, 0, 0, vh,
                0xFF0E1526, 0xFF0B1120, Shader.TileMode.CLAMP));
        c.drawRect(0, 0, vw, vh, scratch);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;

        int save = c.save();
        if (a.entrance < 1f) {                 // gentle fade-in, nothing slides
            p.reset();
            c.saveLayerAlpha(0, 0, w, h, (int) (255 * easeOut(a.entrance)));
        }

        float padX = 2.8f * cq, padY = 2.4f * cq, gap = 1.3f * cq;
        float topH = 1.6f * cq;
        float headY = padY + 1.1f * cq;
        Paint b = text(1.2f * cq, f.sansMedium, INK, .01f);
        c.drawText("Tonight's bench", padX, headY, b);
        float bw = b.measureText("Tonight's bench");
        c.drawText("QUIET RUN", padX + bw + 1.2f * cq, headY,
                text(.76f * cq, f.sansMedium, CAPTION, .3f));
        rightText(c, "DIE TEMP 30–100 °C", w - padX, headY,
                text(.76f * cq, f.sansMedium, CAPTION, .3f));

        float unitH = (h - 2 * padY - topH - 2 * gap) / 2;
        drawUnit(c, padX, padY + topH + gap, w - 2 * padX, unitH, cq,
                m.cpu, a, a.cpuLoad, a.cpuMem, true, f);
        drawUnit(c, padX, padY + topH + gap + unitH + gap, w - 2 * padX, unitH, cq,
                m.gpu, a, a.gpuLoad, a.gpuMem, false, f);

        c.restoreToCount(save);
    }

    private void drawUnit(Canvas c, float x, float y, float w, float unitH, float cq,
                          Model.Unit u, Anim a, float load, float mem, boolean isCpu, Assets f) {
        // identity column, 16cq
        float midY = y + unitH / 2;
        c.drawText(u.name, x, midY - .8f * cq, text(1.3f * cq, f.sansMedium, INK, 0));
        c.drawText(u.spec, x, midY + .35f * cq, text(.76f * cq, f.sans, CAPTION, 0));
        Paint tagP = text(.66f * cq, f.sansMedium, 0xFFA9BDE4, .24f);
        float tw = tagP.measureText(u.tag);
        RectF pill = new RectF(x, midY + 1.05f * cq, x + tw + 1.8f * cq, midY + 2.35f * cq);
        scratch.reset();
        scratch.setColor(0x248AA4D6);
        c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .05f));
        scratch.setColor(0x3D8AA4D6);
        c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, scratch);
        c.drawText(u.tag, pill.left + .9f * cq, pill.centerY() + .25f * cq, tagP);

        // three capsules: load · memory · die temp (the only tinted one)
        float capsX = x + 16 * cq + 2 * cq;
        float capsW = x + w - capsX;
        float capGap = 1.2f * cq, capW = (capsW - 2 * capGap) / 3;
        float capH = 6.9f * cq, capY = midY - capH / 2;
        float enter = easeOut(a.entrance);

        float tempFrac = Float.isNaN(isCpu ? a.cpuTemp : a.gpuTemp) ? 0
                : (isCpu ? a.cpuTemp : a.gpuTemp);
        String tempBig = u.tempC == null ? "—" : String.valueOf(Math.round(u.tempC));
        capsule(c, capsX, capY, capW, capH, cq, "LOAD",
                big(u.loadText), small(u.loadText), u.loadFrac != null, load * enter,
                0x0BFFFFFF, CAP_BORDER, VAL, PERIWINKLE, a, f);
        capsule(c, capsX + capW + capGap, capY, capW, capH, cq, u.memLabel,
                big(u.memText), small(u.memText), u.memFrac != null, mem * enter,
                0x0BFFFFFF, CAP_BORDER, VAL, PERIWINKLE, a, f);
        boolean tinted = u.tempC != null;
        capsule(c, capsX + 2 * (capW + capGap), capY, capW, capH, cq, "DIE TEMP",
                tempBig, u.tempC == null ? "" : "°C", tinted, tempFrac * enter,
                tinted ? (isCpu ? WARM_BG : MINT_BG) : 0x0BFFFFFF,
                tinted ? (isCpu ? WARM_BORDER : MINT_BORDER) : CAP_BORDER,
                tinted ? (isCpu ? WARM_V : MINT_V) : CAPTION,
                isCpu ? WARM_FILL : MINT_FILL, a, f);
    }

    private void capsule(Canvas c, float x, float y, float w, float h, float cq,
                         String label, String bigText, String smallText, boolean present,
                         float frac, int bg, int border, int valColor, int fill,
                         Anim a, Assets f) {
        RectF cap = new RectF(x, y, x + w, y + h);
        float r = 1.3f * cq;
        // the 8 s breathe: background alpha drifts .045 → .06, barely perceptible
        float breathe = a.reducedMotion ? 0
                : .15f * (.5f + .5f * (float) Math.sin(a.clock / 8000.0 * 2 * Math.PI));
        scratch.reset();
        scratch.setColor(bg);
        scratch.setAlpha(Math.min(255, (int) (((bg >>> 24) & 0xFF) * (1 + breathe))));
        c.drawRoundRect(cap, r, r, scratch);
        scratch.reset();
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .05f));
        scratch.setColor(border);
        c.drawRoundRect(cap, r, r, scratch);

        float px = x + 1.5f * cq;
        c.drawText(label, px, y + 1.2f * cq + .68f * cq,
                text(.68f * cq, f.sansMedium, CAPTION, .26f));
        Paint bigP = text(2.4f * cq, f.sansMedium, present ? valColor : CAPTION, -.03f);
        float bigY = y + 1.2f * cq + .68f * cq + .35f * cq + 2.4f * cq * .82f;
        c.drawText(bigText, px, bigY, bigP);
        if (!smallText.isEmpty()) {
            c.drawText(smallText, px + bigP.measureText(bigText) + .15f * cq, bigY,
                    text(.96f * cq, f.sans, CAPTION, 0));
        }
        RectF arc = new RectF(px, bigY + .8f * cq, x + w - 1.5f * cq, bigY + .8f * cq + .36f * cq);
        Draw.pillBar(c, arc, present ? frac : 0, ARC_TRACK, fill, fill, scratch);
    }

    /** "18.4/32G" → "18.4" ; "18%" → "18". */
    private static String big(String v) {
        int cut = v.indexOf('/');
        if (cut > 0) return v.substring(0, cut);
        return v.endsWith("%") ? v.substring(0, v.length() - 1) : v;
    }

    private static String small(String v) {
        int cut = v.indexOf('/');
        if (cut > 0) return v.substring(cut);
        return v.endsWith("%") ? "%" : "";
    }
}
