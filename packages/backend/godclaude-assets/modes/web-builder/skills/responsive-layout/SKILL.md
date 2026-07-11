---
name: responsive-layout
description: godsite's responsive-layout skill. Fluid layouts that work mobile-first across phone/tablet/desktop using modern CSS (flex/grid, fluid type, sensible breakpoints), with no horizontal overflow and tap-friendly targets. Use within godsite when laying out a page, making something responsive, or fixing layout/overflow on small screens.
---

# Responsive layout (godsite)

Mobile-first. Build the small-screen layout, then enhance up. Use the space/type tokens from
[`design-system-quality`](../design-system-quality/SKILL.md) — never hardcode arbitrary sizes.

## 1. Foundations
- Always set `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- `box-sizing: border-box` globally. Images/media `max-width: 100%`.
- A centered container: `width: min(100% - 2*gutter, --max-width)` (e.g. max 1100–1280px).

## 2. Layout primitives (modern FIRST, media queries are the fallback)
Reach for an intrinsic primitive that expresses the layout WITHOUT a breakpoint. A media query is what
you write only when no primitive can say it. All of the below are Baseline-available — production-ready
across evergreen browsers in 2026.
- **Container queries** (+ `cqi` units): a component lays out by its OWN container's width, not the
  viewport. Mark the parent `container-type: inline-size`, then `@container (min-width: 30rem) { … }`;
  size internals in `cqi` (1% of container inline size).
- **Grid** for two-dimensional layouts. Intrinsic responsiveness without breakpoints:
  `grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr))`.
- **Flexbox** for one-dimensional rows/stacks; `flex-wrap` so items reflow instead of overflowing.
- **Dynamic viewport units** `dvh`/`svh`/`lvh` instead of `100vh` — full-height heroes use `min-height: 100dvh`
  (or `svh` for the safe, toolbar-present height) so mobile browser chrome doesn't clip the bottom.
- **`subgrid`** so inner rows of sibling cards align — child grid inherits the parent's tracks
  (`grid-template-rows: subgrid`), keeping titles/bodies/CTAs on a shared baseline across a row.
- **`:has()`** for state-driven layout (LIGHT touch): `.card:has(img)` / `form:has(:invalid)` to react to
  contents/state. Don't overuse it as a general JS replacement.
- **Logical properties** (`margin-inline`, `padding-block`, `inset`) for direction-agnostic layout — this is
  also what makes RTL flip correctly without rewriting CSS (cross-ref [`seo-meta`](../seo-meta/SKILL.md) for
  the i18n `dir`/`hreflang` side).
- **Fluid type/space:** `clamp()` for headings and section padding so scaling is smooth
  (`font-size: clamp(2rem, 5vw, 3.5rem)`).
- **Gap** for spacing between flex/grid children (not margins that collide).

Cascade-layers (`@layer`) for specificity control are owned by
[`design-system-quality`](../design-system-quality/SKILL.md) — don't define layers here; point there if relevant.

## 3. Breakpoints (the fallback when a primitive can't express it)
- Reach here only when no primitive in section 2 can say the layout. Min-width queries, mobile-first.
  Common stops ~640 / 768 / 1024px — but breakpoint to the CONTENT (where it breaks), not to device names.
- Typical shifts: single-column → multi-column grids; stacked nav → horizontal nav; hero text/image
  stack → side-by-side.

## 4. Mobile specifics
- Tap targets ≥ 44×44px; adequate spacing between them. (44px is the touch/mobile default and sits ABOVE
  the WCAG 2.5.8 ≥24×24px AA floor — [`accessibility`](../accessibility/SKILL.md) owns the target-size criterion.)
- The mobile nav toggle works and is reachable; menus don't trap focus — coordinate with
  [`multipage-structure-routing`](../multipage-structure-routing/SKILL.md) and
  [`accessibility`](../accessibility/SKILL.md).
- NO horizontal scroll at any width. Watch fixed widths, large unbroken strings, and overflowing media.

## 5. Verify (per the web-builder contract)
"Responsive" is NOT cleared by reading CSS — a re-read of the CSS never clears this gate. Verify on the
rendered site (chrome-devtools): resize/emulate to **mobile (~375px), tablet (~768px), desktop (~1280px)**
and **screenshot each** — confirm no horizontal overflow, readable type, intact nav, and sensible reflow at
every width. For the modern primitives, render the proof:
- **Container query:** drop the component into a NARROW slot and a WIDE slot and screenshot both — same
  component, different layout, proving it re-lays-out by its OWN container width (not the viewport).
- **Dynamic viewport (`dvh`/`svh`):** emulate a mobile device WITH the browser toolbar present and screenshot
  the full-height hero — confirm the bottom isn't clipped behind the chrome.
- **`subgrid`:** screenshot a card row and confirm inner rows (titles/bodies/CTAs) align across sibling cards.

An overflow or broken layout at any size = not done; fix and re-verify.
