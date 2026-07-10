---
name: design-system-quality
description: godsite's design-system + design-quality skill. The SHARED standard every other godsite skill builds on — design tokens (color/type/space/radius/shadow), a real visual hierarchy, and the quality bar that keeps pages from looking generic or templated. Use within godsite when establishing the brand/style direction, defining tokens, or judging whether a page clears the design bar.
---

# Design system & quality bar (godsite)

This is the foundation skill. Lock the design system FIRST, then every page is built from these tokens so
the site is consistent. The bar: a tasteful, intentional, modern site — never a generic Bootstrap-looking
template. If a page could be any company's page, it has not cleared the bar.

## 1. Establish a direction
- Derive from the user's input (brand colors, logo, copy, industry, references). If none given, choose a
  tasteful default and STATE it (e.g. "clean editorial, warm neutral palette, one accent").
- Pick exactly ONE accent/brand color family + a neutral ramp. Two accents max. Resist rainbow.

## 2. Define tokens (CSS custom properties on `:root`)
Author tokens once and reference them everywhere — no hardcoded hex/px scattered in components.
- **Color — semantic ROLES, not literal values:** pair every surface/accent with its on-color so
  text-on-background contrast is structural, not accidental — `--bg`/`--on-bg`, `--surface`/`--on-surface`,
  `--accent`/`--accent-contrast`, plus `--text`, `--text-muted`, `--border`. Components reference the role
  (`color: var(--on-surface)`), never a raw hex. Keep this a FLAT semantic set — do NOT build an enterprise
  reference→semantic→component token pyramid; over-engineering at godsite's single-dev, single-site scale.
- **Theming / dark mode by SWAPPING role values, not inverting:** under `[data-theme="dark"]` (or
  `@media (prefers-color-scheme: dark)`) re-assign the SAME role tokens to a hand-picked dark set — every
  component follows for free. Never pure `#000`/`#fff` (use near-black/near-white). Express elevation via
  tokenized surface steps (`--surface`, `--surface-2`…) that get lighter as they rise in dark mode.
  Re-check AA contrast on the dark theme's REAL rendered colors — see [`accessibility`](../accessibility/SKILL.md).
- **Type scale:** one display font + one text font (system stack is a fine default). A modular scale
  (e.g. 1.25): `--step--1 … --step-5`. Set `line-height` (~1.5 body, ~1.1 headings) and a readable
  measure (`max-width: 60–75ch` on text blocks).
- **Space scale:** a consistent ramp (`--space-1`…`--space-12`, e.g. 4/8/12/16/24/32/48/64/96px).
  All padding/margins/gaps come from the ramp — no arbitrary `13px`.
- **Radius / shadow / motion:** `--radius`, `--radius-lg`; 1–2 elevation shadows; a `--transition`
  (~150–200ms ease). Respect `prefers-reduced-motion`.
- **Cascade layers:** declare `@layer reset, tokens, base, components, utilities;` and author into named
  layers for predictable specificity — earlier layers always lose, killing `!important` wars and source-order
  fights. (This is the home for `@layer`; [`responsive-layout`](../responsive-layout/SKILL.md) points here.)

## 3. The quality bar (a page must clear ALL)
- **Hierarchy:** clear focal point per section; headings step down; generous whitespace; nothing cramped.
- **Rhythm:** consistent vertical spacing between sections (one section-padding token).
- **Alignment:** everything on a grid; consistent container width and gutters.
- **Type:** no walls of text; constrained measure; real contrast between heading and body.
- **Color:** mostly neutral, accent used intentionally (CTAs, links, highlights) — not everywhere.
- **Detail:** hover/focus states on interactive elements; buttons and links look interactive; images
  have consistent aspect ratios and `border-radius`.
- **Polish:** a real header and footer, a hero with a clear value proposition, sections with purpose.
- **States:** every async/data view designs its LOADING (prefer a skeleton over a spinner), EMPTY, and
  ERROR states — the systematically-omitted other half of the populated happy path. If a page has no data
  views, say so — do not fabricate states.

## 4. Content & conversion
godsite owns the vessel AND sets a content bar — a beautiful page that does not convert has not cleared it.
- **5-second test:** the above-the-fold value proposition is legible without scrolling — a stranger knows
  what this is and why they care before touching the wheel.
- **One CTA style:** ONE focused, high-contrast primary-CTA style, repeated down the page at decision points.
  Resist a wall of equal-weight buttons — competing CTAs are no CTA.
- **Scannable copy:** F-pattern, short blocks, headings and lists — no walls of text.
- **Microcopy priority:** clarity > concision > character. Witty never at the cost of clear.
- **Trust at the hesitation:** place trust signals / social proof next to the conversion point, where doubt
  spikes — beside the CTA, the price, the form — not buried in a lone testimonials slab.
- **People-first E-E-A-T:** real, useful content written for humans; let [`seo-meta`](../seo-meta/SKILL.md)
  own the crawlability / heading-structure side.

## 5. Consistency
- A shared layout shell (header + footer + container) wraps every page — see
  [`multipage-structure-routing`](../multipage-structure-routing/SKILL.md).
- Reusable components (button, card, section, nav) styled from tokens; the same button looks the same
  on every page.
- Contrast pairings must satisfy WCAG AA — coordinate with
  [`accessibility`](../accessibility/SKILL.md).

## Proof (per the web-builder contract)
"Looks good" is not proof. Clearing the design bar is verified by a **screenshot** of the rendered page
(and a mobile-width screenshot), captured after the build — not by reading the CSS. Tokens applied in
source ≠ tokens rendering correctly.
- **Theming:** light AND dark screenshots of the SAME page proving the role tokens swap, and that neither
  theme uses pure `#000`/`#fff` (sample the rendered `background`/`color`). Re-run measured contrast on the
  dark theme's actual rendered colors — a light-theme AA pass does not carry over.
- **Above-the-fold conversion:** a DOM/screenshot capture at mobile AND desktop viewports showing exactly
  ONE visible `<h1>` value-prop and exactly ONE primary-CTA style — assert the primary-CTA count via DOM
  query and check its AA contrast.
- **States:** for each data view, FORCE and screenshot the loading (network-throttled), empty, and error
  states. Source containing a `skeleton` class is NOT proof — only the forced, screenshotted state clears it.
