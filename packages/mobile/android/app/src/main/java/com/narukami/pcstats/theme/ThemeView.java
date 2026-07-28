package com.narukami.pcstats.theme;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.AttributeSet;
import android.view.View;

import com.narukami.pcstats.R;

/**
 * Hosts the active theme renderer: one full-readout canvas at the reference
 * card's exact proportions (2560 × 1187 — every dimension is a fraction of
 * width, so zooming just scales the card).
 *
 * Owns the motion system's data layer: values ease toward each poll instead of
 * snapping, entrance runs once per theme switch, and the ambient clock ticks
 * at a deliberately low rate (a phone readout should sip, not gulp). All of it
 * collapses to a 120 ms-equivalent crossfade under reduced motion.
 */
public class ThemeView extends View {

    private static final float ASPECT = 1187f / 2560f;
    private static final int WAVE_POINTS = 64;
    private static final long ENTRANCE_MS = 700;
    private static final long AMBIENT_FRAME_MS = 66;   // ~15 fps is plenty for drift

    private ThemeRenderer renderer;
    private ThemeRenderer.Assets assets;
    private Model model;
    private String error;

    /** Fit-width baseline (the host's width) and the synced zoom factor. */
    private int baseWidth;
    /** Visible scroll-area height: the card grows to fill it (rail below the fold). */
    private int viewportHeight;
    private float zoom = 1f;

    private final ThemeRenderer.Anim anim = new ThemeRenderer.Anim();
    private final Paint overlay = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final android.graphics.RectF card = new android.graphics.RectF();

    // eased-toward targets
    private float gCpuLoad, gCpuMem, gCpuTemp = Float.NaN;
    private float gGpuLoad, gGpuMem, gGpuTemp = Float.NaN;
    private float[] gCpuWave, gGpuWave;
    private long entranceStart;
    private boolean animating;

    /** Last tap, for the pets: uptime millis (0 = never) and view coords. */
    private long pokeUptime;
    private float pokeViewX, pokeViewY;
    private android.view.GestureDetector taps;

    public ThemeView(Context c) { this(c, null); }

    public ThemeView(Context c, AttributeSet a) {
        super(c, a);
        taps = new android.view.GestureDetector(c,
                new android.view.GestureDetector.SimpleOnGestureListener() {
                    @Override
                    public boolean onDown(android.view.MotionEvent e) {
                        return true;   // claim the stream so taps arrive; scroll still intercepts
                    }

                    @Override
                    public boolean onSingleTapUp(android.view.MotionEvent e) {
                        pokeUptime = SystemClock.uptimeMillis();
                        pokeViewX = e.getX();
                        pokeViewY = e.getY();
                        performClick();
                        invalidate();
                        return true;
                    }
                });
    }

    /** Pet drag state: NORMALISED card fractions are the source of truth, so
     *  loading never depends on layout having happened yet. NaN = home spot. */
    private boolean draggingPet;
    private boolean petMoved;
    private float downX, downY;
    private float petNX = Float.NaN, petNY = Float.NaN;

    /** Idle-action scheduler: one random act roughly every three minutes. */
    private final java.util.Random rng = new java.util.Random();
    private int petAct = -1;
    private long petActStart, nextPetActAt;
    private float petActDur = 2200;
    private long petDemoMs;   // QA override for the interval; 0 = the real cadence

    /** User settings: master visibility, acts on/off, and act cadence. */
    private boolean petEnabled = true, petActsEnabled = true;
    private long actBaseMs = 150_000, actJitterMs = 60_000;

    public void setPetOptions(boolean enabled, boolean acts, long baseMs, long jitterMs) {
        petEnabled = enabled;
        petActsEnabled = acts;
        actBaseMs = baseMs;
        actJitterMs = jitterMs;
        if (!acts) petAct = -1;
        if (renderer != null) renderer.setPetVisible(enabled);
        nextPetActAt = 0;   // reschedule on the new cadence
        invalidate();
    }

