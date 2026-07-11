---
name: mcp-components
description: godsite's MCP-powered build-time component & framework-context skill. Arms godsite with the shadcn/ui MCP (search/preview/install production components & blocks from the registry) and the official Astro Docs MCP (current, framework-accurate guidance), with chrome-devtools staying as the verify MCP. STACK-GATED and propose-only on setup. Use within godsite AFTER deployment-prep has chosen the stack, when sourcing components/sections for a component-driven (React/Tailwind/Astro) build — never on a pure hand-rolled vanilla static page, and never as a substitute for the design bar or the proof gate.
---

# MCP components & framework context (godsite) — accelerate the build, never lower the bar

godsite hand-builds quality; it does not paste templates. These MCPs let it **start from real, current,
production-grade source instead of guessing** — but they are an accelerator bolted UNDER the existing
skills, not around them.

> **Cardinal rule (fail-closed).** An MCP-sourced component is a *starting point*, never a finished one.
> It does **not** clear the design bar ([`design-system-quality`](../design-system-quality/SKILL.md)) and
> it does **not** clear the proof gate (the web-builder contract). "Installed the component" / "the MCP returned it"
> is NOT proof it renders, is on-brand, is accessible, or fits the JS budget. Re-theme it (§4) and verify it
> rendered (§5) or it did not happen.

What this arms godsite with:
- **shadcn/ui MCP** — live **search / preview / install** of components & blocks across the shadcn registry
  (and any configured registry). You get real, current source — not hallucinated props or broken installs.
- **Astro Docs MCP** (official, remote) — **current** Astro framework guidance (routing, islands, content
  collections, adapters, config) straight from the live docs index, so the Astro path is built against
  today's API, not a recalled one.
- **chrome-devtools MCP** — unchanged: the **verify** MCP (screenshot / Lighthouse / console / network).
  These build-time MCPs feed it; they never replace it.

## 0. When to use — STACK-GATED (check deployment-prep's choice FIRST)
[`deployment-prep`](../deployment-prep/SKILL.md) §1 picks the stack BEFORE this skill runs. Match the MCP to it:

| deployment-prep stack | shadcn/ui MCP | Astro Docs MCP | How to use it |
|------------------------|:-:|:-:|----|
| Next / Remix / SvelteKit / React-SSR app | ✅ | — | install components directly; ship hydrated where the route earns it |
| Astro (SSG/SSR), incl. React/other islands | ✅ | ✅ | shadcn for islands; **strip to static markup** for content routes (§2); Astro MCP for the framework wiring |
| Plain static **HTML/CSS/JS** (no framework) | ⚠️ reference-only | — | shadcn components are React source — do NOT ship React onto a vanilla page. Pull them as a **markup/structure reference**, then hand-build static + tokens. If that's not buying anything, **skip the MCP** and use [`design-system-quality`](../design-system-quality/SKILL.md) directly |
| Vue / Svelte project | check registry parity | — | the default registry is React; only use a verified Vue/Svelte registry port, else reference-only |

**Fail-closed:** if the stack isn't component-driven, or shadcn would force React onto a zero-JS route, do
NOT use the install path — `skip` or `reference-only`. Forcing it is a budget failure caught in §5.

## 1. Setup — PROPOSE-ONLY (detect, then offer; never silently edit the user's config)
godsite does not modify the user's Claude Code MCP config on its own (mode boundary = propose-only). Flow:
1. **Detect.** Check whether the MCP is already connected (`/mcp` lists it). If present → use it.
2. **If absent → surface the exact one-liner and let the user run it** (or run it ONLY on explicit in-session OK).
   Verify the current command against the tool's own docs before quoting it — these move:
   - **shadcn/ui MCP** (free, open-source, no account for the standard registry):
     `npx shadcn@latest mcp init --client claude`
     or add to project `.mcp.json`:
     ```json
     { "mcpServers": { "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] } } }
     ```
   - **Astro Docs MCP** (official, free, remote — nothing to install locally):
     `claude mcp add --transport http "Astro docs" https://mcp.docs.astro.build/mcp`
   - Then **restart Claude Code** and re-run `/mcp` to confirm it connected.
3. **If the user declines or it can't connect → proceed WITHOUT it** in spirit: hand-build per
   [`design-system-quality`](../design-system-quality/SKILL.md). Never block the build on the MCP; never claim
   you "used the registry" if it wasn't connected.

