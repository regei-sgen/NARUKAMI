package com.narukami.pcstats.theme;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;

/**
 * The shared body plan behind most theme pets. One critter engine, themed by
 * a small spec — shape, ears, eye style, palette, home spot — so every theme's
 * resident speaks the same protocol: breathe/blink idle, poke reaction, red
 * mood when the CPU crowds Tj max, the five scheduled acts, and dragging.
 * Nixie's owl and Redline's bot remain hand-made.
 */
final class Critter {

    static final int ROUND = 0, BOX = 1, BLOB = 2, TRAP = 3, PENT = 4,
            CLOUD = 5, ELLIPSE = 6;
    static final int EARS_NONE = 0, TUFT = 1, ANTENNA = 2;
    static final int EYE_DOT = 0, EYE_GLOW = 1, EYE_RING = 2, EYE_VISOR = 3;
    /** Signature marking — what makes each theme's critter an individual. */
    static final int M_NONE = 0, M_SCAN = 1, M_RULER = 2, M_WISP = 3, M_EMBER = 4,
            M_SEAM = 5, M_TICKS = 6, M_VU = 7, M_CROWN = 8, M_BLUSH = 9,
            M_MOON = 10, M_CAPS = 11, M_SPARK = 12, M_SPRINKLE = 13,
            M_SWEEP = 14, M_STRIPE = 15;

    private final int shape, ears, eyes, motif;
    private final int body, stroke, belly, eye, eye2, eyeHot, accent;
    private final boolean hardShadow;
    private final float homeX, homeY;

    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

    Critter(int shape, int ears, int eyes, int motif, int body, int stroke, int belly,
            int eye, int eye2, int eyeHot, int accent, boolean hardShadow,
            float homeX, float homeY) {
        this.shape = shape;
        this.ears = ears;
        this.eyes = eyes;
        this.motif = motif;
        this.body = body;
        this.stroke = stroke;
        this.belly = belly;
        this.eye = eye;
        this.eye2 = eye2;
        this.eyeHot = eyeHot;
        this.accent = accent;
        this.hardShadow = hardShadow;
        this.homeX = homeX;
        this.homeY = homeY;
    }

    RectF bounds(float w, float h, ThemeRenderer.Anim a) {
        float cq = w / 100f, s = 1.8f * cq;
        float cx = Float.isNaN(a.petX) ? homeX * w : a.petX;
        float ground = Float.isNaN(a.petY) ? homeY * h : a.petY;
        return new RectF(cx - 2.2f * s, ground - 3f * s, cx + 2.2f * s, ground + .4f * s);
    }

