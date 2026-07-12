// Curated, research-backed reference of how the embedded Chromium (Blink)
// preview diverges from a real target browser. This is the *grounding* layer of
// the accuracy advisor: instant, offline, independent of the `claude` CLI.
// Claude then augments it with project-specific findings.
//
// Entries are compiled from MDN / caniuse / WebKit & Mozilla docs (see the deep
// research in the Browser-accuracy feature) and each is adversarially verified
// before landing here (see browserAccuracy.test.ts + the verification workflow).
// Chrome/Edge/Brave/Opera are all Blink — page rendering is identical to the
// preview — so their catalog holds only the real, observable non-layout
// differences (UA token, privacy shields, network blocking).

export type Severity = 'high' | 'medium' | 'low';
export type EngineFamily = 'safari' | 'firefox' | 'chromium';

export interface CatalogEntry {
  area: string;
  severity: Severity;
  /** What the real target browser does differently from the Chromium preview. */
  note: string;
  /** Concrete remedy, or '' when there's nothing to change. */
  fix: string;
  /** Restrict to specific engine ids (e.g. iOS-only, or one Chromium browser). */
  engines?: string[];
}

// Which curated family backs each selectable browser id.
const FAMILY: Record<string, EngineFamily> = {
  chrome: 'chromium',
  edge: 'chromium',
  brave: 'chromium',
  opera: 'chromium',
  safari: 'safari',
  'safari-ios': 'safari',
  firefox: 'firefox',
};

const LABEL: Record<string, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  opera: 'Opera',
  safari: 'Safari',
  'safari-ios': 'Safari (iOS)',
  firefox: 'Firefox',
};

export function engineFamily(engineId: string): EngineFamily {
  return FAMILY[engineId] ?? 'chromium';
}

export function engineLabel(engineId: string): string {
  return LABEL[engineId] ?? 'Chrome';
}

