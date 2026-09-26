# DevToolbox — Plan

**Priority tier:** 1 · **Bundle ID:** `com.xorro.devtoolbox`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Format JSON | 99,193 |
| UUID Generator | 35,168 |
| DevUtils | 25,828 |
| Diff Checker | 21,382 |
| JWT Decoder | 17,899 |
| Regex Tester | 13,315 |
| Prettier Code | 4,206 |
| **Total** | **216,991** |

**Alfred today:** Scattered single-purpose workflows (Pretty JSON, 'Create and paste UUIDs' 2013, Base64, Epoch Converter); no JWT or regex tester.

## Features (v1.0)
- [ ] `json` format / minify / validate clipboard; JSON → TS types
- [ ] `uuid` v4/v7, ULID, nanoid (paste or copy; count modifier)
- [ ] `jwt` decode header/payload, show expiry in local time
- [ ] `regex <pattern>` test against clipboard, list matches and groups
- [ ] `hash` md5/sha1/sha256; `enc` base64/url/html encode-decode
- [ ] `ts` unix ⇄ ISO date (merges with existing timestamp tools)
- [ ] `diff` clipboard vs selection in FileMerge/Kaleidoscope/`diff`
- [ ] Universal Action on selected text: pick any transform

## Tech
- **Stack:** JXA (JavaScriptCore has JSON, regex, crypto via ObjC bridge) — zero dependencies.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post
