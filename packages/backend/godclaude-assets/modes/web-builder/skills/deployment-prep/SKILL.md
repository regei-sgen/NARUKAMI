---
name: deployment-prep
description: godsite's deployment-prep skill. Picks the stack from the deploy target, runs the production build, executes the deployment-ready verification (routes/responsive/console/SEO/a11y/security/Lighthouse), and produces the exact deploy hand-off to godship WITHOUT deploying. Use within godsite when choosing the stack, doing the production build, running the final readiness checks, or preparing the deploy hand-off.
---

# Deployment prep (godsite) — stack choice, production build, hand-off to godship

godsite builds to deployment-READY and stops. Deploying/pushing is **godship's** job — this skill prepares
the build and the hand-off; it never runs the deploy.

## 1. Stack by target + workload (choose from the deploy answer, state why)
Two axes: the deploy **host** and the **workload**. Host fixes the output target; workload fixes the rendering mode.

| Deploy target | Stack / output | Build → output dir (verify against the tool's docs) |
|---------------|----------------|------------------------------------------------------|
| GitHub Pages / Netlify / Cloudflare Pages / Vercel (static) | Static: plain HTML/CSS/JS, or a static generator (Astro / Eleventy / Hugo) | static generator build → `dist/` or `_site/`; plain HTML needs no build |
| Node / SSR host | An SSR framework (Next / Nuxt / SvelteKit / Astro-SSR) | framework build → `.next/` / `.output/` / `build/` |
| "Just build locally" | Lightweight default (plain static or a small Vite/Astro project) with a working local dev/preview | `build` → `dist/`, served via a local preview |

**Rendering-mode principle — default STATIC, escalate only on evidence:**
- Default to **SSG** and ship **zero JS** by default — islands / partial hydration where the framework supports it ([`design-system-quality`](../design-system-quality/SKILL.md) keeps the surface small).
- Escalate to **ISR** only where content freshness demands it; to **SSR** only for per-request / personalized / authed pages. Don't pay for hydration a content page never uses.
- Workload → stack: **content / marketing** → Astro / Eleventy / Hugo (SSG, ~0 client JS); **app-like / interactive** → Next / Nuxt / SvelteKit.
- The choice is proven by the **per-route JS-transfer-bytes budget** in §3 (content/marketing routes ship at/near zero client JS), not by prose.

- State the chosen stack AND rendering mode and WHY; confirm before building if it's a significant choice.
- **Base path:** GitHub Pages project sites serve from `/<repo>/` — set the framework's `base`/`site`
  config (and a `<base>` where needed) so assets and links resolve. Coordinate with
  [`multipage-structure-routing`](../multipage-structure-routing/SKILL.md) and
  [`asset-handling`](../asset-handling/SKILL.md).

## 2. Production build
- Run the actual production build (not just dev). It must exit 0 with no errors. Resolve warnings or
  state why each is acceptable.
- Prefer a build that emits **content-hashed asset filenames** (`app.4f3a1b.js`) — every modern bundler
  does this by default; it's what makes `immutable` long-cache headers safe in §4.
- Serve the production output locally (preview/static server) for verification — dev-server behavior is
  not production behavior.

## 3. Deployment-ready verification (ALL must pass — this is the proof contract)
Run these against the SERVED production build and FIX-then-RE-VERIFY any failure (remediation loop):
- [ ] every page route renders, **HTTP 200** on each (404 route → 404), all internal links work
- [ ] responsive across mobile / tablet / desktop ([`responsive-layout`](../responsive-layout/SKILL.md))
- [ ] **no console errors or warnings** (read the console on each route) — and **no CSP violations** (see security row)
- [ ] SEO/meta: titles, descriptions, favicon, OG tags ([`seo-meta`](../seo-meta/SKILL.md))
- [ ] accessibility basics: semantic HTML, alt text, contrast ([`accessibility`](../accessibility/SKILL.md))
- [ ] security/hygiene: **no hardcoded secrets**, basic form validation, no obviously insecure patterns
- [ ] assets optimized, production build passes ([`asset-handling`](../asset-handling/SKILL.md))
- [ ] **Core Web Vitals — numeric lab gate** (lab run on the SERVED build): **LCP ≤ 2.5s**, **CLS ≤ 0.1**, and **Total Blocking Time** quoted as the honest **lab proxy for INP** with a **long-tasks listing**. True field/p75 **INP & CrUX are NOT available pre-launch** — state them UNVERIFIED, never fake a field INP number.
- [ ] **per-route JS-transfer-bytes budget** (proves the §1 rendering choice): content/marketing routes ship **at/near zero client JS**; app-like routes within their stated budget — measured from the network capture, not asserted.
- [ ] **cache + compression Lighthouse audits pass**: **"Uses efficient cache policy"** AND **"Enable text compression"** — OR the header config file is present in the deployable output and shown in the §4 hand-off, flagged **host-applied** (the served preview may not set edge headers).
- [ ] **security headers**: the §4 header-config artifact exists/parses and is in the hand-off; the **meta-http-equiv CSP renders on every route** and the served-preview console is **clean of CSP violations**; any SRI'd third-party resources load **200 with no integrity-mismatch error** (SRI owned by [`asset-handling`](../asset-handling/SKILL.md)). Live grade (securityheaders.com / Mozilla Observatory letter, real HSTS, edge-enforced CSP) needs a **live origin = godship's gate → state UNVERIFIED**.
- [ ] **privacy / analytics hygiene**: cookieless analytics snippet (if any) is in the rendered `<head>` on every route and a **network capture shows NO cookies set** under the cookieless default; the **privacy-policy route is 200 and linked in the footer**. Consent legality is an owner action (see §4), logged UNVERIFIED — never claimed "compliant".
- [ ] **Lighthouse** run, no failing categories (or the agreed target scores for perf / a11y / SEO)

**Remediation playbook (fix-then-re-verify the metric that failed):**
- **LCP > 2.5s** — identify the LCP element, then attack its four phases: **TTFB** (server/CDN), **resource load delay** (make it server-rendered / discoverable in initial HTML, `fetchpriority="high"`, **never lazy-load it** — cross-ref [`asset-handling`](../asset-handling/SKILL.md)), **load duration** (compress/resize/preconnect), **render delay** (cut render-blocking CSS/JS). Re-measure.
- **CLS > 0.1** — find the shifting node and reserve space: set `width`/`height` or `aspect-ratio` on media, reserve ad/embed slots, avoid late-injected layout. Re-measure.
- **TBT / INP failing** — name the **offending long task** from the long-tasks listing and **break it up / `yield`** (defer, code-split, move work off the main thread). Re-measure.

## 4. Hand-off to godship (propose-only — do NOT deploy)
Produce, but do not run:
- the exact build command + the output directory to publish,
- the exact deploy steps/command for the chosen target (e.g. the host's CLI/UI flow), clearly labelled
  as the user's / godship's to execute,
- any required config (base path, env var NAMES — never values/secrets, redirects),
- **a security-header config artifact** — host/build file (Netlify `_headers` / `vercel.json` / nginx
  snippet) PLUS a `<head>` `<meta http-equiv="Content-Security-Policy">` fallback. Baseline: strict CSP
  (nonce/hash + `strict-dynamic`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors`), **HSTS**,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`. SRI on third-party scripts
  is owned by [`asset-handling`](../asset-handling/SKILL.md). godsite **emits** this; the **live grade
  (Observatory/securityheaders, real HSTS, edge-enforced CSP) is godship's gate — flag UNVERIFIED**.
- **a cache + compression config** (`_headers` / `netlify.toml` / `vercel.json`): `Cache-Control: public,
  max-age=31536000, immutable` on content-hashed assets, `no-cache` on HTML, **Brotli (gzip fallback)**
  for text. Flag **host-applied** — the edge enforces it, not the served preview.
- **a privacy/analytics block** — only if the brief calls for analytics (don't add a tracking tag or a
  privacy-policy page to a site that collects nothing): prefer **cookieless privacy-first analytics**
  (Plausible / Fathom-style — one `<head>` tag that sets **no tracking cookies**) and a **privacy-policy
  page** (marked placeholder + footer link). Whether cookieless analytics removes a consent-banner
  obligation is the owner's **LEGAL call** — logged UNVERIFIED, never claimed "compliant". If the owner
  wants cookie-based tracking, do **NOT** auto-author a consent UI/CMP — pass it through as an owner-action item.
- the list of generated placeholders still needing real content.

## 5. Verify (per the web-builder contract)
"Deployment-ready" is cleared ONLY by artifacts produced THIS turn against the SERVED build after the last edit:
- the production build exited 0 AND every route served 200 / was screenshotted,
- the **numeric CWV gate** met from the lab run — **LCP ≤ 2.5s**, **CLS ≤ 0.1**, **TBT** quoted (+long-tasks) as the INP proxy; field/p75 **INP & CrUX stated UNVERIFIED**,
- the **per-route JS-budget** met from the network capture (content/marketing at/near zero client JS),
- the two **cache/compression Lighthouse audits** pass — or the config file is present in the deployable output and shown in the hand-off (flagged host-applied),
- the **security-header config exists/parses + is in the hand-off**, the **meta-CSP renders on every route**, and the served console is **clean of CSP violations** (SRI'd resources 200, no mismatch),
- the **analytics/cookie network check** clears — cookieless tag in `<head>` on every route, **no cookies set**, privacy-policy route 200 + footer-linked,
- **Lighthouse** passed (no failing categories / agreed targets).

A re-read of the source never clears it. Anything that needs a **live origin** — securityheaders.com / Observatory letter grade, real HSTS, edge-enforced CSP, edge cache/compression headers, field INP/CrUX, consent legality — is **godship's gate**: state it UNVERIFIED, never claim it works live. If any item can't be verified, drop the "ready" claim and say exactly what's unverified.
