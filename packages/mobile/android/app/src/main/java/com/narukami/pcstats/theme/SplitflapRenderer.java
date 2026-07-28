package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * 06 · Splitflap — departure board. One board row per component with the
 * horizontal seam at 50 %, and a status pill that finishes the row as a
 * sentence. Boards are still between departures — no ambient motion.
 */
class SplitflapRenderer extends ThemeRenderer {

    private static final int FIELD = 0xFF0C0C0D, FLAP0 = 0xFF1A1A1D, SEAM = 0xFF0F0F11;
    private static final int INK = 0xFFF2F2F0, HEAD = 0xFF8D8D90;
    private static final int CPU_ROUTE = 0xFFFF8A1F, GPU_ROUTE = 0xFF37D67A;

    @Override
    public String id() { return "splitflap"; }

    private final Critter critter = new Critter(Critter.BOX, Critter.EARS_NONE,
            Critter.EYE_GLOW, Critter.M_SEAM, 0xFF1A1A1D, 0xFF2E2E32, 0xFF0F0F11,
            0xFFFF8A1F, 0xFFFF8A1F, 0xFFFF8A1F, 0xFF37D67A, false, 0.62f, 0.18f);

    @Override
    protected void pet(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        critter.draw(c, w, h, m, a, f);
    }

    @Override
    public android.graphics.RectF petBounds(float w, float h, Anim a) {
        return critter.bounds(w, h, a);
    }

    @Override
    protected int clockColor() { return HEAD; }

    @Override
    protected android.graphics.Typeface clockFace(Assets f) { return f.sans; }

    @Override
    protected int clockFill() { return 0xFF1A1A1D; }

    @Override
    protected int clockStroke() { return 0xFF26262A; }

    @Override
    protected float[] clockAnchor(float w, float h, float cq) {
        // top-right inside the first board — departure boards carry a clock
        return new float[]{w - 8f * cq, 7.4f * cq};
    }

    @Override
    public boolean ambient() { return false; }

    @Override
    protected void background(Canvas c, float vw, float vh, Anim a) {
        c.drawColor(FIELD);
    }

    @Override
    protected void content(Canvas c, float w, float h, Model m, Anim a, Assets f) {
        final float cq = w / 100f;
        float padX = 2.6f * cq, padY = 2.2f * cq, gap = .9f * cq;

        // column headers over a hairline
        float headY = padY + .8f * cq;
        Paint hp = text(.78f * cq, f.sans, HEAD, .34f);
        float[] cols = colX(padX, w - 2 * padX, cq);
        c.drawText("COMPONENT", cols[1], headY, hp);
        c.drawText("LOAD", cols[2], headY, hp);
        c.drawText("MEMORY", cols[3], headY, hp);
        c.drawText("DIE TEMP", cols[4], headY, hp);
        rightText(c, "STATUS", w - padX - cq, headY, hp);
        scratch.reset();
        scratch.setColor(0xFF26262A);
        c.drawRect(padX, headY + .7f * cq, w - padX, headY + .7f * cq + Math.max(1, cq * .06f), scratch);

        float top = headY + .7f * cq + gap;
        float rowH = (h - top - padY - gap) / 2;
        row(c, padX, top, w - 2 * padX, rowH, cq, m.cpu, true, a, f);
        row(c, padX, top + rowH + gap, w - 2 * padX, rowH, cq, m.gpu, false, a, f);
    }

    private float[] colX(float x, float w, float cq) {
        // 5cq badge · 22cq name · 1fr ×3 · 14cq status, gaps 1.2cq
        float gap = 1.2f * cq;
        float fr = (w - 5 * cq - 22 * cq - 14 * cq - 5 * gap) / 3;
        float c0 = x + cq;
        float c1 = c0 + 5 * cq + gap - cq;
        float c2 = c1 + 22 * cq + gap;
        float c3 = c2 + fr + gap;
        float c4 = c3 + fr + gap;
        return new float[]{c0, c1, c2, c3, c4, fr};
    }

