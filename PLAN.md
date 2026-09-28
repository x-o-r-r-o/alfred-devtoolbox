# DevToolbox — Plan

**Priority tier:** 1 · **Bundle ID:** `io.github.x-o-r-r-o.devtoolbox` · **Keywords:** `dev`, `json`, `uuid`, `jwt`, `regex`, `case`, `hash`, `enc`, `epoch`, `diff`, `fake`

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

## Round 4 (post-release audit, v1.0.1 / v1.1 candidates)
- [x] Alfred's runtime: every Script Filter and action run with `env -i` (no LANG, no Homebrew on PATH), Alfred's variables and cache/data paths with spaces, fresh install (no cache folder yet); covered by `Round4Tests`
- [x] Fix: `/pattern/ =>` removes matches (Alfred trims the trailing space of ` => `); the `regex` Script Filter no longer trims spaces (`argumenttrimmode` 1)
- [x] Fix: Clipboard History read waits up to 1 s for Alfred's database lock, and a busy database no longer says "turn Clipboard History on"
- [x] Fix: ⌥↩ finds `code` / `bbdiff` outside Alfred's PATH (inside the app bundle), and names the missing tool
- [x] Fix: the diff action prints nothing on success (a JXA "" prints "\n": possible blank notification)
- [x] Fix: an empty or space-padded keyword setting falls back to the default in the `dev` menu
- [x] New: `uuid v5|v3 <namespace> <name>` (name-based UUIDs), `uuid nil`, `uuid max`
- [x] New: `hash` hashes a file copied in Finder (instead of its name)
- [x] New: `diff` compares two files copied in Finder

## v1.2: Random and fake data (`fake`)
Benchmark (Raycast Store installs, 2026-09-28): Random Data Generator 36,234 · Password Generator 41,935 · Lorem Ipsum 109,833.
Alfred today: Fakeum (deanishe, Python 2: broken since macOS 12.3, its passwords are "not secure!!"), and Ruby-gem Faker workflows that need `gem install faker`.

