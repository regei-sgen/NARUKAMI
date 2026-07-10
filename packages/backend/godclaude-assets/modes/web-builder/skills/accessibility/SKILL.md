---
name: accessibility
description: godsite's accessibility skill. Semantic HTML, alt text, color contrast (WCAG AA), keyboard operability, visible focus, labelled forms, and landmark structure. Use within godsite when building markup, forms, or interactive UI, or when checking/fixing a11y and contrast.
---

# Accessibility (godsite)

Accessibility is built in, not bolted on. Target WCAG 2.2 AA on every page.

## 1. Semantic structure
- Real landmarks: `<header>`, `<nav>`, `<main>` (one per page), `<footer>`, `<section>`/`<article>`
  with headings. Not `<div>` soup.
- Logical heading order: one `<h1>`, then `<h2>`/`<h3>` nested, no skipped levels. **This skill owns the
  heading-structure rule** (WCAG 1.3.1 / 2.4.6); [`seo-meta`](../seo-meta/SKILL.md) consumes it for crawlability.
- Lists for lists, `<button>` for actions, `<a href>` for navigation (never a clickable `<div>`).

## 2. Images & media
- Meaningful images: descriptive `alt`. Decorative images: `alt=""` (empty, not missing). Coordinate
  with [`asset-handling`](../asset-handling/SKILL.md).
- Don't convey meaning by color alone (add text/icon/pattern).

## 3. Color & contrast (WCAG AA)
- Body text ≥ **4.5:1**, large text (≥24px regular or ≥18.66px bold — a font-size tier, distinct from the
  24px hit-area floor in §4) ≥ **3:1**, UI/graphic boundaries ≥ 3:1.
- Verify the token pairings from [`design-system-quality`](../design-system-quality/SKILL.md) actually
  meet AA; adjust tokens if not.

## 4. Keyboard & focus
- Every interactive element reachable and operable by keyboard, in a logical tab order.
- **Visible focus** (2.4.7 Focus Visible, **AA**): never `outline: none` without a clear replacement —
  every focusable control shows an indicator. (2.4.13 Focus Appearance — a minimum-size, contrasting
  indicator — is **AAA**/aspirational: aim for it, but it is not required to clear AA.)
- 2.4.11 Focus Not Obscured: a focused control must not be hidden behind a sticky header/footer or other
  overlay — scroll-pad or offset so it stays visible.
- 2.5.8 Target Size: interactive targets ≥ **24×24 CSS px**, or adequate spacing per the exception. This is
  the AA floor; [`responsive-layout`](../responsive-layout/SKILL.md)'s 44×44px stays the touch/mobile default.
- 2.5.7 Dragging Movements: any drag action needs a single-pointer or keyboard alternative (only if a drag UI exists).
- Mobile menu / disclosure widgets: operable by keyboard, correct `aria-expanded`/`aria-controls`, focus
  not trapped — coordinate with [`responsive-layout`](../responsive-layout/SKILL.md).
- A "skip to content" link is a nice default for content-heavy pages.

## 5. Forms
- Every input has a real `<label>` (or `aria-label`). Group with `<fieldset>`/`<legend>` where relevant.
- Mark required fields; show validation errors in text tied to the field (`aria-describedby`), not color
  alone. Basic client-side validation — coordinate hygiene with
  [`deployment-prep`](../deployment-prep/SKILL.md).
- 3.3.8 Accessible Authentication: allow paste into password fields, don't block password managers/autofill,
  and never gate sign-in on a cognitive-function-only test (no remember-this, no transcription puzzles).

## 6. Interactive widgets & focus management
- **First rule of ARIA: don't.** Prefer native HTML (`<button>`, `<details>`, `<dialog>`, `<select>`) or a
  headless accessible primitive; reach for hand-rolled ARIA only when no native element fits.
- For a genuinely custom widget, follow the WAI-ARIA Authoring Practices (APG) pattern exactly — correct
  roles/states (`role`, `aria-expanded`/`aria-selected`/`aria-checked`) and the documented keyboard model.
- Trap-and-restore focus in modals/dialogs: focus moves in on open, stays within while open, returns to the
  triggering control on close.
- On SPA route changes, move focus to the new view's heading or `<main>` so keyboard/screen-reader users
  land in the right place — coordinate with [`responsive-layout`](../responsive-layout/SKILL.md).

## 7. Verify (per the web-builder contract)
A re-read of the markup is NOT proof. Verify on the rendered served build:
- **Lighthouse accessibility** — no failing audits / the agreed score.
- **Contrast ratios** checked on real rendered colors; tab through each page confirming visible focus and reachable controls.
- **Per custom widget:** keyboard-only walk-through (Tab/Shift+Tab/Arrow/Enter/Space/Escape) — focus lands correctly and `aria-expanded`/`aria-selected`/`aria-checked` transition.
- **Modals:** focus trapped while open and **restored to the trigger on close**.
- **axe-core or pa11y locally** against each route → **0 violations** as a floor (local run; CI wiring is godship's).
- **Target size:** read `getBoundingClientRect()` on interactive controls, assert **≥ 24px** (or the spacing exception).
- **Focus not obscured:** tab through with the sticky header present.

Missing alt, failing contrast, a keyboard trap, an unrestored modal focus, or any axe violation = not done; fix and re-verify.