    void draw(Canvas c, float w, float h, Model m, ThemeRenderer.Anim a,
              ThemeRenderer.Assets f) {
        float cq = w / 100f, s = 1.8f * cq;
        float cx = Float.isNaN(a.petX) ? homeX * w : a.petX;
        float ground = Float.isNaN(a.petY) ? homeY * h : a.petY;

        boolean poked = a.pokeAge < 800;
        boolean hot = m.cpu.tempFrac != null && m.cpu.tempFrac >= .8;
        int act = a.petAct;
        float at = a.petActT;
        float actS = act >= 0 ? (float) Math.sin(at * Math.PI) : 0;

        float hop = poked && !a.reducedMotion
                ? (float) Math.sin(a.pokeAge / 800f * Math.PI) * 1.1f * cq : 0;
        float breathe = a.reducedMotion ? 0
                : (float) Math.sin(a.clock / 3600.0 * 2 * Math.PI) * .018f * s;
        float baseY = ground - hop;

        // grounded contact shadow — drawn before any body transform, so hops
        // and carries visibly lift the pet OFF it
        p.reset();
        p.setAntiAlias(true);
        p.setShader(new android.graphics.RadialGradient(cx, ground + s * .04f, s * .95f,
                0x59000000, 0x00000000, android.graphics.Shader.TileMode.CLAMP));
        c.save();
        c.scale(1f, .22f, cx, ground + s * .04f);
        c.drawCircle(cx, ground + s * .04f, s * .95f, p);
        c.restore();
        p.setShader(null);

        int save = c.save();
        if (a.petDragging && !a.reducedMotion) {          // picked up: tilt + lift
            c.rotate(-5, cx, ground);
            c.translate(0, -.7f * cq);
        }
        if (poked && shape == BOX && !a.reducedMotion) {
            c.rotate((float) Math.sin(a.pokeAge / 55.0) * (1 - a.pokeAge / 800f) * 4, cx, ground);
        }
        if (act == 0) c.rotate(11 * actS, cx, baseY);                     // preen tilt
        if (act == 1) c.scale(1 + .08f * actS, 1 + .08f * actS, cx, baseY); // puff

        // limbs stretched out during act 2
        if (act == 2) {
            p.reset();
            p.setAntiAlias(true);
            p.setColor(body);
            float span = s * .95f * actS;
            RectF arm = new RectF(cx - s - span, baseY - s * 1.25f, cx - s * .55f, baseY - s * .85f);
            c.drawRoundRect(arm, s * .2f, s * .2f, p);
            arm.set(cx + s * .55f, baseY - s * 1.25f, cx + s + span, baseY - s * .85f);
            c.drawRoundRect(arm, s * .2f, s * .2f, p);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(Math.max(1.5f, cq * .08f));
            p.setColor(stroke);
            c.drawRoundRect(arm, s * .2f, s * .2f, p);
            arm.set(cx - s - span, baseY - s * 1.25f, cx - s * .55f, baseY - s * .85f);
            c.drawRoundRect(arm, s * .2f, s * .2f, p);
        }

        // poke squish for the soft shapes
        if (poked && (shape == BLOB || shape == ELLIPSE) && !a.reducedMotion) {
            float sq = (float) Math.sin(a.pokeAge / 800f * Math.PI) * .12f;
            c.scale(1 + sq, 1 - sq, cx, ground);
        }

        // body — seven plans, one protocol
        RectF bod;
        switch (shape) {
            case BLOB: bod = new RectF(cx - s * 1.1f, baseY - 1.7f * s - breathe, cx + s * 1.1f, baseY); break;
            case TRAP: bod = new RectF(cx - s * 1.15f, baseY - 1.9f * s - breathe, cx + s * 1.15f, baseY); break;
            case PENT: bod = new RectF(cx - s * 1.05f, baseY - 2.2f * s - breathe, cx + s * 1.05f, baseY); break;
            case CLOUD: bod = new RectF(cx - s * 1.25f, baseY - 2f * s - breathe, cx + s * 1.25f, baseY - s * .3f); break;
            case ELLIPSE: bod = new RectF(cx - s * 1.15f, baseY - 1.9f * s - breathe, cx + s * 1.15f, baseY); break;
            case BOX: bod = new RectF(cx - s, baseY - 1.8f * s - breathe, cx + s, baseY - s * .14f); break;
            default: bod = new RectF(cx - s, baseY - 2.05f * s - breathe, cx + s, baseY); break;
        }
        android.graphics.Path shapePath = bodyPath(bod, cx, s);
        p.reset();
        p.setAntiAlias(true);
        if (hardShadow) {
            p.setColor(stroke);
            c.save();
            c.translate(0, .3f * cq);
            c.drawPath(shapePath, p);
            c.restore();
        }
        p.setColor(body);
        c.drawPath(shapePath, p);
        // the light pass: top-left key light, bottom-right falloff, specular
        p.setShader(new android.graphics.LinearGradient(
                bod.left, bod.top, bod.right, bod.bottom,
                new int[]{0x3DFFFFFF, 0x00FFFFFF, 0x3D000000}, new float[]{0, .45f, 1},
                android.graphics.Shader.TileMode.CLAMP));
        c.drawPath(shapePath, p);
        p.setShader(new android.graphics.RadialGradient(
                bod.left + bod.width() * .3f, bod.top + bod.height() * .22f,
                bod.width() * .38f, 0x40FFFFFF, 0x00FFFFFF,
                android.graphics.Shader.TileMode.CLAMP));
        c.drawPath(shapePath, p);
        p.setShader(null);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeJoin(Paint.Join.ROUND);
        p.setStrokeWidth(Math.max(1.5f, cq * .09f));
        p.setColor(stroke);
        c.drawPath(shapePath, p);
        p.reset();
        p.setAntiAlias(true);
        RectF bel = new RectF(cx - s * .55f, baseY - s * .95f, cx + s * .55f, baseY - s * .2f);
        if (shape != BLOB && shape != CLOUD && shape != TRAP) {
            p.setColor(belly);
            c.drawRoundRect(bel, s * .45f, s * .45f, p);
        }

        drawMotif(c, cq, s, cx, baseY, bod, bel, a);

        // ears / antenna
        if (ears == TUFT) {
            float tuft = poked ? s * .46f : s * .3f;
            p.setColor(body);
            c.drawCircle(cx - s * .58f, bod.top + s * .08f - tuft * .35f, tuft, p);
            c.drawCircle(cx + s * .58f, bod.top + s * .08f - tuft * .35f, tuft, p);
        } else if (ears == ANTENNA) {
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(Math.max(1.5f, cq * .07f));
            p.setColor(stroke);
            c.drawLine(cx, bod.top, cx, bod.top - s * .45f, p);
            p.setStyle(Paint.Style.FILL);
            p.setColor(hot || act == 1 ? accent : stroke);
            c.drawCircle(cx, bod.top - s * .52f, s * .1f, p);
        }

        // eyes (left may differ from right — Areas' chart-legend heterochromia)
        float eyeY;
        switch (shape) {
            case BLOB: eyeY = bod.top + s * .62f; break;
            case TRAP: eyeY = bod.top + s * .68f; break;
            case PENT: eyeY = bod.top + bod.height() * .42f; break;
            case CLOUD: eyeY = bod.top + bod.height() * .55f; break;
            case ELLIPSE: eyeY = bod.top + s * .6f; break;
            case BOX: eyeY = bod.top + s * .55f; break;
            default: eyeY = bod.top + s * .72f; break;
        }
        int eyeCol = hot ? eyeHot : eye;
        int eyeCol2 = hot ? eyeHot : eye2;
        boolean blink = (!a.reducedMotion && !poked && (a.clock % 4300) < 130) || act == 4;
        float look = act == 3 ? (float) Math.sin(at * 3 * Math.PI) * s * .16f : 0;
        p.reset();
        p.setAntiAlias(true);
        if (eyes == EYE_VISOR) {
            p.setColor(0xE6000000 | (belly & 0xFFFFFF));
            RectF visor = new RectF(cx - s * .62f, eyeY - s * .2f, cx + s * .62f, eyeY + s * .2f);
            c.drawRoundRect(visor, s * .18f, s * .18f, p);
            float ex = act == 3 || act == 0 ? cx + look * 3
                    : cx + (a.reducedMotion ? 0
                    : (float) Math.sin(a.clock / 2400.0 * 2 * Math.PI) * s * .4f);
            p.setColor(poked ? 0xFFFFFFFF : eyeCol);
            if (act == 4) {
                c.drawRect(cx - s * .4f, eyeY - s * .03f, cx + s * .4f, eyeY + s * .03f, p);
            } else {
                p.setShadowLayer(s * .25f, 0, 0, eyeCol);
                c.drawCircle(ex, eyeY, s * .12f, p);
                p.clearShadowLayer();
            }
        } else if (blink) {
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(Math.max(1.5f, cq * .09f));
            p.setColor(eyeCol);
            c.drawLine(cx - s * .62f, eyeY, cx - s * .18f, eyeY, p);
            c.drawLine(cx + s * .18f, eyeY, cx + s * .62f, eyeY, p);
        } else {
            float er = s * (poked ? .3f : .22f);
            if (act == 0) er *= 1 - .3f * actS;
            if (eyes == EYE_RING) {
                p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(s * .1f);
            }
            p.setColor(eyeCol);
            if (eyes == EYE_GLOW && !a.reducedMotion) {
                p.setShadowLayer(er * (poked ? 1.6f : .9f), 0, 0, eyeCol);
            }
            c.drawCircle(cx - s * .42f + look, eyeY, er, p);
            if (eyeCol2 != eyeCol) {
                p.setColor(eyeCol2);
                if (eyes == EYE_GLOW && !a.reducedMotion) {
                    p.setShadowLayer(er * (poked ? 1.6f : .9f), 0, 0, eyeCol2);
                }
            }
            c.drawCircle(cx + s * .42f + look, eyeY, er, p);
            p.clearShadowLayer();
            if (eyes != EYE_RING) {                    // catchlights — the 3D tell
                p.setStyle(Paint.Style.FILL);
                p.setColor(0xC8FFFFFF);
                c.drawCircle(cx - s * .42f + look - er * .3f, eyeY - er * .32f, er * .3f, p);
                c.drawCircle(cx + s * .42f + look - er * .3f, eyeY - er * .32f, er * .3f, p);
            }
        }

        // feet — soft shapes skirt or hover instead
        p.reset();
        p.setAntiAlias(true);
        p.setColor(stroke);
        if (shape == BOX) {
            c.drawRect(cx - s * .5f, ground - s * .14f, cx - s * .22f, ground, p);
            c.drawRect(cx + s * .22f, ground - s * .14f, cx + s * .5f, ground, p);
        } else if (shape != BLOB && shape != CLOUD) {
            c.drawCircle(cx - s * .38f, ground, cq * .12f, p);
            c.drawCircle(cx + s * .38f, ground, cq * .12f, p);
        }

        // act extras: hoot/ping ripple · doze z's — and the startled "!"
        if (act == 1 && at > .25f) {
            float rt = (at - .25f) / .75f;
            p.reset();
            p.setAntiAlias(true);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(Math.max(1.5f, cq * .08f));
            p.setColor(accent);
            p.setAlpha((int) (210 * (1 - rt)));
            c.drawCircle(cx, eyeY, s * (.5f + rt * 1.8f), p);
        }
        if (act == 4) {
            p.reset();
            p.setAntiAlias(true);
            p.setTypeface(f.mono);
            p.setTextSize(.9f * cq);
            p.setColor(stroke);
            p.setAlpha((int) (255 * (1 - at)));
            c.drawText("z", cx + s * 1.1f, bod.top - at * 1.4f * cq, p);
            if (at > .35f) {
                p.setAlpha((int) (190 * (1 - at)));
                c.drawText("z", cx + s * 1.55f, bod.top - .7f * cq - at * 1.8f * cq, p);
            }
        }
        if (poked) {
            p.reset();
            p.setAntiAlias(true);
            p.setTypeface(f.sansBold);
            p.setTextSize(1.3f * cq);
            p.setColor(accent);
            p.setAlpha((int) (255 * (1 - a.pokeAge / 800f)));
            c.drawText("!", cx + s * 1.25f, bod.top - s * .3f, p);
        }
        c.restoreToCount(save);
    }