What they get wrong, from their READMEs, CHANGELOGs and issues (raycast/extensions #11504 "generate X of random data" / lengths like `{16}`, #10890 auto-paste, #14710 project names, #20174 JWT, #13411 languages; alfred-fakeum "multiple columns", "entire User json object", count delimiter not typeable on a US keyboard, "other locale doesn't work"), and how `fake` answers:

- [x] Every generator in one list, filtered by typing (word prefixes, so `em` finds Email but not Lorem); rows only useful on request (UUID v7, ULID, HSL, JWT, MAC…) appear when asked for
- [x] Counts and lengths as plain numbers: `fake email 10`, `fake password 32 5`, `fake digits 16`, `fake hex 64`, `fake lorem 5`, or `x10` (Raycast #11504)
- [x] One coherent person and place per value across rows and record fields: the email and username match the name, the postcode and state match the city (Faker mixes them)
- [x] Records: `fake json 5 name,email,city` as JSON, CSV, SQL INSERT and JSON Lines from the same records; typed values (id, age, lat, bool); `key:field` renames (Fakeum "multiple columns", "User json object")
- [x] `fake 1-100` range (+ unique numbers / lottery draw with Floyd sampling, shuffled range, decimals), `fake 3d6+2`, `coin`, `pick a, b, c`, `shuffle`
- [x] Passwords from SecRandomCopyBytes (fallback /dev/urandom, then NSUUID), unbiased rejection sampling, every character class present, entropy shown; passphrase (1,198-word list), letters+digits, no look-alikes, PIN
- [x] Passwords copied and pasted as transient clipboard items (Conditional → Copy to Clipboard with "transient"), configurable; with the option off they still skip `resolve.sh`, so a password never becomes a process argument; never written to the cache
- [x] Safe data: emails at example.com/.net/.org (RFC 2606); phone numbers only from regulator-reserved fiction ranges (NANP 555-0100–0199, Ofcom drama numbers, ACMA 5550/7010, Bundesnetzagentur drama numbers, ARCEP 01 99 00…); Stripe's published test card numbers (Luhn-valid); IBANs with valid ISO 13616 and national check digits (FR RIB key, BE, ES) for DE, GB, FR, NL, AT, CH, BE, ES; IPv4 outside reserved ranges; locally administered MACs; IPv6 outside 2001:db8::/32
- [x] Locales en_US, en_GB, en_AU, de_DE, fr_FR (Workflow Configuration, or `@de` for one search); umlauts transliterated in emails (Müller → mueller)
- [x] User agents whose Chrome/Firefox/Safari versions follow the calendar; project names (`zesty-moon`, Raycast #14710); JWT signed with HS256 and "secret" that the `jwt` keyword verifies (#20174)
- [x] ↩ copy, ⌘↩ paste, ⌥↩ new values (reopens Alfred on that generator, so the same row is on top), ⌘Y Quick Look for multi-line values, ⌘L Large Type; stable `fake.<id>` uids; no rerun
- [x] `dev fake …` from the hub (without ⌥↩, which the hub doesn't connect)
- Data: `src/fake/*.json`, 34 KB written for DevToolbox (no Faker or EFF data copied; lorem ipsum is Cicero, public domain); read only by the `fake` command. Package: 389 KB → 561 KB (8 new icons ≈ 140 KB).
- Performance (median, osascript start-up included): 70–85 ms per keystroke; other keywords +3 ms for the larger script. Counts capped at 1,000 per row (100 when every generator is listed, 100 for passwords); values over 10 KB go through the cache so a broad filter with a big count stays a small response. Worst case measured: `json 1000` with 40 fields ≈ 0.5 s.

### Audits (v1.2)
- [x] Logic: card details matched a different card than the card row; ⌥↩ dropped the brand/country (`card amex`, `iban nl`); the Street and Postcode rows didn't match the Address row; `e-mail` found nothing and non-Latin words matched everything; `number 1-10` / `roll 2d6` weren't understood; `fake a 1000` produced a 745 KB response; two regexes held raw combining characters instead of escapes
- [x] Conventions: passwords went through `resolve.sh` argv when the transient option was off; prototype keys (`__proto__`, `constructor`, `toString` as fields, filters and locales), bidi/control characters in titles, invalid UTF-8 in argv, curly apostrophes, keyword clashes, explicit mod args
- [x] Alfred runtime: no LANG, bare PATH, fresh install (cache folder created on first Quick Look), workflow and cache folders with spaces, config values `1`/`0`/` 0 `/empty/padded locale/bogus locale; macOS 13: no JS syntax newer than Safari 16 (no `??`, `?.`, `replaceAll`, `.at()`, lookbehind), SecRandomCopyBytes bound through `ObjC.bindFunction` with /dev/urandom and NSUUID fallbacks
- [x] Independent audit: records with a `password` field (`fake json 5 email,password`) went through `resolve.sh` argv, the cache and the Quick Look file: they are now secrets like the password rows (transient, never on disk, up to 100 records); `iban uk` gave a German IBAN; `fake ip` put Lorem ipsum above IPv4 (a generator whose id starts with the word now comes first); `1000d1000` said "No matching generator"; small ranges draw one random byte instead of four (`digits 5000 1000` 3.6 s → 1.1 s); an all-zero SecRandomCopyBytes buffer (bridge failure) falls back to /dev/urandom instead of producing "aaaa" passwords. Checked: Conditional wiring matches alfredapp/openai-workflow (else without `sourceoutputuid`); phone ranges re-checked against ACMA, Ofcom, Bundesnetzagentur, ARCEP and NANPA lists; Stripe test numbers; IBAN national check digits; Floyd sampling; dice edge cases (`0d6`, `d0`, `d1`, negative)

## Tech
- **Stack:** JXA (`osascript -l JavaScript`) with the ObjC bridge: CommonCrypto (hashes, HMAC), zlib CRC32, NSPasteboard, NSTask. Bash for `resolve.sh`.
- **Dependencies:** none at runtime. `/usr/bin/sqlite3` (ships with macOS) reads Alfred's Clipboard History; the ⌥↩ diff apps are optional.
- No network, no secrets stored, no background processes except the regex watchdog (a `sh` child that is terminated when the script ends and checks its parent PID before killing).
- Target: macOS 13+ on Apple Silicon and Intel, Alfred 5 + Powerpack.

## Known limitations
- `fake`: ⌘C copies with Alfred's own copy, which isn't marked transient: use ↩ for passwords. The `dev fake …` rows go through the same transient copy.
- `fake`: job titles, lorem ipsum, countries and colour names are English in every locale; other locales (es, it, nl…) have no fiction-reserved phone ranges, so they aren't offered.
- `fake`: record field names can't contain spaces or commas (`first-name:first` works).
- A JWT secret typed after `jwt` is passed to the script as an argument (Alfred passes every Script Filter query that way), so it is briefly visible to `ps` for the current user. It is never shown, copied, logged or cached.
- `diff` writes the compared texts (which may come from Clipboard History) to the workflow cache folder; they are replaced by the next diff and never leave the Mac.
- `hash` treats a typed query that is an existing absolute path as a file.
- The ULID and UUID v7 generators are not monotonic within one millisecond across separate runs (batches are sorted).
- Regex uses JavaScriptCore semantics: lookbehind needs macOS 13.3+ (Safari 16.4's JavaScriptCore) and the `v` flag macOS 14+; older systems report "Invalid regular expression". Everything else the workflow uses is available on macOS 13.0 (`String.prototype.toWellFormed` is feature-detected; sqlite3 3.39 on macOS 13 supports `-json`).

## Verify in real Alfred
- [ ] Universal Action "Diff with DevToolbox" with two files selected in Finder passes both paths (tab-separated or as separate arguments).
- [ ] Universal Action "Hash with DevToolbox" on one file, with and without a checksum in the clipboard.
- [ ] ⌘C copies `text.copy` and ⌘L shows Large Type on normal rows and on the "result too large" rows.
- [ ] ⌥↩ on a diff opens FileMerge (`opendiff` returns without blocking Alfred) and the other apps when their CLI is installed; a missing CLI shows a notification.
- [ ] `epoch` with an empty query refreshes every second (`rerun`).
- [ ] Workflow Configuration: changing a keyword, JSON indent, uppercase hashes and the diff app takes effect.
- [ ] Screenshots for every `images/*.png` referenced in the README.
- [ ] `regex a  => ` keeps the trailing spaces with "Don't trim arg spaces" (`argumenttrimmode` 1 is the second entry of Alfred's popup; confirm it shows as selected in the Script Filter).
- [ ] `hash` / `diff` with files copied in Finder; ⌥↩ with VS Code installed but no `code` command in PATH.

## Verify in real Alfred (v1.2, `fake`)
- [x] ↩ on a password row: the Conditional takes the "Password" branch; Alfred's Clipboard History (and e.g. Maccy) doesn't keep it; with the checkbox off it's kept.
- [x] `fake json 3 email,password`: ↩ also takes the "Password" branch (transient), and ⌘Y shows nothing.
- [x] ⌘↩ pastes through the transient paste object; normal rows still go through `resolve.sh` (JSON 1000 records pastes in full).
- [x] ⌥↩ closes Alfred and reopens it on `fake <generator> …` with the same row selected on top (no Automation prompt, since Alfred runs the script).
- [x] ⌘Y Quick Look on paragraphs / JSON rows shows the text file from the cache folder.
- [x] Workflow Configuration: Fake data locale popup and the transient checkbox; `keyword_fake` changed to something else works for ⌥↩.
- [x] Screenshot `images/fake.png`.
  Checked in Alfred 5 on 2026-09-29: pasteboard carries `org.nspasteboard.TransientType` on the Password branch and not on normal rows or with the checkbox off; ⌘↩ pasted a password and 1000 JSON records into TextEdit; ⌥↩ reopened with `@de email 3` and with `keyword_fake` set to `mock`; ⌘Y showed the paragraphs and JSON previews and nothing on the JSON-with-password row.

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

## Ideas for v1.3 (fake data)
1. A Snippet Trigger (`:fake:email`) to type fake data anywhere (Fakeum's `xxfake`).
2. More locales (es_ES, it_IT, nl_NL, ja_JP) once fiction-reserved phone ranges are confirmed, or with phone numbers left out.
3. Date ranges (`fake date 2020-2024`) and custom formats.
4. Pinned/favourite generators on top (Raycast pins), using the Alfred knowledge (`skipknowledge` off) for the list only.
5. Custom SQL table name (`fake sql 5 name into customers`) and TSV/Markdown table output.
6. ACMA's 30 reserved Australian mobile numbers (0491 570 006…) and 1800/1300 numbers, so `@au phone` can give a mobile.
7. Documentation IPs (RFC 5737 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24; RFC 3849 2001:db8::/32) as a "safe" IP row beside the public-range ones.
8. `fake domain`/`url` on reserved names (`*.example`, `*.test`) as an option: today they use real TLDs, so a generated URL may exist.

## Ideas for v1.1
Ranked by value for effort (Raycast issues for Format JSON, UUID Generator, JWT Decoder, Change Case, Diff Checker, Unix Timestamp; 2026-09).
1. JSON path query (`json .users[0].name`): the most common request for JSON tools after formatting.
2. Epoch arithmetic and formats: `epoch now+2h`, `epoch 2024-01-01 in Asia/Tokyo`, custom strftime-style output.
3. Diff app choices: Cursor, Zed, Sublime Merge; and a Text View (Alfred 5.5) preview of the diff with colours.
4. Prettier-style compact arrays (`[1, 2, 3]` on one line) as a JSON indent option (raycast/extensions#23449).
5. HMAC of text with a typed key (`hash key=<secret>`) through CommonCrypto, and SHA-224/SHA-384.
6. JWT: RS256/ES256 verification with a pasted public key (Security framework), and building/signing an HS256 token.
7. Hash several copied files at once (checksum list output like `shasum`).
8. Prune `result-*.txt` in the cache after a day (they hold clipboard-derived text; the count is already bounded).