    /** Send the current theme's pet back to its home spot. */
    public void resetPetPosition() {
        petNX = Float.NaN;
        petNY = Float.NaN;
        if (renderer != null) {
            getContext().getSharedPreferences("narukami", Context.MODE_PRIVATE).edit()
                    .remove("pet." + renderer.id() + ".x")
                    .remove("pet." + renderer.id() + ".y")
                    .apply();
        }
        invalidate();
    }

    public void setPetDemoSeconds(int s) {
        petDemoMs = s * 1000L;
        nextPetActAt = SystemClock.uptimeMillis() + petDemoMs;
    }

    /** QA: start a specific act right now (and again every 6 s). */
    public void forcePetAct(int idx) {
        petAct = Math.max(0, Math.min(4, idx));
        petActStart = SystemClock.uptimeMillis() + 800;   // let the first frame settle
        petActDur = 2600;
        petDemoMs = 6000;
        invalidate();
    }

    private void scheduleNextPetAct(long now) {
        nextPetActAt = now + (petDemoMs > 0 ? petDemoMs
                : actBaseMs + rng.nextInt((int) actJitterMs));   // jittered, feels unscripted
    }

    @Override
    public boolean onTouchEvent(android.view.MotionEvent ev) {
        int base = baseWidth > 0 ? baseWidth : getWidth();
        float cl = cardLeft(base, zoom);
        float cw = cardWidth(base, zoom);
        float ch = cardHeight(base, zoom, viewportHeight);
        float cardX = ev.getX() - cl, cardY = ev.getY();

        switch (ev.getActionMasked()) {
            case android.view.MotionEvent.ACTION_DOWN:
                if (renderer != null && petEnabled) {
                    anim.petX = Float.isNaN(petNX) ? Float.NaN : petNX * cw;
                    anim.petY = Float.isNaN(petNY) ? Float.NaN : petNY * ch;
                    android.graphics.RectF b = renderer.petBounds(cw, ch, anim);
                    if (b != null && b.contains(cardX, cardY)) {
                        draggingPet = true;
                        petMoved = false;
                        downX = ev.getX();
                        downY = ev.getY();
                        // the pet owns this gesture — no scrolling underneath it
                        if (getParent() != null) {
                            getParent().requestDisallowInterceptTouchEvent(true);
                        }
                    }
                }
                break;
            case android.view.MotionEvent.ACTION_MOVE:
                if (draggingPet) {
                    // a press only becomes a CARRY once it clears touch slop —
                    // otherwise it stays a poke-in-waiting
                    if (!petMoved) {
                        float slop = android.view.ViewConfiguration.get(getContext())
                                .getScaledTouchSlop();
                        petMoved = Math.hypot(ev.getX() - downX, ev.getY() - downY) > slop;
                    }
                    if (petMoved) {
                        petNX = Math.max(.04f, Math.min(.96f, cardX / cw));
                        petNY = Math.max(.06f, Math.min(.96f, cardY / ch));
                        invalidate();
                    }
                    return true;
                }
                break;
            case android.view.MotionEvent.ACTION_UP:
            case android.view.MotionEvent.ACTION_CANCEL:
                if (draggingPet) {
                    draggingPet = false;
                    if (petMoved) {
                        persistPet();
                    } else {
                        // finger landed on the pet and stayed put: that's a poke
                        pokeUptime = SystemClock.uptimeMillis();
                        pokeViewX = ev.getX();
                        pokeViewY = ev.getY();
                        performClick();
                        invalidate();
                    }
                    return true;
                }
                break;
        }
        return taps.onTouchEvent(ev) || super.onTouchEvent(ev);
    }

    private void persistPet() {
        if (renderer == null || Float.isNaN(petNX)) return;
        getContext().getSharedPreferences("narukami", Context.MODE_PRIVATE).edit()
                .putFloat("pet." + renderer.id() + ".x", petNX)
                .putFloat("pet." + renderer.id() + ".y", petNY)
                .apply();
    }