    /** Body outline for the current shape, anchored to its bounding box. */
    private android.graphics.Path bodyPath(RectF bod, float cx, float s) {
        android.graphics.Path path = new android.graphics.Path();
        switch (shape) {
            case BLOB: {                   // dome with a three-scallop skirt
                path.moveTo(bod.left, bod.bottom);
                path.arcTo(new RectF(bod.left, bod.top, bod.right,
                        bod.top + bod.height() * 1.35f), 180, 180);
                float seg = bod.width() / 3;
                for (int i = 0; i < 3; i++) {
                    path.arcTo(new RectF(bod.right - (i + 1) * seg, bod.bottom - s * .28f,
                            bod.right - i * seg, bod.bottom + s * .12f), 0, 180);
                }
                path.close();
                break;
            }
            case TRAP:                     // service trapezium, narrow shoulders
                path.moveTo(bod.left + bod.width() * .26f, bod.top);
                path.lineTo(bod.right - bod.width() * .26f, bod.top);
                path.lineTo(bod.right, bod.bottom);
                path.lineTo(bod.left, bod.bottom);
                path.close();
                break;
            case CLOUD: {                  // three bumps up top, soft base
                float bump = bod.height() * .52f;
                path.moveTo(bod.left + s * .2f, bod.bottom);
                path.arcTo(new RectF(bod.left, bod.top + bump * .55f,
                        bod.left + bump, bod.bottom), 150, 150);
                path.arcTo(new RectF(cx - bump * .75f, bod.top,
                        cx + bump * .75f, bod.top + bump * 1.5f), 200, 160);
                path.arcTo(new RectF(bod.right - bump, bod.top + bump * .55f,
                        bod.right, bod.bottom), 250, 150);
                path.close();
                break;
            }
            case PENT: {                   // flat-bottom pentagon, apex up
                float hw = bod.width() / 2, hh = bod.height() / 2;
                float cy = bod.centerY();
                path.moveTo(cx, bod.top);
                path.lineTo(cx + hw, cy - hh * .18f);
                path.lineTo(cx + hw * .62f, bod.bottom);
                path.lineTo(cx - hw * .62f, bod.bottom);
                path.lineTo(cx - hw, cy - hh * .18f);
                path.close();
                break;
            }
            case ELLIPSE:
                path.addOval(bod, android.graphics.Path.Direction.CW);
                break;
            case BOX:
                path.addRoundRect(bod, s * .24f, s * .24f, android.graphics.Path.Direction.CW);
                break;
            default:
                path.addRoundRect(bod, s, s, android.graphics.Path.Direction.CW);
                break;
        }
        return path;
    }