export const CATALOG: Record<EngineFamily, CatalogEntry[]> = {
  safari: [
    {
      area: 'Layout',
      severity: 'high',
      note: '100vh is measured against the largest viewport (toolbars hidden) on iOS Safari, so a 100vh element is taller than the screen at load and its bottom hides behind the address bar. The Chromium preview shows the correct height.',
      fix: 'Use 100dvh (or 100svh) instead of 100vh; keep a JS --vh fallback for iOS < 15.4.',
      engines: ['safari-ios'],
    },
    {
      area: 'Layout',
      severity: 'high',
      note: 'The on-screen keyboard overlays the page on iOS without resizing the layout viewport or vh units, so position:fixed;bottom:0 bars get hidden behind the keyboard — the preview never shows this.',
      fix: 'Track window.visualViewport (height/offsetTop) and reposition fixed UI on its resize/scroll events instead of relying on bottom:0 or vh.',
      engines: ['safari-ios'],
    },
    {
      area: 'CSS',
      severity: 'high',
      note: 'Safari silently ignored the flex gap property until 14.1 / iOS 14.5, so gutters collapse to zero on older iPhones while the Chromium preview shows spacing.',
      fix: 'Use margins on flex children (or @supports feature detection) if you must support Safari < 14.1.',
    },
    {
      area: 'CSS',
      severity: 'high',
      note: 'Gradient/clipped text via background-clip:text needs -webkit-background-clip:text and -webkit-text-fill-color:transparent in Safari; without them the text renders solid or disappears. Safari still requires the -webkit- prefix in current versions.',
      fix: 'Declare -webkit-background-clip:text, background-clip:text and -webkit-text-fill-color:transparent together.',
    },
    {
      area: 'Forms',
      severity: 'high',
      note: 'iOS Safari auto-zooms the page when focusing any input/select/textarea whose font-size is under 16px, and does not zoom back out — the preview never zooms, so the mobile layout looks stable when it is not.',
      fix: 'Set font-size:16px (or larger) on form controls; avoid the maximum-scale=1 meta hack.',
      engines: ['safari-ios'],
    },
    {
      area: 'Media',
      severity: 'high',
      note: 'An inline <video> without playsinline is forced into native fullscreen when it starts on iPhone, breaking hero/background-video layouts that render fine in the preview.',
      fix: 'Add playsinline (and muted for autoplay) to every inline video.',
      engines: ['safari-ios'],
    },
    {
      area: 'Media',
      severity: 'high',
      note: 'iOS blocks autoplay unless the video is BOTH muted and playsinline; a video with audio never autoplays without a user gesture, unlike Chromium which allows muted autoplay broadly.',
      fix: 'Ship autoplay muted playsinline together and add an explicit unmute/play control.',
      engines: ['safari-ios'],
    },
    {
      area: 'JS-API',
      severity: 'high',
      note: 'WebKit parses dates more strictly than V8: dashed date-times and many non-ISO strings return Invalid Date in Safari where the Chromium preview parses them successfully. (The YYYY-MM-DD=UTC vs YYYY/MM/DD=local distinction is ECMAScript-spec behavior shared by both engines, so it is a general date gotcha rather than a Safari-only divergence.)',
      fix: 'Parse with explicit components or a library (date-fns/Luxon/Day.js); never pass ambiguous strings to new Date().',
    },
    {
      area: 'CSS',
      severity: 'medium',
      note: 'backdrop-filter needed the -webkit- prefix through Safari 17 (unprefixed only from 18); without it the frosted-glass blur silently does nothing while it renders in the preview.',
      fix: 'Declare both -webkit-backdrop-filter and backdrop-filter.',
    },
    {
      area: 'CSS',
      severity: 'medium',
      note: 'Safari still needs -webkit-mask / -webkit-mask-image for reliable masking across shipped 15–18 versions; the unprefixed mask is only partially supported.',
      fix: 'Author -webkit-mask* alongside the unprefixed mask* (or let Autoprefixer add them).',
    },
    {
      area: 'Forms',
      severity: 'medium',
      note: 'Native date/time/color controls render with Safari-specific chrome, offer almost no styling hooks, and always use the OS locale format, so they look and size differently from the preview.',
      fix: 'For a custom look/format, build a text input plus a JS date picker instead of styling the native control.',
    },
    {
      area: 'Forms',
      severity: 'medium',
      note: 'Safari applies heavy default chrome to select/checkbox/radio; you must reset with -webkit-appearance:none first, and some controls remain only partially stylable.',
      fix: 'Reset with -webkit-appearance:none; appearance:none and rebuild the control styling; test each control in Safari.',
    },
    {
      area: 'Scrolling',
      severity: 'medium',
      note: 'Dynamic viewport units (dvh/svh/lvh) only work from Safari 15.4; older Safari treats them as invalid, so any layout depending on them silently falls back to nothing.',
      fix: 'Provide a 100vh (or JS --vh) fallback declaration before the dvh/svh one for pre-15.4 Safari.',
    },
    {
      area: 'Scrolling',
      severity: 'medium',
      note: 'overscroll-behavior only shipped around Safari 16, so on older Safari scroll chaining and rubber-band bleed-through cannot be contained via CSS the way the preview suggests.',
      fix: 'Use overscroll-behavior for modern Safari and add JS touchmove prevention as a fallback for older iOS.',
    },
    {
      area: 'Layout',
      severity: 'medium',
      note: 'Safari has long-standing position:sticky quirks — it sticks to the nearest overflow ancestor even when that is not the real scroller, and sticky on table rows/thead is unreliable — so sticky headers can behave unlike the preview.',
      fix: 'Make the intended scroll container the sticky ancestor, apply sticky to thead th (not tr), and test the overflow chain in Safari.',
    },
    {
      area: 'Behavior',
      severity: 'medium',
      note: ':hover sticks on first tap on iOS and stays until another element is tapped, so hover-revealed menus/links need a second tap to activate — the desktop preview shows normal hover.',
      fix: 'Guard hover styles with @media (hover:hover) and pointer:fine; use :active or explicit click handlers for touch.',
      engines: ['safari-ios'],
    },
    {
      area: 'Typography',
      severity: 'low',
      note: 'Promoting an element to a compositing layer (position:fixed, transforms) changes text antialiasing in Safari and makes text noticeably thinner/blurrier than the preview, especially when sites force -webkit-font-smoothing:antialiased.',
      fix: 'Avoid globally forcing -webkit-font-smoothing:antialiased; if fixed/transformed text looks thin, adjust weight and verify on Safari.',
    },
    {
      area: 'JS-API',
      severity: 'low',
      note: 'Safari’s Intelligent Tracking Prevention deletes script-writable storage (localStorage, IndexedDB, caches) after 7 days without interaction, so offline data and tokens can silently vanish — the preview keeps them.',
      fix: 'Do not treat client storage as durable on Safari; re-sync from the server and re-issue tokens gracefully after loss.',
    },
    {
      area: 'Behavior',
      severity: 'low',
      note: 'iOS Safari draws a translucent gray box over tapped links/buttons via -webkit-tap-highlight-color that the preview does not show.',
      fix: 'Set -webkit-tap-highlight-color:transparent and provide your own :active feedback.',
      engines: ['safari-ios'],
    },
  ],
  firefox: [
    {
      area: 'Scrolling',
      severity: 'high',
      note: 'Firefox ignores all ::-webkit-scrollbar rules; custom scrollbars styled that way appear as default OS scrollbars. It only implements standard scrollbar-width/scrollbar-color, with no thumb radius or per-part sizing.',
      fix: 'Use scrollbar-width/scrollbar-color for Firefox alongside ::-webkit-scrollbar for Chromium; don’t rely on webkit-only thumb styling.',
    },
    {
      area: 'Forms',
      severity: 'medium',
      note: 'Firefox’s date and datetime-local inputs show a native calendar-dropdown picker (date since Firefox 57, datetime-local since Firefox 93) and time inputs show a native spinner, broadly comparable to the preview’s — but month and week inputs are unsupported and fall back to a plain text field, unlike the preview’s native picker.',
      fix: 'Feature-test month/week and use a JS date component (e.g. Flatpickr) where consistent UX matters.',
    },
    {
      area: 'Media',
      severity: 'high',
      note: 'Firefox blocks all audible autoplay until a user gesture (no engagement-score allowance), so audio-on videos that autoplay in the preview stay paused.',
      fix: 'Ship muted + playsinline for background video, start audio only after interaction, and handle the play() promise rejection.',
    },
    {
      area: 'Typography',
      severity: 'medium',
      note: 'Firefox does not support -webkit-font-smoothing (only -moz-osx-font-smoothing on macOS), so text often renders slightly heavier than the antialiased preview.',
      fix: 'Add -moz-osx-font-smoothing:grayscale next to -webkit-font-smoothing; don’t assume identical text weight.',
    },
    {
      area: 'Forms',
      severity: 'medium',
      note: 'The number-input spinner cannot be removed with the ::-webkit-inner-spin-button reset in Firefox — those pseudo-elements don’t exist; it needs appearance:textfield.',
      fix: 'Combine appearance/-moz-appearance:textfield with the ::-webkit spin-button reset.',
    },
    {
      area: 'Forms',
      severity: 'medium',
      note: 'Firefox largely ignores <option> background/color (OS-native popup) and the closed <select> metrics differ, so a select styled to match the preview looks different.',
      fix: 'Use a JS/ARIA custom listbox when fully styled options are required; verify closed-control metrics in both engines.',
    },
    {
      area: 'CSS',
      severity: 'medium',
      note: 'backdrop-filter was behind a pref until Firefox 103 (Jul 2022); older Firefox renders no blur/effect where the preview shows it.',
      fix: 'Provide a semi-opaque solid fallback background and gate with @supports (backdrop-filter: blur(1px)).',
    },
    {
      area: 'Layout',
      severity: 'medium',
      note: 'Firefox historically refuses to shrink flex items (notably <input>, replaced elements, nested flex) below their intrinsic min size, causing overflow the preview doesn’t show.',
      fix: 'Add min-width:0 (or min-height:0) on flex items/containers that must be allowed to shrink.',
    },
    {
      area: 'Behavior',
      severity: 'medium',
      note: 'Firefox adds an inner focus ring and extra padding on buttons via button::-moz-focus-inner, so focused/clicked buttons look different from the preview.',
      fix: 'Reset button::-moz-focus-inner{border:0;padding:0} and define an explicit :focus-visible outline.',
    },
    {
      area: 'Behavior',
      severity: 'medium',
      note: 'Firefox often reports wheel events with deltaMode=1 (lines) and small deltaY values, while Chromium reports pixels — so scroll math (parallax, custom scrolling) tuned on the preview travels the wrong distance.',
      fix: 'Inspect event.deltaMode and multiply line/page deltas by line-height/page size before consuming deltaY.',
    },
    {
      area: 'JS-API',
      severity: 'medium',
      note: 'Firefox disabled IndexedDB in Private Browsing (open() threw) until Firefox 115 (Jul 2023); code that assumes it works, as in the preview, errors in private windows on older Firefox.',
      fix: 'Feature-detect and wrap indexedDB.open in try/catch with a memory/localStorage fallback.',
    },
    {
      area: 'Forms',
      severity: 'low',
      note: 'Firefox applies a default opacity below 1 to ::placeholder, so the same grey placeholder appears lighter than in the preview.',
      fix: 'Set ::placeholder{opacity:1; color:…} to normalize placeholder appearance.',
    },
    {
      area: 'Forms',
      severity: 'low',
      note: 'The <details>/<summary> disclosure triangle is the standard ::marker in Firefox, not ::-webkit-details-marker, so a webkit-only reset leaves the marker visible.',
      fix: 'Hide/replace with summary{list-style:none} plus ::marker, keeping the ::-webkit-details-marker reset for Chromium.',
    },
    {
      area: 'Forms',
      severity: 'low',
      note: 'input[type=number] respects the OS locale in Firefox and can require a comma decimal separator (e.g. German), so typed values and validity differ from the preview’s period-only parsing.',
      fix: 'For a fixed format use a text input with inputmode/pattern, or normalize the parsed value; don’t assume a ‘.’ separator.',
    },
  ],
  chromium: [
    {
      area: 'Rendering',
      severity: 'low',
      note: 'Chrome is the engine this preview already uses (Blink), so what you see here is exactly what Chrome renders — no differences to flag.',
      fix: '',
      engines: ['chrome'],
    },
    {
      area: 'Rendering',
      severity: 'low',
      note: 'Edge is Chromium/Blink, so page layout, CSS and JS render identically to this preview. Only the UA token (Edg/…), default Tracking Prevention, and shell features (Collections, sidebar) differ — none affect page pixels.',
      fix: '',
      engines: ['edge'],
    },
    {
      area: 'Privacy',
      severity: 'low',
      note: 'Edge ships Tracking Prevention (Balanced by default) that blocks third-party trackers, changing which resources load — not how the page renders.',
      fix: 'To mirror it, apply a tracker blocklist; otherwise ignore for layout fidelity.',
      engines: ['edge'],
    },
    {
      area: 'Rendering',
      severity: 'low',
      note: 'Brave is Chromium/Blink, so layout/CSS/JS render identically to this preview. Its real differences are the privacy layer, not glyph or box rendering.',
      fix: '',
      engines: ['brave'],
    },
    {
      area: 'Fingerprinting',
      severity: 'medium',
      note: 'Brave Shields “farble” canvas readback, WebAudio and WebGL params with per-session random noise, so canvas.toDataURL/getImageData and audio values differ slightly from the preview each session — breaking hash-based canvas fingerprints or pixel-exact canvas checks.',
      fix: 'Cannot reproduce without the Brave binary; don’t rely on exact canvas/audio readback. Verify in real Brave.',
      engines: ['brave'],
    },
    {
      area: 'Network',
      severity: 'low',
      note: 'Brave Shields block ads and trackers by default, so third-party scripts, iframes and images may not load — pages can look/behave differently (missing ad slots, blocked analytics) than the preview.',
      fix: 'Apply an adblock list to approximate; expect screenshots to differ from plain Chrome.',
      engines: ['brave'],
    },
    {
      area: 'Rendering',
      severity: 'low',
      note: 'Opera is Chromium/Blink, so rendering is identical to this preview. Only the UA token (OPR/…) and optional shell features (built-in VPN, ad blocker) differ.',
      fix: '',
      engines: ['opera'],
    },
  ],
};

// Catalog entries that apply to a given selectable browser id.
export function catalogFor(engineId: string): CatalogEntry[] {
  const family = engineFamily(engineId);
  return CATALOG[family].filter((e) => !e.engines || e.engines.includes(engineId));
}