    private void loadPet() {
        if (renderer == null) return;
        android.content.SharedPreferences p =
                getContext().getSharedPreferences("narukami", Context.MODE_PRIVATE);
        petNX = p.getFloat("pet." + renderer.id() + ".x", Float.NaN);
        petNY = p.getFloat("pet." + renderer.id() + ".y", Float.NaN);
    }

    @Override
    public boolean performClick() {
        return super.performClick();
    }

    public void setRenderer(ThemeRenderer r) {
        if (renderer != null && r != null && renderer.id().equals(r.id())) return;
        renderer = r;
        entranceStart = SystemClock.uptimeMillis();
        if (r != null) r.setPetVisible(petEnabled);
        loadPet();
        invalidate();
    }

    public String rendererId() {
        return renderer == null ? "" : renderer.id();
    }

    /** New payload: set easing goals; the frame loop moves the drawn values. */
    public void setModel(Model m) {
        model = m;
        error = null;
        gCpuLoad = frac(m.cpu.loadFrac);
        gCpuMem = frac(m.cpu.memFrac);
        gCpuTemp = m.cpu.tempFrac == null ? Float.NaN : m.cpu.tempFrac.floatValue();
        gGpuLoad = frac(m.gpu.loadFrac);
        gGpuMem = frac(m.gpu.memFrac);
        gGpuTemp = m.gpu.tempFrac == null ? Float.NaN : m.gpu.tempFrac.floatValue();
        gCpuWave = resample(m.cpu.tempSeries);
        gGpuWave = resample(m.gpu.tempSeries);
        kick();
    }

    /** Server unreachable — keep the last frame but say so, in the open. */
    public void setError(String message) {
        error = message;
        invalidate();
    }

    private static float frac(Double d) {
        return d == null ? 0f : (float) Model.clamp01(d);
    }

    /** Resample a history onto a fixed grid so polls of any length tween element-wise. */
    static float[] resample(double[] src) {
        if (src == null || src.length < 2) return null;
        float[] out = new float[WAVE_POINTS];
        for (int i = 0; i < WAVE_POINTS; i++) {
            float t = (float) i / (WAVE_POINTS - 1) * (src.length - 1);
            int lo = (int) Math.floor(t);
            int hi = Math.min(src.length - 1, lo + 1);
            out[i] = (float) (src[lo] + (src[hi] - src[lo]) * (t - lo));
        }
        return out;
    }

    private void kick() {
        if (!animating) {
            animating = true;
            postInvalidateOnAnimation();
        }
        invalidate();
    }

    /**
     * The same zoom the classic column gets from ZoomLayout. The card is
     * proportional to its own width, so scaling the width scales everything —
     * text, meters, traces — in one step. Overflow pans in the host scroller.
     */
    public void setZoom(float z) {
        float next = com.narukami.pcstats.ZoomLayout.clampScale(z);
        if (Math.abs(next - zoom) < 0.001f) return;
        zoom = next;
        requestLayout();
        invalidate();
    }

    /** The width the card fits at zoom 1 — the themed column's screen width. */
    public void setBaseWidth(int px) {
        if (px > 0 && px != baseWidth) {
            baseWidth = px;
            requestLayout();
        }
    }

    /** The height the card fills at zoom 1 — the visible scroll area. */
    public void setViewportHeight(int px) {
        if (px > 0 && px != viewportHeight) {
            viewportHeight = px;
            requestLayout();
        }
    }

    /** Drawn card width for a baseline and zoom. Pure — unit-tested. */
    static int cardWidth(int base, float zoom) {
        return Math.round(base * com.narukami.pcstats.ZoomLayout.clampScale(zoom));
    }

    /**
     * The view never narrows below the baseline: zoomed out, the card floats
     * centred on a full-width themed field instead of a cut-out. Pure.
     */
    static int viewWidth(int base, float zoom) {
        return Math.max(base, cardWidth(base, zoom));
    }

