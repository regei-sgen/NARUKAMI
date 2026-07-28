# NARUKAMI PC Stats — Android

A native, landscape-first readout of the PC's vitals — CPU/GPU load, memory,
die temperatures with history, plus the system rail (uptime / disk / battery).
Plain Android views and Canvas drawing: no WebView, no bundled web assets.

The default look ("Classic") is the desktop panel's; the `⋮ → Theme` menu
switches the whole readout to one of **18 full-canvas renderers** from the
design set — Phosphor, Blueprint, Aurora, Thermal, Nixie, Splitflap, Blocks,
Isotope, Deck, Chrono, Cute, Redline, Servo, Nocturne, Iris, Areas, Donuts,
Radar (menu order is the spec's numbering; see `theme/Themes.java`). Themes are
a pure reskin: same server, same poll, same honest "—" when a sensor doesn't
exist.

Targets `minSdk 26`, `compileSdk`/`targetSdk 34`.

## How the phone reaches the PC

The phone talks to a **deliberately tiny read-only stats server** on the PC
(port **4311**), not the main NARUKAMI backend. That listener serves exactly
`GET /api/pcstats` (plus `/health`), requires its own bearer token on every
request, and is off unless started from the desktop app. Worst case if its
token leaks: someone learns your CPU temperature.

The main backend stays loopback-only — it injects its bearer token into the
HTML it serves, and anything holding that token can spawn shells through
`/api/terminals` and `/api/runs`. It must never be put on the Wi-Fi.

Two ways in, same endpoint either way:

- **USB** (default): `adb reverse tcp:4311 tcp:4311`, then the app's default
  server `http://127.0.0.1:4311`. Helper: `packages/mobile/scripts/adb-reverse.mjs`.
- **Wi-Fi**: start the phone server on the PC, then `⋮ → Set server…` with the
  `http://<pc-ip>:4311` address and the token the PC shows.

Start the listener on the PC first (tray → *Phone server (Wi-Fi)*) — it is off
by default. **The token is required on both paths**, USB included: forwarding a
port doesn't authenticate anything. It is regenerated every restart.

## Building

Requires JDK 17+ and the Android SDK (platform 34 + build-tools).

`local.properties` is **gitignored** — it holds the SDK path for whichever
machine you're on. Copy the template and edit it once:

```sh
cp local.properties.example local.properties   # then set sdk.dir
```

On this project's Windows box that path is the private toolchain under
`%LOCALAPPDATA%\narukami-build\` (JDK 17, Gradle 8.9, SDK); any standard SDK
install works too.

```sh
# from packages/mobile/android
gradle test assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

There is no Gradle wrapper checked in — invoke your own `gradle` (8.9 is what
this app is built with).

The release build is signed with the debug key on purpose: this is sideloaded
over adb, never shipped to Play. Swap in a real keystore if that changes.

## Layout of the code

- `MainActivity` — fetch loop (2 s), binding, menu, fullscreen, server dialog
- `Stats` — payload parsing; every reading nullable on purpose
- `UnitView` / `RailView` / `TraceView` — the classic look
- `theme/` — the design-system renderers: `Model` (spec's data mappings,
  unit-tested), `ThemeView` (easing + entrance + ambient clock),
  one renderer per theme composing the `Draw` primitives