    /** The one marking that makes this critter THIS theme's critter. */
    private void drawMotif(Canvas c, float cq, float s, float cx, float baseY,
                           RectF bod, RectF bel, ThemeRenderer.Anim a) {
        p.reset();
        p.setAntiAlias(true);
        switch (motif) {
            case M_SCAN:                               // CRT stripes across the body
                p.setColor(0x33000000 | (accent & 0xFFFFFF));
                for (int i = 0; i < 4; i++) {
                    float y = bod.top + bod.height() * (.2f + i * .2f);
                    c.drawRect(bod.left + s * .15f, y, bod.right - s * .15f, y + s * .05f, p);
                }
                break;
            case M_RULER:                              // engineer's measure marks
                p.setColor(eye);
                for (int i = 0; i < 5; i++) {
                    float x = bel.left + bel.width() * i / 4f;
                    c.drawRect(x, bel.centerY() - s * (i % 2 == 0 ? .18f : .1f),
                            x + Math.max(1.5f, cq * .06f), bel.centerY() + s * .05f, p);
                }
                break;
            case M_WISP: {                             // aurora halo + trailing wisp
                p.setColor(accent);
                p.setAlpha(46);
                c.drawCircle(cx, bod.centerY(), s * 1.5f, p);
                p.setAlpha(80);
                float drift = a.reducedMotion ? 0
                        : (float) Math.sin(a.clock / 2800.0 * 2 * Math.PI) * s * .12f;
                c.drawCircle(bod.left - s * .35f, baseY - s * .3f + drift, s * .18f, p);
                break;
            }
            case M_EMBER:                              // heat motes rising off it
                p.setColor(accent);
                for (int i = 0; i < 3; i++) {
                    float t = a.reducedMotion ? .5f
                            : ((a.clock + i * 700) % 2100) / 2100f;
                    p.setAlpha((int) (170 * (1 - t)));
                    c.drawCircle(cx - s * .5f + i * s * .5f,
                            bod.top - s * .2f - t * s * 1.1f, s * .08f, p);
                }
                break;
            case M_SEAM:                               // split-flap face seam
                p.setColor(0xCC000000 | (belly & 0xFFFFFF));
                c.drawRect(bod.left, bod.centerY() - s * .03f, bod.right, bod.centerY() + s * .03f, p);
                break;
            case M_TICKS:                              // swiss tick chart belly
                p.setColor(eye);
                for (int i = 0; i < 5; i++) {
                    float x = bel.left + s * .12f + i * bel.width() / 5.4f;
                    float hgt = s * (.14f + (i * 37 % 3) * .1f);
                    p.setColor(i == 3 ? accent : eye);
                    c.drawRect(x, bel.bottom - s * .1f - hgt, x + s * .12f, bel.bottom - s * .1f, p);
                }
                break;
            case M_VU:                                 // little LED ladder chest
                for (int i = 0; i < 6; i++) {
                    p.setColor(i < 3 ? eye : (i < 5 ? accent : 0x40FFFFFF));
                    if (i >= (a.reducedMotion ? 3 : 3 + Math.round(
                            (float) Math.sin(a.clock / 1400.0 * 2 * Math.PI)))) {
                        p.setAlpha(70);
                    }
                    float x = bel.left + s * .08f + i * bel.width() / 6.4f;
                    c.drawRect(x, bel.centerY() - s * .1f, x + bel.width() / 8f,
                            bel.centerY() + s * .1f, p);
                }
                break;
            case M_CROWN:                              // pocket-watch crown on top
                p.setColor(stroke);
                c.drawRect(cx - s * .1f, bod.top - s * .28f, cx + s * .1f, bod.top, p);
                c.drawCircle(cx, bod.top - s * .34f, s * .14f, p);
                break;
            case M_BLUSH:                              // rosy cheeks
                p.setColor(accent);
                p.setAlpha(166);
                c.drawOval(new RectF(bod.left + s * .12f, bod.top + s * 1.05f,
                        bod.left + s * .5f, bod.top + s * 1.28f), p);
                c.drawOval(new RectF(bod.right - s * .5f, bod.top + s * 1.05f,
                        bod.right - s * .12f, bod.top + s * 1.28f), p);
                break;
            case M_MOON:                               // crescent on the belly
                p.setColor(eye);
                c.drawCircle(bel.centerX(), bel.centerY(), s * .28f, p);
                p.setColor(belly);
                c.drawCircle(bel.centerX() + s * .14f, bel.centerY() - s * .08f, s * .24f, p);
                break;
            case M_CAPS:                               // three capsule segments
                for (int i = 0; i < 3; i++) {
                    p.setColor(i == 1 ? accent : eye);
                    float x = bel.left + s * .12f + i * bel.width() / 3.2f;
                    c.drawRoundRect(x, bel.centerY() - s * .07f,
                            x + bel.width() / 4.2f, bel.centerY() + s * .07f, s * .07f, s * .07f, p);
                }
                break;
            case M_SPARK: {                            // a tiny chart lives on it
                p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(Math.max(1.5f, cq * .07f));
                p.setColor(eye);
                android.graphics.Path spark = new android.graphics.Path();
                float[] ys = {.3f, .0f, .45f, .15f, .5f};
                for (int i = 0; i < 5; i++) {
                    float x = bel.left + s * .1f + i * (bel.width() - s * .2f) / 4;
                    float y = bel.centerY() + s * (.2f - ys[i] * .5f);
                    if (i == 0) spark.moveTo(x, y); else spark.lineTo(x, y);
                }
                c.drawPath(spark, p);
                break;
            }
            case M_SPRINKLE: {                         // it is, itself, a donut
                int[] cols = {eye, accent, eyeHot, eye, accent};
                for (int i = 0; i < 5; i++) {
                    p.setColor(cols[i]);
                    float x = bod.left + s * .3f + (i * 53 % 100) / 100f * (bod.width() - s * .6f);
                    float y = bod.top + s * .25f + (i * 71 % 100) / 100f * (bod.height() * .45f);
                    c.save();
                    c.rotate(i * 40, x, y);
                    c.drawRoundRect(x - s * .1f, y - s * .035f, x + s * .1f, y + s * .035f,
                            s * .035f, s * .035f, p);
                    c.restore();
                }
                break;
            }
            case M_SWEEP: {                            // radar dish belly, live sweep
                p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(Math.max(1.5f, cq * .06f));
                p.setColor(eye);
                c.drawCircle(bel.centerX(), bel.centerY(), s * .3f, p);
                double ang = a.reducedMotion ? -1.2
                        : a.clock / 2400.0 * 2 * Math.PI;
                p.setColor(accent);
                c.drawLine(bel.centerX(), bel.centerY(),
                        bel.centerX() + (float) Math.cos(ang) * s * .3f,
                        bel.centerY() + (float) Math.sin(ang) * s * .3f, p);
                break;
            }
            case M_STRIPE:                             // service-bay hazard spine
                p.setColor(accent);
                c.drawRect(bod.left, bod.top + bod.height() * .25f,
                        bod.left + s * .12f, bod.top + bod.height() * .75f, p);
                break;
            default:
                break;
        }
    }
}