    /** Horizontal offset that centres a small card on the full-width field. Pure. */
    static float cardLeft(int base, float zoom) {
        return (viewWidth(base, zoom) - cardWidth(base, zoom)) / 2f;
    }

    /**
     * Drawn card height: the reference proportions are the MINIMUM, but on a
     * squarer screen (tablets) the card stretches to fill the whole viewport —
     * the instruments own the screen and the rail scrolls in from below. Pure.
     */
    static int cardHeight(int base, float zoom, int viewportH) {
        float scale = com.narukami.pcstats.ZoomLayout.clampScale(zoom);
        return Math.round(Math.max(cardWidth(base, zoom) * ASPECT, viewportH * scale));
    }

    /** How much taller than the reference proportions the card runs (≥ 1). Pure. */
    static float typeScale(float cardW, float cardH) {
        if (cardW <= 0) return 1f;
        return Math.max(1f, cardH / (cardW * ASPECT));
    }

    @Override
    protected void onMeasure(int wSpec, int hSpec) {
        // Inside a horizontal scroller the width spec is UNSPECIFIED, so the
        // card sizes itself from the captured baseline instead.
        int base = baseWidth > 0 ? baseWidth : MeasureSpec.getSize(wSpec);
        setMeasuredDimension(viewWidth(base, zoom),
                cardHeight(base, zoom, viewportHeight));
    }

