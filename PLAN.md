# DevToolbox — Plan

**Priority tier:** 1 · **Bundle ID:** `io.github.x-o-r-r-o.devtoolbox` · **Keywords:** `dev`, `json`, `uuid`, `jwt`, `regex`, `case`, `hash`, `enc`, `epoch`, `diff`

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
- [x] `dev` smart hub: detects JWT / JSON / CSV / UUID / ULID / timestamp in the clipboard or query; tool menu; `dev <tool> …` delegates
- [x] `json` pretty / minify / sort keys / TypeScript / escape / JSON Lines / CSV; relaxed JS objects, CSV → JSON, JSONL input; error line and column; duplicate-key warning; exact number literals
- [x] `uuid` v4 (+ uppercase, no dashes), v7, ULID, Nano ID; `uuid 10 v7` batches (max 1000); inspect a pasted UUID/ULID (version, variant, creation time)
- [x] `jwt` decode header/payload/claims, expiry and not-before in local time, `alg: none` warning, HS256/384/512 verification with a typed secret
- [x] `regex` test against the clipboard, `/pattern/flags`, `=> replacement`, groups, copy all matches; slow-pattern detection and a 3 s watchdog
- [x] `case` 13 conversions plus character/word/line/byte counts
- [x] `hash` MD5 / SHA-1 / SHA-256 / SHA-512 / CRC32 of text; file hashing via the Universal Action with clipboard checksum comparison
- [x] `enc` Base64, Base64URL, URL, HTML, hex, backslash and Unicode escapes (encode and decode), number base conversion
- [x] `epoch` Unix s/ms/µs/ns ⇄ dates, live "now"
- [x] `diff` last two Clipboard History text entries, or two files via the Universal Action; JSON compared with sorted keys; open / copy / side by side in FileMerge, VS Code, Kaleidoscope or BBEdit
- [x] Universal Actions: Transform (text), Diff (two files), Hash (one file)
- [x] ↩ copy, ⌘↩ paste, ⌘C / ⌘L via `text`; results > 50 KB go through the cache + `resolve.sh`

## Tech
- **Stack:** JXA (`osascript -l JavaScript`) with the ObjC bridge: CommonCrypto (hashes, HMAC), zlib CRC32, NSPasteboard, NSTask. Bash for `resolve.sh`.
- **Dependencies:** none at runtime. `/usr/bin/sqlite3` (ships with macOS) reads Alfred's Clipboard History; the ⌥↩ diff apps are optional.
- No network, no secrets stored, no background processes except the regex watchdog (a `sh` child that is terminated when the script ends and checks its parent PID before killing).
- Target: macOS 13+ on Apple Silicon and Intel, Alfred 5 + Powerpack.

## Known limitations
- A JWT secret typed after `jwt` is passed to the script as an argument (Alfred passes every Script Filter query that way), so it is briefly visible to `ps` for the current user. It is never shown, copied, logged or cached.
- `diff` writes the compared texts (which may come from Clipboard History) to the workflow cache folder; they are replaced by the next diff and never leave the Mac.
- `hash` treats a typed query that is an existing absolute path as a file.
- The ULID and UUID v7 generators are not monotonic within one millisecond across separate runs (batches are sorted).
- Regex uses JavaScriptCore semantics; the `v` flag needs a newer macOS than 13.

## Verify in real Alfred
- [ ] Universal Action "Diff with DevToolbox" with two files selected in Finder passes both paths (tab-separated or as separate arguments).
- [ ] Universal Action "Hash with DevToolbox" on one file, with and without a checksum in the clipboard.
- [ ] ⌘C copies `text.copy` and ⌘L shows Large Type on normal rows and on the "result too large" rows.
- [ ] ⌥↩ on a diff opens FileMerge (`opendiff` returns without blocking Alfred) and the other apps when their CLI is installed; a missing CLI shows a notification.
- [ ] `epoch` with an empty query refreshes every second (`rerun`).
- [ ] Workflow Configuration: changing a keyword, JSON indent, uppercase hashes and the diff app takes effect.
- [ ] Screenshots for every `images/*.png` referenced in the README.

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/` (placeholders are in place)
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.` (no Quick Look is used)
- [x] No `## Setup` section (nothing needs manual setup; Clipboard History is mentioned where Diff needs it)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) is generated from README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never downloads or installs software
- [x] No compiled binaries; quarantine untouched
- [x] No hard-coded paths; `prefs.plist` is git-ignored; no secrets stored
- [x] AI assistance disclosed in the README (and to be disclosed in the forum post)
- [x] Version 1.0.0 in `workflow.json`; `python3 tools/build.py --package` builds `dist/alfred-devtoolbox-1.0.0.alfredworkflow`
- [ ] GitHub release with the `.alfredworkflow` attached (by the author)
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link (by the author)
