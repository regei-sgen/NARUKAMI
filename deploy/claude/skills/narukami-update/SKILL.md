---
name: narukami-update
description: Find (or build) the latest NARUKAMI desktop installer in the repo's release folder and update the installed Windows app from it. HARD-SCOPED to the NARUKAMI repo only — never crawls or installs from any other folder. Trigger on the exact phrase "Narukami God" (any casing — e.g. "narukami god", "NARUKAMI GOD"), or on "update the narukami app", "install the narukami build", "crawl narukami and install", or /narukami-update.
---

# NARUKAMI Update

Find the newest NARUKAMI desktop installer produced by this repo and update the installed Windows app from it. **Windows only** (the installer is an NSIS `.exe`).

**Trigger word: "Narukami God"** (any casing). When the user says it, run this skill. (Plain "Narukami" instead means *launch the dev app* — the `/narukami` command.)

## HARD SCOPE (non-negotiable)

Operate on **exactly one folder** — the NARUKAMI repo this skill was installed for:

```
__NARUKAMI_REPO__
```

The installer lives under its release dir:

```
__NARUKAMI_REPO__\packages\desktop\release\
```

NEVER crawl, search, or install from any other directory. NEVER install an `.exe` that did not come from this repo's `release\` folder. If asked to widen the scope, refuse and restate this constraint.

## The self-host hazard — read first

This Claude session usually runs **inside** the installed NARUKAMI app: `claude.exe` is a child of `NARUKAMI.exe`, and the shell tools run under it. Installing an update **closes the running app**, which **kills this Claude session mid-install**.

Because of that:
- You (Claude) MUST NOT close/kill `NARUKAMI.exe` yourself. Let the installer do it.
- You MUST launch the installer **detached + elevated** so it survives your own process dying (an elevated process started via `-Verb RunAs` runs under a fresh token, not as a child of `claude.exe`, so it keeps running after the host app closes).
- You MUST get the user's explicit go-ahead first, telling them this chat will end.

## Steps

1. **Crawl the release folder** for the newest installer (do not hardcode a version):
   ```bash
   ls -t "__NARUKAMI_REPO__/packages/desktop/release/"NARUKAMI-Setup-*.exe | head -1
   ```
   Report its filename (version), size (MB), and build time. Cross-check `release/latest.yml` for `version` + `releaseDate` if present.
   - If **no** installer exists, or the user asked for a fresh build, build first from the repo root:
     `npm run desktop:dist` (on the original dev machine this was prefixed with `env -u NARUKAMI_EMBEDDED -u RUNNER_TOKEN_FILE` to strip baked-in Electron vars that break the build when Claude runs *inside* the packaged app; harmless to include). Then re-crawl.

2. **Detect the installed app + running processes** (PowerShell):
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='NARUKAMI.exe'" | Select ProcessId,ExecutablePath
   ```
   Note the install location (commonly `C:\Program Files\NARUKAMI` per-machine, or `%LOCALAPPDATA%\Programs\NARUKAMI` per-user).

3. **Self-host check.** Determine whether `claude.exe` is a descendant of a running `NARUKAMI.exe` (walk `ParentProcessId`). If yes, warn the user in plain terms: "Installing will close NARUKAMI and END this chat session mid-install." Ask for explicit confirmation. Do not proceed without it.

4. **Launch the installer detached + elevated** (survives the host app closing). Prefer the assisted wizard so the user confirms the target dir matches the current install:
   ```powershell
   Start-Process -FilePath "__NARUKAMI_REPO__\packages\desktop\release\NARUKAMI-Setup-<version>.exe" -Verb RunAs
   ```
   - In the wizard the user sets the install folder to the **existing** install dir (e.g. `C:\Program Files\NARUKAMI`) so it replaces in place instead of making a second copy, and accepts UAC.
   - Silent variant (only if the user explicitly wants no wizard): append `-ArgumentList '/S'`. Silent NSIS does not relaunch the app afterward — the user reopens it.
   - Do NOT pass `-Wait` (the launcher will die when the app closes).

5. **Tell the user what happens next:** UAC prompt → app closes (this chat ends) → files replaced → reopen NARUKAMI to get the new build. Note it is an **unsigned** build, so SmartScreen shows "unknown publisher" → *More info → Run anyway*.

## Guardrails

- One folder only (the NARUKAMI repo above). Never elsewhere.
- Never `Stop-Process`/`taskkill` NARUKAMI.exe yourself.
- Never `-Wait` on the installer, and always launch it detached + elevated.
- If the newest installer's build time is older than the newest source change under `packages/`, say so and offer to rebuild before installing.
