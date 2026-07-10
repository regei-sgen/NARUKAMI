# godsite private skills — index

These are godsite's OWN website-building skills, authored for `web-builder` mode only. They are NOT
registered in the global skill system, are invisible to the general assistant and every other god mode,
and load ONLY while godsite is active (they live under the mode directory, not under `~/.claude/skills/`).

godsite builds using ONLY these skills. Read a skill's `SKILL.md` before doing that part of the build.

| Skill | Concern |
|-------|---------|
| [`multipage-structure-routing`](./multipage-structure-routing/SKILL.md) | Multi-page structure, routing, and working cross-page navigation |
| [`responsive-layout`](./responsive-layout/SKILL.md) | Fluid mobile / tablet / desktop responsive layout |
| [`design-system-quality`](./design-system-quality/SKILL.md) | The design system + the design quality bar (the shared standard the others build on) |
| [`mcp-components`](./mcp-components/SKILL.md) | **Stack-gated.** Build-time component sourcing via the shadcn/ui MCP + framework context via the Astro Docs MCP — real registry source instead of guesswork, then re-themed to the design system and verified. Propose-only setup; chrome-devtools stays the verify MCP |
| [`seo-meta`](./seo-meta/SKILL.md) | Titles, descriptions, favicon, Open Graph / social meta |
| [`accessibility`](./accessibility/SKILL.md) | Semantic HTML, alt text, contrast, keyboard / focus |
| [`asset-handling`](./asset-handling/SKILL.md) | Sourcing-or-generating, optimizing, and swap-in markers for images / fonts / icons |
| [`deployment-prep`](./deployment-prep/SKILL.md) | Stack-by-target mapping, the production build, and the deployment-ready hand-off to godship |

**Opt-in exception (NOT part of the default build, does NOT auto-apply):**

| Skill | Concern |
|-------|---------|
| [`app-motion`](./app-motion/SKILL.md) | Scope-gated stateful JS animation (Motion / ex-Framer Motion) — ONLY on React/app builds, for motion CSS + the View Transitions API can't express (gesture drag, exit-on-unmount, shared-element layout). Static builds never load it; see its §0 gate. |

**Build order (typical):** `deployment-prep` (pick the stack from the target) → `design-system-quality`
(lock the tokens) → `multipage-structure-routing` (scaffold pages + nav) → on a component-driven stack,
`mcp-components` (set up the MCP + source real components, re-themed to the locked tokens) →
`responsive-layout` + `asset-handling` + `seo-meta` + `accessibility` (build each page) → `deployment-prep`
(production build, verify, hand off). Every claim of "ready" is gated by the web-builder proof contract — see
`../contract.md`.
