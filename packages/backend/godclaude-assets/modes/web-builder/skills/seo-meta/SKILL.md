---
name: seo-meta
description: godsite's SEO + metadata skill. Per-page titles and descriptions, favicon, canonical URLs, Open Graph / Twitter social cards, semantic heading structure, sitemap/robots. Use within godsite when adding page metadata, social-share tags, a favicon, or improving discoverability/SEO.
---

# SEO & meta (godsite)

Every page must be self-describing to search engines and social platforms. These are per-PAGE — do not
copy one page's title/description to all.

## 1. Per-page essentials (in `<head>`)
- **Title:** unique, descriptive, `<60 chars` — `Page — Site Name`.
- **Meta description:** unique, ~150–160 chars, written for humans.
- **Charset + viewport:** `<meta charset="utf-8">` and the responsive viewport tag.
- **Canonical:** `<link rel="canonical" href="<absolute page URL>">`.
- **Lang:** `<html lang="en">` (or the real language).
- **i18n (multilingual/multi-region only):** add reciprocal `hreflang` alternates (valid BCP-47 codes)
  plus an `x-default` — the canonical's multi-region sibling. Set `dir` for RTL languages (lay out via
  logical properties — [`responsive-layout`](../responsive-layout/SKILL.md)). Single-language site: the
  `<html lang>` above is enough — don't add `hreflang` you don't need.

## 2. Favicon & app icons
- A real favicon (`favicon.svg` + `favicon.ico` fallback), `apple-touch-icon`, and a small
  `site.webmanifest` with name/theme-color. Don't ship the framework's default placeholder icon.

## 3. Social / Open Graph (so shared links look right)
- Open Graph: `og:title`, `og:description`, `og:type`, `og:url`, `og:image` (absolute URL,
  ~1200×630), `og:site_name`.
- Twitter: `twitter:card` = `summary_large_image`, plus title/description/image.
- The OG image is a real asset — coordinate with [`asset-handling`](../asset-handling/SKILL.md).

## 4. Structured data (JSON-LD)
schema.org markup as a `<script type="application/ld+json">` block in `<head>` or end-of-body. Opinionated
defaults:
- **Organization** (or **LocalBusiness**) — once, site-wide, on the home page.
- **BreadcrumbList** — where the page sits in a hierarchy.
- **Article** / **BlogPosting** — on posts.
- **Product** — on product pages.
- **FAQPage** / **Review** — ONLY where that content genuinely exists on the page.

Rules:
- Include every required property for each type — partial markup is invalid markup.
- Keep JSON-LD consistent with what's visibly rendered — no markup-only data the user can't see.
- Prefer a small set of correct types over many speculative ones.
- If a type can't be done correctly, **DROP it** rather than ship invalid or fake markup — invalid/over-eager
  schema risks manual actions and is net-negative.

## 5. Structure & crawlability
- Heading structure (exactly ONE `<h1>`; nest logically, don't skip levels) is owned by
  [`accessibility`](../accessibility/SKILL.md); SEO relies on it for crawlable structure.
- Descriptive link text (no "click here"); descriptive `alt` on meaningful images (the alt rule is owned by
  [`accessibility`](../accessibility/SKILL.md); SEO consumes it for image discoverability).
- Generate `sitemap.xml` and `robots.txt` (allow crawl; point to the sitemap). Use absolute URLs once
  the deploy target's domain/base path is known — coordinate with
  [`deployment-prep`](../deployment-prep/SKILL.md).

## 6. Placeholder discipline
- When metadata/domain is generated rather than provided, use realistic placeholders and **clearly mark
  every spot** that needs the real value (real domain, real OG image, real description) before launch.

## 7. Verify (per the web-builder contract)
Check the RENDERED `<head>` per route (view source / DOM snapshot on the served site), and confirm the
**Lighthouse SEO** category passes with no failing audits. Tags present in the template ≠ tags correct on
every route — verify per page.
- **Structured data:** validate the JSON-LD **locally** (parse + schema.org type / required-property check)
  with zero errors per declaring route — the gate is this local validation, not a re-read of the `<script>`.
  Google's **Rich Results Test** needs a live public URL → it's **godship's gate, stated UNVERIFIED**
  pre-launch (mirroring how [`deployment-prep`](../deployment-prep/SKILL.md) treats securityheaders / field INP).
- **hreflang:** where used, confirm the alternates are reciprocal and include `x-default` in the rendered
  `<head>`.

This validation joins [`deployment-prep`](../deployment-prep/SKILL.md)'s readiness checklist.