    private void row(Canvas c, float x, float y, float w, float rowH, float cq,
                     Model.Unit u, boolean isCpu, Anim a, Assets f) {
        RectF board = new RectF(x, y, x + w, y + rowH);
        // flap body with the hard seam at 50 %
        scratch.reset();
        scratch.setShader(new LinearGradient(0, board.top, 0, board.bottom,
                new int[]{FLAP0, FLAP0, SEAM, SEAM, FLAP0, FLAP0},
                new float[]{0, .494f, .494f, .506f, .506f, 1}, Shader.TileMode.CLAMP));
        c.drawRoundRect(board, .5f * cq, .5f * cq, scratch);
        scratch.setShader(null);

        float[] cols = colX(x, w, cq);
        float midY = board.centerY();
        int route = isCpu ? CPU_ROUTE : GPU_ROUTE;

        // badge
        scratch.reset();
        scratch.setColor(route);
        c.drawCircle(cols[0] + 1.7f * cq, midY, 1.7f * cq, scratch);
        Paint bp = text(1.05f * cq, f.sansBold, FIELD, .02f);
        String letter = u.tag.isEmpty() ? "·" : u.tag.substring(0, 1);
        c.drawText(letter, cols[0] + 1.7f * cq - bp.measureText(letter) / 2, midY + .38f * cq, bp);

        // name (display face) + spec line — compact route name, shrunk to its
        // column so the scaled-up type can never spill into the LOAD cell
        String nm = u.name.toUpperCase().replace("INTEL CORE ", "");
        Paint np = text(2.3f * cq, f.condensedBold, INK, .02f);
        while (np.getTextSize() > 1.2f * cq && np.measureText(nm) > 21 * cq) {
            np.setTextSize(np.getTextSize() - cq * .1f);
        }
        c.drawText(nm, cols[1], midY + .2f * cq, np);
        c.drawText(u.spec.toUpperCase(), cols[1], midY + 1.5f * cq,
                text(.85f * cq, f.sans, 0xFF8C8C90, .14f));

        cell(c, cols[2], midY, cq, "LOAD", u.loadText, INK, f);
        cell(c, cols[3], midY, cq, u.memLabel, u.memText, INK, f);
        boolean warn = u.tempFrac != null && u.tempFrac >= .65f;
        int tempInk = u.tempFrac == null ? HEAD : warn ? CPU_ROUTE : GPU_ROUTE;
        cell(c, cols[4], midY, cq, "DIE TEMP", u.tempText, tempInk, f);

        // the status pill reads the row as a sentence
        Integer head = Model.headroomC(u.tjMaxC, u.tempC);
        String status;
        if (u.tempC == null) {
            status = "NO SENSOR";
        } else if (isCpu) {
            status = head != null ? head + "° HEADROOM" : "RUNNING";
        } else {
            String power = u.powerW == null ? "" : String.format(java.util.Locale.US, "%.1f W", u.powerW);
            String fan = u.fanPct != null && Math.round(u.fanPct) == 0 ? "FAN IDLE" : "";
            status = (power + (power.isEmpty() || fan.isEmpty() ? "" : " · ") + fan);
            if (status.isEmpty()) status = "WITHIN LIMITS";
        }
        int pillInk = warn ? CPU_ROUTE : GPU_ROUTE;
        Paint sp = text(.85f * cq, f.sansBold, pillInk, .22f);
        float pw = sp.measureText(status) + 2.2f * cq;
        RectF pill = new RectF(x + w - cq - pw, midY - 1.05f * cq, x + w - cq, midY + 1.05f * cq);
        scratch.reset();
        scratch.setColor(warn ? 0x1AFF8A1F : 0x1A37D67A);
        c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, scratch);
        scratch.setStyle(Paint.Style.STROKE);
        scratch.setStrokeWidth(Math.max(1, cq * .06f));
        scratch.setColor(warn ? 0x73FF8A1F : 0x6637D67A);
        c.drawRoundRect(pill, pill.height() / 2, pill.height() / 2, scratch);
        c.drawText(status, pill.left + 1.1f * cq, midY + .3f * cq, sp);
    }

    private void cell(Canvas c, float x, float midY, float cq, String label, String value,
                      int ink, Assets f) {
        c.drawText(label, x, midY - 1.3f * cq, text(.7f * cq, f.sans, HEAD, .3f));
        c.drawText(value, x, midY + 1.5f * cq, text(2.6f * cq, f.condensedBold, ink, .02f));
    }
}