Boundary: the shadcn MCP runs `npx` (fetches over the network) and the Astro MCP is a remote endpoint —
flag that when proposing setup; both stay the user's call.

## 2. Drive the shadcn MCP — own the code, fit the budget
- **Search → preview → install/copy**, in that order. Search the registry for the section you need
  (hero, pricing, nav, footer, form, card); preview the real source; pull it. Do NOT guess props or
  invent variants — that's the whole point of the live registry.
- **You own the output (copy-in).** shadcn writes the component's source INTO the project — there is no
  runtime dependency on shadcn. So you are free to **edit it heavily** (§4) and, on a static route, to
  **keep only its markup/structure and drop the React**.
- **JS-budget discipline (defer to [`deployment-prep`](../deployment-prep/SKILL.md) §3).** A content/marketing
  route ships **at/near zero client JS**. Do NOT hydrate a shadcn component onto a static section just because
  the MCP handed you React — port its markup to the static stack (or an Astro island only where interaction
  truly needs it). Interactive app routes may hydrate within their stated budget.
- **One source of truth for primitives.** Pick the registry/component set ONCE and reuse it; don't mix three
  button systems. Consistency is owned by [`design-system-quality`](../design-system-quality/SKILL.md) §5.

## 3. Drive the Astro Docs MCP — build against TODAY's API
On an Astro stack, query the Astro MCP for the **current** way to do the thing instead of recalling it:
content collections + schema, file-based routing, `client:*` island directives, adapters (`@astrojs/node`,
Cloudflare, Vercel), `astro.config` `site`/`base` (the GitHub-Pages base-path trap in
[`deployment-prep`](../deployment-prep/SKILL.md) §1), and the View-Transitions router that
[`multipage-structure-routing`](../multipage-structure-routing/SKILL.md) relies on. This satisfies the
contract's rule 8 (verify framework behavior live, don't recall) for the Astro path.

## 4. RE-THEME mandate — the anti-generic rule (this is where the quality bar is enforced)
A registry component ships with the registry's OWN defaults; pasted as-is, the site "could be any company's
page" → it FAILS [`design-system-quality`](../design-system-quality/SKILL.md) §3. Every MCP-sourced component
is re-fitted before it counts:
- **Re-token it.** Replace its built-in colors/spacing/radius/type with godsite's locked
  `--bg`/`--on-bg`/`--accent`/`--space-*`/`--radius`/`--step-*` tokens. No raw hex/px survives from the source.
- **Re-fit hierarchy & copy.** Make it serve THIS section's value prop + the single primary-CTA style
  (design-system-quality §4) — not the demo's lorem.
- **Wire the states.** Add the loading / empty / error states the demo omits (design-system-quality §3).
- **Pass it down the pipeline.** Responsive via [`responsive-layout`](../responsive-layout/SKILL.md), images
  via [`asset-handling`](../asset-handling/SKILL.md), meta via [`seo-meta`](../seo-meta/SKILL.md),
  semantics/contrast/focus via [`accessibility`](../accessibility/SKILL.md).

## 5. Trust NOTHING the MCP returns — verify it (chrome-devtools, per the contract)
The registry is a head start, not a guarantee. Radix-based shadcn primitives are usually a11y-friendly, but
"usually" is not proof, and re-theming can break contrast. After the component is in and re-themed, verify
with the **verify** MCP exactly as the rest of godsite does — there is no MCP-sourced exemption:
- it actually **renders** (screenshot) at mobile AND desktop, on-brand after re-theme;
- **contrast / a11y** hold on the REAL rendered colors (axe/contrast or Lighthouse a11y) — re-theme can regress them;
- the route still meets its **per-route JS-transfer-bytes** budget (network capture) — a stray hydrated
  component is caught here;
- console + network are **clean** (no errors, no surprise third-party fetches the component dragged in).

## Proof (per the web-builder contract) — installing ≠ rendering
Nothing here adds a way to clear the gate; it adds ways to *reach* it faster. The web-builder proof contract
governs unchanged: a readiness claim is cleared only by a production build that exited 0, every route served
200 / screenshotted, the CWV/JS-budget numbers, and Lighthouse passing — **all captured this turn after the
last edit**. A bare re-read, "the MCP installed it", or "the registry says it's accessible" never clears it.
If the MCP wasn't actually connected, say so — don't imply a registry-backed build you didn't do.
