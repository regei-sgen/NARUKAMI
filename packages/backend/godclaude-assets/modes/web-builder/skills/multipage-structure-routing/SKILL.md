---
name: multipage-structure-routing
description: godsite's multi-page structure + routing skill. Scaffolds the page set, the shared layout shell, clean routes/URLs, and working cross-page navigation (header nav, footer nav, active-state, 404). Use within godsite when laying out the site's pages, wiring navigation, or deciding URL structure.
---

# Multi-page structure & routing (godsite)

A website is multiple pages that share a shell and link to each other reliably. Get the skeleton right
before styling individual pages.

## 1. Decide the page set
- Confirm purpose, then the pages. Common default: **home, about, services/products, contact**; add
  blog/pricing/portfolio as the brief requires. Ask only what's necessary; otherwise use this default
  and state it.
- One responsibility per page. Home = value prop + signposting to the others.

## 2. URL / route structure
- Clean, lowercase, hyphenated paths: `/`, `/about`, `/services`, `/contact`.
- **Static output:** prefer a directory-per-page so the path has no `.html` — `about/index.html` serves
  at `/about/`. (Plain flat `about.html` is acceptable for a tiny site; be consistent.)
- **Framework output:** use the framework's file-based routing (`pages/`/`app/`/`src/pages/`) — check the
  framework's actual routing model in its docs; never assume.
- Set a `<base>`/site base path correctly when the host serves from a subpath (e.g. GitHub Pages project
  sites) — coordinate with [`deployment-prep`](../deployment-prep/SKILL.md).
- **URL stability:** treat URLs as long-lived contracts — if a path changes mid-build, keep a permanent
  301/308 old→new map and surface it to [`deployment-prep`](../deployment-prep/SKILL.md)'s hand-off (it
  already lists redirects as hand-off config).

## 3. The shared shell
- ONE layout (header + main + footer) wraps every page — a layout template/partial/component, never
  copy-pasted markup that drifts per page.
- Header: logo/site-name (links home) + primary nav. Footer: secondary nav, copyright, social.
- Use semantic landmarks: `<header>`, `<nav>`, `<main>`, `<footer>` — see
  [`accessibility`](../accessibility/SKILL.md).

### Progressive enhancement (HTML-first)
- Build HTML-first: primary navigation and forms must FUNCTION with JavaScript disabled.
- Nav uses real `<a href>` to real routes (already required above — this is the PE guarantee).
- Forms wire a real `action`/endpoint (or a static-host form service / `mailto`) — never a JS-only
  `onsubmit` that silently no-ops when JS fails. See [`accessibility`](../accessibility/SKILL.md) for form
  semantics.
- Do NOT add a service worker / PWA offline layer on a multi-page marketing/content site — it's a
  stale-cache footgun for near-zero payoff; [`seo-meta`](../seo-meta/SKILL.md) already ships the webmanifest
  for icon basics.

## 4. Navigation that actually works
- Primary nav lists every top-level page; links use root-relative or framework-resolved hrefs (not
  fragile `../../` chains).
- **Active state:** the current page's nav item is visually marked AND carries `aria-current="page"`.
- Mobile nav: a real toggle (hamburger) that opens/closes, is keyboard-operable, and has an accessible
  name — coordinate with [`responsive-layout`](../responsive-layout/SKILL.md).
- Every internal link resolves to a real route. Add a styled **404** page — the 404 route must return a
  TRUE 404 status, never a soft-404 (200 + a "not found" body).

### Smooth navigation (optional, progressive enhancement)
- Opt into the View Transitions API for app-like MPA nav: `@view-transition { navigation: auto }`
  (same-origin cross-document) and/or `document.startViewTransition()` (same-document).
- ENHANCEMENT-ONLY: it must degrade to instant navigation with no broken route.
- **Browser support (verified 2026):** same-document VT is Baseline; the cross-document MPA at-rule is
  supported in Chromium (126+) and Safari (18.2+) — **Firefox** still snaps (in development), which is fine.
- Name a couple of persistent elements (header/logo) with unique `view-transition-name` for continuity —
  no name collisions (a duplicate aborts the transition).
- Wrap motion in `@media (prefers-reduced-motion: no-preference)`, short durations — see
  [`design-system-quality`](../design-system-quality/SKILL.md) for `--transition` / reduced-motion.

## 5. Verify (per the web-builder contract)
A re-read of the markup does NOT prove navigation works. Verify by serving the build and:
- hitting **each route → HTTP 200**, and the **404 route → a real 404** (not a soft-404: 200 body), and
- clicking through the nav on the rendered site (chrome-devtools) — every internal link lands on the
  right page, active state shows, mobile toggle opens/closes.
- **Graceful degradation (load-bearing):** with JavaScript DISABLED (and/or in an engine without
  `@view-transition`, e.g. Firefox), every route still returns 200 and every internal link still lands
  correctly — the page must still navigate, just without animation.
- **Forms:** each form has a working real `action` — or is flagged in the hand-off as needing a server
  handler. A JS-only `onsubmit` that no-ops without JS does not pass.
- **View Transitions:** assert via `evaluate_script` that `view-transition-name` values are UNIQUE (a
  duplicate aborts the transition), and confirm `prefers-reduced-motion` SUPPRESSES the animation. No
  "looks smooth" prose clears this — a still screenshot can't show a transition; the proof is the 200s,
  the CSSOM/DOM assertions, and the reduced-motion suppression.
Broken link or non-200 route = not done; fix and re-verify.
