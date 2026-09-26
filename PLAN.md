# DevToolbox — Plan

**Priority tier:** 1 · **Bundle ID:** `io.github.x-o-r-r-o.devtoolbox` · **Keywords:** `json`, `uuid`, `jwt`, `regex`, `hash`, `enc`, `epoch`, `diff`

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
- [ ] `epoch` unix ⇄ ISO date (merges with existing timestamp tools)
- [ ] `diff` clipboard vs selection in FileMerge/Kaleidoscope/`diff`
- [ ] Universal Action on selected text: pick any transform

## Tech
- **Stack:** JXA (JavaScriptCore has JSON, regex, crypto via ObjC bridge) — zero dependencies.
- **Dependencies:** None.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [ ] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [ ] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [ ] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [ ] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [ ] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [ ] Main icon ≥ 256×256 px
- [ ] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [ ] Any compiled binary is Developer ID signed + notarised; never strip quarantine
- [ ] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README and the forum post
- [ ] Version bumped in `src/info.plist`; `./build.sh`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link