    private boolean reducedMotion() {
        return Settings.Global.getFloat(getContext().getContentResolver(),
                Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f;
    }

    /** One easing step; true while something is still moving. */
    private boolean advance(float rate) {
        boolean moving = false;
        anim.cpuLoad = ease(anim.cpuLoad, gCpuLoad, rate);
        anim.cpuMem = ease(anim.cpuMem, gCpuMem, rate);
        anim.gpuLoad = ease(anim.gpuLoad, gGpuLoad, rate);
        anim.gpuMem = ease(anim.gpuMem, gGpuMem, rate);
        anim.cpuTemp = easeNaN(anim.cpuTemp, gCpuTemp, rate);
        anim.gpuTemp = easeNaN(anim.gpuTemp, gGpuTemp, rate);
        moving |= Math.abs(anim.cpuLoad - gCpuLoad) > .003f || Math.abs(anim.cpuMem - gCpuMem) > .003f
                || Math.abs(anim.gpuLoad - gGpuLoad) > .003f || Math.abs(anim.gpuMem - gGpuMem) > .003f;
        if (!Float.isNaN(gCpuTemp)) moving |= Math.abs(anim.cpuTemp - gCpuTemp) > .003f;
        if (!Float.isNaN(gGpuTemp)) moving |= Math.abs(anim.gpuTemp - gGpuTemp) > .003f;
        moving |= easeWaveInto(true, rate);
        moving |= easeWaveInto(false, rate);
        return moving;
    }

    private boolean easeWaveInto(boolean cpu, float rate) {
        float[] goal = cpu ? gCpuWave : gGpuWave;
        float[] cur = cpu ? anim.cpuWave : anim.gpuWave;
        if (goal == null) { if (cpu) anim.cpuWave = null; else anim.gpuWave = null; return false; }
        if (cur == null || cur.length != goal.length) {
            if (cpu) anim.cpuWave = goal.clone(); else anim.gpuWave = goal.clone();
            return false;
        }
        boolean moving = false;
        for (int i = 0; i < cur.length; i++) {
            float d = goal[i] - cur[i];
            if (Math.abs(d) > .02f) { cur[i] += d * rate; moving = true; }
            else cur[i] = goal[i];
        }
        return moving;
    }

    private static float ease(float cur, float goal, float rate) {
        float d = goal - cur;
        return Math.abs(d) > .002f ? cur + d * rate : goal;
    }

    private static float easeNaN(float cur, float goal, float rate) {
        if (Float.isNaN(goal)) return Float.NaN;
        if (Float.isNaN(cur)) return goal;
        return ease(cur, goal, rate);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        if (renderer == null) return;
        if (assets == null) assets = new ThemeRenderer.Assets(getContext());

        boolean reduced = reducedMotion();
        anim.reducedMotion = reduced;
        anim.clock = SystemClock.uptimeMillis() % 86_400_000L;
        anim.time = android.text.format.DateFormat.getTimeFormat(getContext())
                .format(new java.util.Date());
        anim.pokeAge = pokeUptime == 0 ? Float.MAX_VALUE
                : SystemClock.uptimeMillis() - pokeUptime;
        long sinceSwitch = SystemClock.uptimeMillis() - entranceStart;
        anim.entrance = reduced ? 1f : Math.min(1f, sinceSwitch / (float) ENTRANCE_MS);

        // reduced motion keeps the data layer but drops it to a fast catch-up
        boolean moving = advance(reduced ? .55f : .12f);

        Model m = model != null ? model : placeholder();
        int base = baseWidth > 0 ? baseWidth : getWidth();
        float cw = cardWidth(base, zoom), cl = cardLeft(base, zoom);
        card.set(cl, 0, cl + cw, cardHeight(base, zoom, viewportHeight));
        anim.pokeX = pokeViewX - cl;   // view coords → card coords for the pets
        anim.pokeY = pokeViewY;
        anim.petX = Float.isNaN(petNX) ? Float.NaN : petNX * cw;
        anim.petY = Float.isNaN(petNY) ? Float.NaN : petNY * card.height();
        anim.petDragging = draggingPet;

        // idle-action scheduler: fire a random act when its moment arrives
        long now = SystemClock.uptimeMillis();
        if (nextPetActAt == 0) scheduleNextPetAct(now);
        if (petEnabled && petActsEnabled
                && petAct < 0 && now >= nextPetActAt && !draggingPet && !reduced
                && renderer.petBounds(cw, card.height(), anim) != null) {
            petAct = rng.nextInt(5);
            petActStart = now;
            petActDur = 1800 + rng.nextInt(1400);
        }
        if (petAct >= 0) {
            float t = (now - petActStart) / petActDur;
            if (t >= 1f) {
                petAct = -1;
                scheduleNextPetAct(now);
                anim.petAct = -1;
            } else {
                anim.petAct = petAct;
                anim.petActT = Math.max(0f, t);   // forced acts may start slightly ahead
            }
        } else {
            anim.petAct = -1;
        }
        renderer.setTypeScale(typeScale(cw, card.height()));
        renderer.draw(canvas, getWidth(), getHeight(), card, m, anim, assets);

        if (error != null) drawError(canvas);

        boolean entering = anim.entrance < 1f;
        if (moving || entering) {
            postInvalidateOnAnimation();
        } else {
            animating = false;
            if (renderer.ambient() && !reduced && isAttachedToWindow()) {
                postInvalidateDelayed(AMBIENT_FRAME_MS);
            }
        }
    }

    private void drawError(Canvas c) {
        float cq = getWidth() / 100f;
        overlay.reset();
        overlay.setColor(0xB3000000);
        c.drawRect(0, 0, getWidth(), 3.2f * cq, overlay);
        overlay.setAntiAlias(true);
        overlay.setTypeface(getResources().getFont(R.font.jetbrains_mono_regular));
        overlay.setTextSize(1.1f * cq);
        overlay.setColor(0xFFFFC247);
        c.drawText(error, 3 * cq, 2.1f * cq, overlay);
    }

    /** Pre-first-poll model: structurally complete so no renderer trips on it. */
    private static Model placeholder() {
        Model m = new Model();
        m.cpu.tag = "CPU";
        m.cpu.name = "connecting…";
        m.gpu.tag = "GPU";
        m.gpu.name = "—";
        m.gpu.memLabel = "VRAM";
        return m;
    }

    @Override
    protected void onVisibilityChanged(View v, int visibility) {
        super.onVisibilityChanged(v, visibility);
        if (visibility == VISIBLE) invalidate();   // restart the ambient loop
    }
}
