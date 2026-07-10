---
name: app-motion
description: godsite's SCOPE-GATED app-interaction-motion skill (Motion, ex-Framer Motion). OPT-IN — does NOT auto-apply. Use ONLY after deployment-prep has chosen a React/SSR stack AND an interaction needs stateful/orchestrated motion that CSS and the View Transitions API cannot express (gesture drag, exit-on-unmount, shared-element layout across component state). For anything static, defer to design-system-quality + multipage-structure-routing. Use within godsite only when that gate is met.
---

# App motion (godsite) — stateful motion for React/app builds, scope-gated

This is the EXCEPTION in godsite's tight skill set. A JS animation runtime (**Motion**, formerly Framer
Motion) is heavy — the React `motion.*` import floors around **~34kb gzipped** — and fights godsite's
zero-JS-by-default budget. It earns its place ONLY for motion that CSS and the platform genuinely cannot
express, on a build that already ships React. **Default to NOT using it.**

## 0. Opening gate (FAIL-CLOSED — check this FIRST)
Do NOT activate unless **both** are true:
- **(a)** [`deployment-prep`](../deployment-prep/SKILL.md) §1 already chose a **React** app/SSR stack (Next /
  Remix / Astro + React islands / Gatsby) for a stated **app-like** workload — NOT a static / marketing /
  content build. This skill's API is **React-only** (`motion/react`, §2/§4); on a Svelte/Vue/vanilla stack it
  is OUT OF SCOPE — use §1's View-Transitions / CSS path instead; **and**
- **(b)** the interaction genuinely needs **stateful / orchestrated / interruptible** motion CSS + the
  platform cannot do: **gesture-driven drag**, **`AnimatePresence` exit-on-unmount**, or **shared-element
  `layout`/`layoutId`** across component state.

If either is false → **STOP and defer** (§1). Motion is **forbidden** on any route deployment-prep
classifies as content/marketing.

## 1. Defer first (the 80% case — don't reach for the library)
| Need | Use instead (0kb) | Owner |
|------|-------------------|-------|
| Hover / focus / tap micro-interaction | `--transition` token + `:hover` / `:focus-visible` | [`design-system-quality`](../design-system-quality/SKILL.md) |
| Page / route / shared-element transition | **View Transitions API** (`@view-transition` / `startViewTransition`) | [`multipage-structure-routing`](../multipage-structure-routing/SKILL.md) |
| Scroll-driven effect | CSS scroll-driven animations (`animation-timeline: view()` / `scroll()`) | [`responsive-layout`](../responsive-layout/SKILL.md) |
| Loading / empty / error state motion | skeleton + state design | [`design-system-quality`](../design-system-quality/SKILL.md) |
| Reduced-motion | the project-wide `prefers-reduced-motion` gate | (enforced everywhere) |

## 2. If the gate passes, ship it MINIMAL
- Library: **Motion** (npm `motion`, ex-`framer-motion`; import from `motion/react`). **Verify the current
  API + bundle sizes against motion.dev — don't recall them** (the library ships often).
- **Tree-shake or it's a budget failure:** import `{ LazyMotion, domAnimation }` + the `m` component.
  NEVER the bare `motion.*` import (~34kb floor). NEVER `domMax` (+~25kb) unless drag/layout is genuinely
  used; `AnimatePresence`/variants need `domAnimation` (+~15kb).
- **Animate transforms / opacity only** — never `width`/`height`/`top`/`background` (layout/paint jank).
  Mirrors [`asset-handling`](../asset-handling/SKILL.md)'s transform rule and the CWV levers.
- Reduced-motion: rely on the project-wide gate; in React use `useReducedMotion()` /
  `MotionConfig reducedMotion="user"`. For any **vanilla `animate()`** fallback, gate on
  `window.matchMedia('(prefers-reduced-motion: reduce)')` — vanilla Motion has **no** built-in reduced-motion.

## 3. Scope (the contract)
Motion appears ONLY on the authorized React/app-like routes, and ships **ZERO bytes** on content/marketing
routes. If it leaks onto a static route, that's a gate failure — remove it.

## 4. Verify (per the web-builder contract) — with a self-terminating rule
Render/measure, not prose. Cleared ONLY by artifacts produced THIS turn against the SERVED build:
- **Per-route JS-transfer-bytes** (network capture): Motion bytes attributed per route — present ONLY on
  authorized app routes, **0** on content/marketing; and the **`LazyMotion`+`m`+`domAnimation`** path landed,
  not the 34kb `motion.*` default. (Budget owned by [`deployment-prep`](../deployment-prep/SKILL.md).)
- **`prefers-reduced-motion` suppresses** the animation — asserted via `evaluate_script`, as
  [`multipage-structure-routing`](../multipage-structure-routing/SKILL.md) already does for View Transitions.
- **Clean CWV / TBT** lab run + long-tasks listing — no main-thread regression from the runtime.
- **JS-disabled degradation:** the interaction still functions, or its content stays reachable.

**Self-terminating rule:** if the scoped version cannot beat the CSS / platform baseline on a measured
artifact, **DROP the dependency** and use §1. "Imported Motion / wrapped it in `<m>`" is NOT proof.
