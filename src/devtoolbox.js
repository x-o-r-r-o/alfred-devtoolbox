#!/usr/bin/osascript -l JavaScript
// DevToolbox for Alfred — developer transforms without dependencies.
// Usage: osascript -l JavaScript devtoolbox.js <command> [query]
ObjC.import("Foundation");
ObjC.import("AppKit");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

// Own-property lookup: user-controlled keys ("constructor", "__proto__") must never hit Object.prototype
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lookup = (o, k) => (own(o, k) ? o[k] : undefined);

const MAX_TEXT = 2 * 1024 * 1024; // ignore clipboards larger than 2 MB
const MAX_MATCHES = 50;
const INDENT = lookup({ "2": 2, "4": 4, tab: "\t" }, env("json_indent", "2")) || 2;
const HASH_UPPER = env("hash_uppercase", "0") === "1";

// ---------- helpers ----------

// Lone UTF-16 surrogates break NSString/NSJSONSerialization and encodeURIComponent
const wellFormed = String.prototype.toWellFormed
  ? (s) => s.toWellFormed()
  : (s) => s.replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (m) => (m.length === 2 ? m : "\ufffd"));

let clipTooLarge = false;
function clipboard() {
  let t;
  const fake = env("DT_TEST_CLIPBOARD", null); // used by the test suite only
  const fakeFile = env("DT_TEST_CLIPBOARD_FILE", null);
  if (fake !== null) t = fake;
  else if (fakeFile !== null) {
    const s = $.NSString.stringWithContentsOfFileEncodingError(fakeFile, $.NSUTF8StringEncoding, $());
    t = s.isNil() ? "" : s.js;
  } else {
    const s = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
    t = s.isNil() ? "" : s.js;
  }
  if (t.length > MAX_TEXT) {
    clipTooLarge = true;
    return "";
  }
  return wellFormed(t);
}

// Files copied in Finder (⌘C): their paths, or [] when the clipboard holds no files
function clipboardFiles() {
  const fake = env("DT_TEST_CLIPBOARD_FILES", null); // used by the test suite only (tab-separated)
  if (fake !== null) return fake ? fake.split("\t") : [];
  const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
  if (urls.isNil()) return [];
  const out = [];
  for (let i = 0; i < urls.count; i++) out.push(urls.objectAtIndex(i).path.js);
  return out;
}

function emptyClip(hint, icon) {
  return clipTooLarge
    ? info("Clipboard is larger than 2 MB", "Copy less text, or type it after the keyword", "error")
    : info("Clipboard is empty", hint, icon);
}

function inputOrClipboard(query) {
  if (query && typeof query === "object") return query; // already resolved by the smart hub
  return query !== "" ? { text: query, source: "query" } : { text: clipboard(), source: "clipboard" };
}

function oneLine(s, max = 120) {
  const t = String(s).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let end = max - 1;
  if (/[\ud800-\udbff]/.test(t[end - 1])) end--; // don't split an emoji's surrogate pair
  return t.slice(0, end) + "…";
}

// Display strings only: control characters and bidi overrides (which can disguise text, e.g. "exe.gnp") are removed
function displayText(s) {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[\t\n\r]/g, " ").replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : /(s|x|ch|sh)$/.test(word) ? "es" : "s"}`;
}

function safeCodePoint(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

// A result row whose arg is copied (↩) or pasted (⌘↩).
// Large values are written to the cache and resolved by ./resolve.sh after selection,
// so the Script Filter JSON stays small. text.copy defaults to arg, so it is only set when needed.
const LARGE = 50000;
let largeCount = 0;
function row(title, value, subtitle, icon, extra = {}) {
  let v = String(value);
  const text = {};
  if (v.length > LARGE) {
    const path = `${cacheDir()}/result-${largeCount++}.txt`;
    writeFile(path, v);
    v = `dtfile:${path}`;
    text.copy = "Result too large for ⌘C: press ↩ to copy it";
    text.largetype = "Result too large for Large Type";
  } else if (v.length > 5000) text.largetype = v.slice(0, 5000) + "…";
  const item = {
    title: oneLine(title),
    subtitle: subtitle || "↩ Copy · ⌘↩ Paste · ⌘L Large Type",
    arg: v,
    valid: v !== "",
    icon: { path: `icons/${icon}.png` },
    mods: { cmd: { arg: v, valid: v !== "", subtitle: "Paste into the frontmost app" } },
  };
  if (text.copy || text.largetype) item.text = text;
  return Object.assign(item, extra);
}

function info(title, subtitle, icon = "info") {
  return { title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon}.png` } };
}

// Rows need a uid for Alfred to keep the selected row while the Script Filter reruns (rerun):
// without one the selection jumps back to the first row on every rerun (found in real Alfred).
// The uid is the position plus the title with its numbers masked, so countdowns, prices and clocks
// keep it, while typing something new changes it and the selection resets to the top as usual.
function stableUids(items) {
  items.forEach((it, i) => {
    if (it && !it.uid) it.uid = `${i}|${String(it.title || "").replace(/[0-9]+/g, "#")}`;
  });
  return items;
}

function output(items, extra = {}) {
  stableUids(items);
  return JSON.stringify(Object.assign({ skipknowledge: true, items }, extra), (k, v) =>
    typeof v !== "string" ? v : k === "title" || k === "subtitle" ? wellFormed(displayText(v)) : wellFormed(v)
  );
}

// UTF-8 <-> "byte string" (each char 0–255)
function toBytes(s) {
  return unescape(encodeURIComponent(wellFormed(s)));
}
function fromBytes(b) {
  return decodeURIComponent(escape(b));
}

function utf8(s) {
  return $(wellFormed(s)).dataUsingEncoding($.NSUTF8StringEncoding);
}

// Random bytes from NSUUID (SecRandom/arc4random backed): 15 random bytes per UUID
function randomBytes(n) {
  const out = [];
  while (out.length < n) {
    const hex = $.NSUUID.UUID.UUIDString.js.replace(/-/g, "");
    // skip version nibble (12) and variant nibble (16)
    const clean = hex.slice(0, 12) + hex.slice(13, 16) + hex.slice(17);
    for (let i = 0; i + 1 < clean.length && out.length < n; i += 2) out.push(parseInt(clean.substr(i, 2), 16));
  }
  return out;
}

function hexOf(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function dataHex(data) {
  const bin = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding).js;
  const out = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = HEX[bin.charCodeAt(i)];
  return out.join("");
}

// Run a command with stdin, return stdout (trimmed) or null on failure
function pipe(path, args, input = "") {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const inP = $.NSPipe.pipe, outP = $.NSPipe.pipe;
  task.standardInput = inP;
  task.standardOutput = outP;
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice; // an undrained pipe could block the child
  if (!task.launchAndReturnError($())) return null;
  inP.fileHandleForWriting.writeData(utf8(input));
  inP.fileHandleForWriting.closeFile;
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  if (task.terminationStatus !== 0) return null;
  const s = $.NSString.alloc.initWithDataEncoding(out, $.NSUTF8StringEncoding);
  return s.isNil() ? null : s.js.trim();
}

// Kills this process after `seconds` and prints `fallback` to Alfred instead.
// Guards against runaway regular expressions on JavaScriptCore versions without a backtracking limit.
function watchdog(seconds, fallback) {
  const t = $.NSTask.alloc.init;
  t.executableURL = $.NSURL.fileURLWithPath("/bin/sh");
  t.arguments = [
    "-c",
    // fd 3 = Alfred's stdout; sleep doesn't inherit it so a terminated watchdog never holds the pipe.
    // Only kill if osascript is still our parent (it can't be a recycled pid then).
    'exec 3>&1 >/dev/null 2>&1; sleep "$1" 3>&-; [ "$(ps -o ppid= -p $$ | tr -d " ")" = "$2" ] || exit 0; kill -9 "$2" && printf "%s" "$3" >&3',
    "devtoolbox-watchdog",
    String(seconds),
    String($.NSProcessInfo.processInfo.processIdentifier),
    fallback,
  ];
  return t.launchAndReturnError($()) ? t : null;
}

// ---------- JSON ----------

function parseJSON(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Numbers that JSON.parse would change (integers beyond 2^53, 1.0, 1e400…) are kept verbatim:
// they are parsed as sentinel strings and put back when stringifying.
const SENT = "\uE000";
const RAW_NUMS = [];
const SENT_RE = /"\uE000(\d+)\uE000"/g;
const isRawNum = (v) => typeof v === "string" && /^\uE000\d+\uE000$/.test(v);
const restore = (s) => s.replace(SENT_RE, (_, i) => RAW_NUMS[i]);
const stringify = (v, indent) => restore(JSON.stringify(v, null, indent));
const STRING_RE = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"/; // unrolled: the (a|b)* form gives up on multi-MB strings

// Strict parse that preserves number literals and reports duplicate keys
function parseExact(text) {
  const p = parseJSON(text);
  if (!p.ok) return p;
  const tok = new RegExp(`${STRING_RE.source}|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|[{}\\[\\]:]`, "g");
  const stack = [], dupes = new Set(), parts = [];
  let m, prevStr = null, last = 0;
  while ((m = tok.exec(text))) {
    const t = m[0], c = t[0];
    if (c === '"') { prevStr = t; continue; }
    if (c === ":") {
      const top = stack[stack.length - 1];
      if (top && prevStr !== null) {
        const key = prevStr.includes("\\") ? JSON.parse(prevStr) : prevStr.slice(1, -1);
        if (top.has(key)) dupes.add(key);
        else top.add(key);
      }
    } else if (c === "{") stack.push(new Set());
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (String(Number(t)) !== t) {
      parts.push(text.slice(last, m.index), `"${SENT}${RAW_NUMS.length}${SENT}"`);
      RAW_NUMS.push(t);
      last = m.index + t.length;
    }
    prevStr = null;
  }
  const value = parts.length ? JSON.parse(parts.join("") + text.slice(last)) : p.value;
  return { ok: true, value, dupes: [...dupes], exact: parts.length > 0 };
}

// Where a strict JSON parse fails: { pos, msg } (JavaScriptCore's own error has no position)
function jsonError(s) {
  let i = 0;
  const fail = (msg) => { throw { pos: i, msg }; };
  const ws = () => { while (i < s.length && " \t\n\r".includes(s[i])) i++; };
  const esc = /["\\/bfnrt]|u[0-9a-fA-F]{4}/y;
  const lit = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])|(?:true|false|null)(?!\w)/y;
  function str() {
    i++;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { i++; return; }
      if (c === "\\") {
        esc.lastIndex = i + 1;
        const e = esc.exec(s);
        if (!e) { i++; fail("Invalid escape in string"); }
        i += 1 + e[0].length;
      } else if (c < " ") fail(c === "\n" ? "Line break inside a string" : "Control character inside a string");
      else i++;
    }
    fail("Unterminated string");
  }
  function value() {
    ws();
    const c = s[i];
    if (c === "{") {
      i++; ws();
      if (s[i] === "}") { i++; return; }
      for (;;) {
        ws();
        if (s[i] !== '"') fail(s[i] === "}" ? "Trailing comma" : "Expected a double-quoted key");
        str(); ws();
        if (s[i] !== ":") fail("Expected “:” after the key");
        i++; value(); ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return; }
        fail("Expected “,” or “}”");
      }
    }
    if (c === "[") {
      i++; ws();
      if (s[i] === "]") { i++; return; }
      for (;;) {
        ws();
        if (s[i] === "]") fail("Trailing comma");
        value(); ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return; }
        fail("Expected “,” or “]”");
      }
    }
    if (c === '"') return str();
    lit.lastIndex = i;
    const r = lit.exec(s);
    if (r) { i += r[0].length; return; }
    fail(i >= s.length ? "Unexpected end of input" : c === "'" ? "Single quotes are not allowed" : `Unexpected ${JSON.stringify(c)}`);
  }
  try {
    value(); ws();
    if (i < s.length) fail("Unexpected text after the JSON value");
    return null;
  } catch (e) {
    return e && e.pos !== undefined ? e : null; // RangeError on absurd nesting: no position
  }
}

function describeError(text, e) {
  const before = text.slice(0, e.pos);
  const line = (before.match(/\n/g) || []).length + 1;
  const col = e.pos - before.lastIndexOf("\n");
  const near = `${oneLine(text.slice(Math.max(0, e.pos - 15), e.pos))}▸${oneLine(text.slice(e.pos, e.pos + 15))}`;
  return `${e.msg} at line ${line}, column ${col} · near “${near}”`;
}

// Loose JS object literal -> JSON text (unquoted keys, single quotes, trailing commas, comments).
// A small scanner rather than regexes, so string contents like "a // b" or "x, }" stay intact.
function relaxedJSON(text) {
  const s = text.trim();
  if (!/^[\[{]/.test(s)) return null;
  const out = [];
  let i = 0, lastSig = -1; // index in out of the last significant token
  const n = s.length;
  const push = (t, sig = true) => { out.push(t); if (sig) lastSig = out.length - 1; };
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let j = i + 1, buf = "";
      while (j < n && s[j] !== c) {
        if (s[j] === "\\" && j + 1 < n) {
          buf += s[j + 1] === "'" ? "'" : s[j] + s[j + 1]; // \' is valid JS but not JSON
          j += 2;
        } else {
          buf += c === "'" && s[j] === '"' ? '\\"' : s[j] < " " ? JSON.stringify(s[j]).slice(1, -1) : s[j];
          j++;
        }
      }
      if (j >= n) return null;
      push(`"${buf}"`);
      i = j + 1;
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < n && s[i] !== "\n") i++;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
    } else if (/[A-Za-z_$]/.test(c)) {
      const id = /[A-Za-z_$][\w$]*/y;
      id.lastIndex = i;
      const w = id.exec(s)[0];
      i += w.length;
      let k = i;
      while (k < n && /\s/.test(s[k])) k++;
      push(s[k] === ":" ? JSON.stringify(w) : w);
    } else if (c === "}" || c === "]") {
      if (lastSig >= 0 && out[lastSig] === ",") out[lastSig] = "";
      push(c);
      i++;
    } else {
      push(c, !/\s/.test(c));
      i++;
    }
  }
  const t = out.join("");
  return parseJSON(t).ok ? t : null;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = isRawNum(v) ? restore(`"${v}"`) : typeof v === "object" ? stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(arr) {
  const cols = [], seen = new Set();
  for (const o of arr) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  return [cols.map(csvCell).join(","), ...arr.map((o) => cols.map((c) => csvCell(lookup(o, c))).join(","))].join("\n");
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const first = text.split("\n", 1)[0];
  const sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

function csvToJSON(text) {
  const rows = parseCSV(text);
  if (rows.length < 2 || rows[0].length < 2 || !rows.every((r) => r.length === rows[0].length)) return null;
  const [head, ...body] = rows;
  // Only canonical numbers become numbers, so 00501 (a ZIP code) or 1.50 stay text
  const conv = (v) => (/^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v ? Number(v) : v === "true" ? true : v === "false" ? false : v);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, conv(r[i])])));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = Object.create(null); // a plain {} would swallow a "__proto__" key
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

function tsName(key) {
  const n = String(key).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^[^A-Za-z_]+/, "");
  return n ? n[0].toUpperCase() + n.slice(1) : "Item";
}

function tsKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

// JSON -> TypeScript interfaces
function toTypeScript(value, rootName = "Root") {
  const decls = [];
  const used = new Set();
  function uniq(name) {
    let n = name, i = 2;
    while (used.has(n)) n = name + i++;
    used.add(n);
    return n;
  }
  function typeOf(v, name) {
    if (v === null) return "null";
    if (isRawNum(v)) return "number";
    if (Array.isArray(v)) {
      if (v.length === 0) return "unknown[]";
      const objs = v.filter((x) => x && typeof x === "object" && !Array.isArray(x));
      const types = new Set();
      if (objs.length) {
        const merged = Object.create(null);
        const counts = Object.create(null);
        for (const o of objs) for (const k of Object.keys(o)) {
          counts[k] = (counts[k] || 0) + 1;
          if (!(k in merged) || merged[k] === null) merged[k] = o[k];
        }
        types.add(iface(merged, name.replace(/([^s])s$/, "$1") || name, (k) => counts[k] < objs.length));
      }
      for (const x of v) if (!(x && typeof x === "object" && !Array.isArray(x))) types.add(typeOf(x, name));
      const t = [...types].join(" | ");
      return types.size > 1 ? `(${t})[]` : `${t}[]`;
    }
    if (typeof v === "object") return iface(v, name, () => false);
    return typeof v; // string | number | boolean
  }
  function iface(obj, name, optional) {
    const n = uniq(tsName(name));
    const lines = [];
    decls.push(null);
    const slot = decls.length - 1;
    for (const k of Object.keys(obj)) lines.push(`  ${tsKey(k)}${optional(k) ? "?" : ""}: ${typeOf(obj[k], k)};`);
    decls[slot] = `export interface ${n} {\n${lines.join("\n")}\n}`;
    return n;
  }
  const top = typeOf(value, rootName);
  if (!(value && typeof value === "object" && !Array.isArray(value))) decls.unshift(`export type ${rootName} = ${top};`);
  return decls.filter(Boolean).join("\n\n");
}

function jsonItems(query) {
  let src, filter = "";
  if (query && typeof query === "object") src = query; // from the smart hub
  else {
    const trimmed = query.trim();
    const looksLikeData = /^[\[{"]/.test(trimmed) || /^(-?\d|true$|false$|null$)/.test(trimmed);
    filter = looksLikeData ? "" : trimmed.toLowerCase();
    src = looksLikeData ? { text: trimmed, source: "query" } : { text: clipboard(), source: "clipboard" };
  }
  if (!src.text.trim()) return [emptyClip("Copy JSON, or type it after the keyword", "json")];

  let p = parseExact(src.text);
  let fixed = false;
  if (!p.ok) {
    const lines = src.text.trim().split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1 && lines.every((l) => parseJSON(l).ok)) {
      p = { ok: true, value: lines.map((l) => parseExact(l).value), dupes: [] };
      fixed = "JSON Lines";
    } else {
      const r = relaxedJSON(src.text);
      if (r !== null) { p = parseExact(r); fixed = "JS object"; }
    }
  }
  if (!p.ok) {
    const csv = csvToJSON(src.text);
    if (csv) return [
      info(`CSV · ${plural(csv.length, "row")}`, `Converted from ${src.source}`, "ok"),
      row("CSV → JSON", JSON.stringify(csv, null, INDENT), "Array of objects, one per row", "json", { match: "csv convert" }),
      row("CSV → JSON Lines", csv.map((o) => JSON.stringify(o)).join("\n"), "One object per line", "json", { match: "csv jsonl lines" }),
    ];
    const where = src.text.length <= MAX_TEXT ? jsonError(src.text) : null;
    return [
      info("Invalid JSON", `${where ? describeError(src.text, where) : p.error} (${src.source})`, "error"),
      row("Escape as JSON string", JSON.stringify(src.text), "Wrap the text in a JSON string literal · ↩ Copy · ⌘↩ Paste", "json"),
    ];
  }
  const v = p.value;
  const items = [
    row("Pretty print", stringify(v, INDENT), `Format JSON from ${src.source}`, "json", { match: "pretty format beautify" }),
    row("Minify", stringify(v), `Remove whitespace from JSON (${src.source})`, "json", { match: "minify compact" }),
    row("Sort keys", stringify(sortKeys(v), INDENT), "Pretty print with keys sorted alphabetically", "json", { match: "sort keys" }),
    row("TypeScript interfaces", toTypeScript(v), "Generate TypeScript types from this JSON", "ts", { match: "typescript ts types interface" }),
    row("Escape as JSON string", JSON.stringify(stringify(v)), "Minified JSON wrapped in a string literal", "json", { match: "escape stringify string" }),
  ];
  if (Array.isArray(v)) {
    items.push(row("JSON Lines", v.map((x) => stringify(x)).join("\n"), "One array element per line (JSONL / NDJSON)", "json", { match: "jsonl lines ndjson" }));
    if (v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x)))
      items.push(row("CSV", toCSV(v), "Array of objects as comma-separated values", "json", { match: "csv table export" }));
  }
  if (typeof v === "string" && !isRawNum(v)) {
    const inner = parseExact(v);
    items.unshift(row("Unescape string", inner.ok ? stringify(inner.value, INDENT) : v, "Decode the JSON string literal", "json", { match: "unescape unstringify" }));
  }
  const kind = v === null ? "null" : Array.isArray(v) ? plural(v.length, "item") : typeof v === "object" ? plural(Object.keys(v).length, "key") : isRawNum(v) ? "number" : typeof v;
  const size = toBytes(src.text).length;
  const notes = [];
  if (p.dupes && p.dupes.length) notes.push(`⚠ Duplicate ${p.dupes.length === 1 ? "key" : "keys"} ${oneLine(p.dupes.map((k) => JSON.stringify(k)).join(", "), 40)}: the last value is kept`);
  if (p.exact) notes.push("Numbers kept exactly as written");
  const head = info(fixed ? `Converted ${fixed} · ${kind}` : `Valid JSON · ${kind}`, [`${size < 1024 ? plural(size, "byte") : (size / 1024).toFixed(1) + " KB"} from ${src.source}`, ...notes].join(" · "), p.dupes && p.dupes.length ? "error" : "ok");
  items.unshift(head);
  if (!filter) return items;
  const words = filter.split(/\s+/);
  const hits = items.slice(1).filter((it) => words.every((w) => (it.title + " " + (it.match || "")).toLowerCase().includes(w)));
  return hits.length ? hits : [info("No matching action", "Try pretty, minify, sort, typescript or escape", "info")];
}

// ---------- Case ----------

function words(t) {
  return t
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{M}\p{N}]+/u) // keep combining marks (decomposed accents) inside words
    .filter(Boolean);
}

function textStats(t) {
  const chars = typeof Intl !== "undefined" && Intl.Segmenter ? [...new Intl.Segmenter().segment(t)].length : [...t].length;
  const w = (t.match(/[\p{L}\p{M}\p{N}'’_-]+/gu) || []).length;
  const lines = t === "" ? 0 : t.split(/\r\n|\r|\n/).length;
  return `${plural(chars, "character")} · ${plural(w, "word")} · ${plural(lines, "line")} · ${plural(toBytes(t).length, "byte")} UTF-8`;
}

function caseItems(query) {
  const src = inputOrClipboard(query);
  const t = src.text;
  if (!t.trim()) return [emptyClip("Type text after the keyword, or copy some", "case")];
  if (t.length > 5000) return [info("Text too long", "Case conversion works on up to 5,000 characters", "error")];
  const w = words(t), lw = w.map((x) => x.toLowerCase());
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const base = /\s/.test(t.trim()) ? t : w.join(" "); // identifiers like fooBar → "foo Bar"
  const sentence = base.toLowerCase().replace(/(^\s*\p{L}|[.!?]\s+\p{L})/gu, (m) => m.toUpperCase());
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "up", "via", "vs"]);
  const title = base.toLowerCase().replace(/[\p{L}\p{M}\p{N}'’]+/gu, (m, off) => (off === 0 || !small.has(m) ? cap(m) : m));
  const list = [
    ["camelCase", lw.map((x, i) => (i ? cap(x) : x)).join("")],
    ["PascalCase", lw.map(cap).join("")],
    ["snake_case", lw.join("_")],
    ["CONSTANT_CASE", lw.join("_").toUpperCase()],
    ["kebab-case", lw.join("-")],
    ["Train-Case", lw.map(cap).join("-")],
    ["dot.case", lw.join(".")],
    ["path/case", lw.join("/")],
    ["Title Case", title],
    ["Sentence case", sentence],
    ["lower case", t.toLowerCase()],
    ["UPPER CASE", t.toUpperCase()],
    ["sWAP cASE", [...t].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("")],
  ];
  const items = list.filter(([, v]) => v).map(([name, v]) => row(`${oneLine(v, 80)}`, v, `${name} · ↩ Copy · ⌘↩ Paste`, "case", { match: name.toLowerCase() }));
  items.push(info(textStats(t), `Counts for the ${src.source}`, "info"));
  return items;
}

// ---------- UUID & IDs ----------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NANO = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const UUID_RE = /^[{(]?(?:urn:uuid:)?([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})[})]?$/i;
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;

function uuid4() {
  return $.NSUUID.UUID.UUIDString.js.toLowerCase();
}

function uuid7() {
  const ms = Date.now();
  const r = randomBytes(10);
  const b = [];
  for (let i = 5; i >= 0; i--) b.push(Math.floor(ms / 2 ** (8 * i)) & 0xff);
  b.push(0x70 | (r[0] & 0x0f), r[1]);
  b.push(0x80 | (r[2] & 0x3f), ...r.slice(3, 10));
  const h = hexOf(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function ulid() {
  let t = Date.now(), time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits = 16 chars of 5 bits
  const r = randomBytes(10);
  let bits = r.map((x) => x.toString(2).padStart(8, "0")).join(""), rand = "";
  for (let i = 0; i < 80; i += 5) rand += CROCKFORD[parseInt(bits.substr(i, 5), 2)];
  return time + rand;
}

function nanoid(size = 21) {
  return randomBytes(size).map((b) => NANO[b & 63]).join("");
}

// Name-based UUID (RFC 9562 v3 = MD5, v5 = SHA-1) of a UTF-8 name in a namespace UUID
const UUID_NS = { dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8", oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8", x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8" };
function nameUUID(ver, nsHex, name) {
  const bin = nsHex.match(/../g).map((x) => String.fromCharCode(parseInt(x, 16))).join("") + toBytes(name);
  const h = digestData(ver === 3 ? "md5" : "sha1", $(bin).dataUsingEncoding($.NSISOLatin1StringEncoding)).slice(0, 32);
  const hex = h.slice(0, 12) + ver.toString(16) + h.slice(13, 16) + (8 | (parseInt(h[16], 16) & 3)).toString(16) + h.slice(17);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nameUUIDItems(query) {
  const m = query.trim().match(/^v([35])(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i);
  if (!m) return null;
  const ver = Number(m[1]);
  const nsArg = m[2] || "";
  const nsMatch = nsArg.match(UUID_RE);
  const nsHex = lookup(UUID_NS, nsArg.toLowerCase()) ? UUID_NS[nsArg.toLowerCase()].replace(/-/g, "") : nsMatch ? nsMatch.slice(1).join("").toLowerCase() : null;
  const help = `Type a namespace (dns, url, oid, x500 or a UUID) and a name, e.g. v${ver} dns example.com`;
  if (!nsArg) return [info(`UUID v${ver} (name-based, ${ver === 3 ? "MD5" : "SHA-1"})`, help, "uuid")];
  if (!nsHex) return [info("Unknown namespace", help, "error")];
  if (m[3] === undefined) return [info(`Type a name after the namespace`, help, "uuid")];
  const u = nameUUID(ver, nsHex, m[3]);
  return [
    row(`UUID v${ver}: ${u}`, u, `Name-based UUID of “${oneLine(m[3], 60)}” in the ${lookup(UUID_NS, nsArg.toLowerCase()) ? nsArg.toUpperCase() : "given"} namespace`, "uuid"),
    row(`UUID v${ver} uppercase: ${u.toUpperCase()}`, u.toUpperCase(), "Uppercase", "uuid"),
  ];
}

function validDate(ms) {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
}

function dateRows(ms, label) {
  if (!validDate(ms)) return [info(`${label}: out of range`, String(ms), "error")];
  const d = new Date(ms);
  return [
    row(`${label}: ${localString(d)}`, d.toISOString(), `${relTime(ms)} · ${d.toISOString()} · ↩ Copy ISO 8601`, "clock"),
    row(`${label} (Unix ms): ${ms}`, String(ms), "Unix milliseconds", "clock"),
  ];
}

// Inspect an existing UUID or ULID: version, variant, embedded time, other spellings
function decodeIdItems(text, strict = false) {
  const t = text.trim();
  // strict (smart hub): a bare 32-hex string is more likely an MD5 than a UUID
  const u = strict && (t.match(/-/g) || []).length !== 4 ? null : t.match(UUID_RE);
  if (u) {
    const hex = u.slice(1).join("").toLowerCase();
    const dashed = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const ver = parseInt(hex[12], 16), vn = parseInt(hex[16], 16);
    const variant = vn < 8 ? "NCS (reserved)" : vn < 12 ? "RFC 9562" : vn < 14 ? "Microsoft (reserved)" : "Future (reserved)";
    const special = /^0{32}$/.test(hex) ? "Nil UUID" : /^f{32}$/.test(hex) ? "Max UUID" : null;
    const items = [info(special || `UUID version ${ver} · ${variant}`, special ? "All bits the same" : { 1: "Time-based (Gregorian, MAC)", 2: "DCE Security", 3: "Name-based (MD5)", 4: "Random", 5: "Name-based (SHA-1)", 6: "Time-based (reordered)", 7: "Time-ordered (Unix ms)", 8: "Custom" }[ver] || "Unknown version", "uuid")];
    if (!special && vn >= 8 && vn < 12) {
      let ms = null;
      if (ver === 7) ms = parseInt(hex.slice(0, 12), 16);
      else if (ver === 1 || ver === 6) {
        const ts = ver === 1 ? BigInt("0x" + hex.slice(13, 16) + hex.slice(8, 12) + hex.slice(0, 8)) : BigInt("0x" + hex.slice(0, 12) + hex.slice(13, 16));
        ms = Number(ts / 10000n) - 12219292800000; // 100 ns intervals since 1582-10-15
      }
      if (ms !== null) items.push(...dateRows(ms, "Created"));
    }
    items.push(
      row(dashed, dashed, "Lowercase", "uuid"),
      row(dashed.toUpperCase(), dashed.toUpperCase(), "Uppercase", "uuid"),
      row(hex, hex, "Without dashes", "uuid"),
      row(`{${dashed.toUpperCase()}}`, `{${dashed.toUpperCase()}}`, "Braces (Windows registry / .NET)", "uuid"),
      row(`urn:uuid:${dashed}`, `urn:uuid:${dashed}`, "URN", "uuid")
    );
    return items;
  }
  if (ULID_RE.test(t)) {
    const up = t.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
    let ms = 0;
    for (const c of up.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(c);
    return [info("ULID", "Sortable ID with a millisecond timestamp", "uuid"), ...dateRows(ms, "Created"), row(up, up, "Canonical (uppercase)", "uuid")];
  }
  return null;
}

function uuidItems(query) {
  const decoded = decodeIdItems(query);
  if (decoded) return decoded;
  const named = nameUUIDItems(query);
  if (named) return named;
  const q = query.trim().toLowerCase();
  const m = q.match(/^(\d+)/);
  const count = Math.min(Math.max(m ? parseInt(m[1], 10) : 1, 1), 1000);
  const filter = q.replace(/^\d+\s*/, "");
  const gen = (f, sorted) => { const a = Array.from({ length: count }, f); return (sorted ? a.sort() : a).join("\n"); };
  const n = count > 1 ? ` × ${count}` : "";
  const v4 = gen(uuid4);
  const items = [
    row(`UUID v4${n}`, v4, count > 1 ? oneLine(v4, 80) : "Random UUID · ↩ Copy · ⌘↩ Paste", "uuid", { match: "v4 uuid random" }),
    row(`UUID v4 uppercase${n}`, v4.toUpperCase(), "Uppercase random UUID", "uuid", { match: "v4 upper uppercase" }),
    row(`UUID v4 without dashes${n}`, v4.replace(/-/g, ""), "32 hex characters", "uuid", { match: "v4 nodash compact hex" }),
    // several v7/ULIDs made in the same millisecond are sorted so the list stays in creation order
    row(`UUID v7${n}`, gen(uuid7, true), "Time-ordered UUID (RFC 9562)", "uuid", { match: "v7 time sortable" }),
    row(`ULID${n}`, gen(ulid, true), "Sortable 26-character ID", "uuid", { match: "ulid sortable" }),
    row(`Nano ID${n}`, gen(() => nanoid()), "21-character URL-safe ID", "uuid", { match: "nanoid nano" }),
  ];
  for (const it of items) if (count === 1) it.title = `${it.title}: ${it.arg}`;
  if (!filter) return items;
  // Only when asked for, so they don't crowd the list
  items.push(
    row(`Nil UUID: ${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, "00000000-0000-0000-0000-000000000000", "All zeros (empty UUID)", "uuid", { match: "nil empty zero null" }),
    row("Max UUID: ffffffff-ffff-ffff-ffff-ffffffffffff", "ffffffff-ffff-ffff-ffff-ffffffffffff", "All ones (RFC 9562)", "uuid", { match: "max" }),
    info("UUID v5 or v3 from a name", "Type v5 or v3, a namespace (dns, url, oid, x500 or a UUID) and a name", "uuid")
  );
  items[items.length - 1].match = "v5 v3 name namespace sha md5";
  const hits = items.filter((it) => filter.split(/\s+/).every((w) => (it.title + " " + it.match).toLowerCase().includes(w)));
  return hits.length ? hits : [info("Unknown ID type", "Try v4, upper, nodash, v7, ulid, nano, nil, max or v5 dns example.com. Prefix a number for several, e.g. 5 v7", "info")];
}

// ---------- JWT ----------

function b64urlData(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(t, 0);
  return data.isNil() ? null : data;
}

function b64urlDecode(s) {
  const data = b64urlData(s);
  if (!data) return null;
  const str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return str.isNil() ? null : str.js;
}

function relTime(ms) {
  if (!validDate(ms)) return "out of range";
  const diff = ms - Date.now(), a = Math.abs(diff);
  const units = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1e3]];
  for (const [u, size] of units) {
    if (a >= size || u === "second") {
      const n = Math.round(a / size);
      return diff >= 0 ? `in ${plural(n, u)}` : `${plural(n, u)} ago`;
    }
  }
}

function localString(d) {
  const nd = $.NSDate.dateWithTimeIntervalSince1970(d.getTime() / 1000);
  return $.NSDateFormatter.localizedStringFromDateDateStyleTimeStyle(nd, $.NSDateFormatterMediumStyle, $.NSDateFormatterMediumStyle).js;
}

function localISO(d) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", pad = (x) => String(Math.floor(Math.abs(x))).padStart(2, "0");
  const y = d.getFullYear();
  const year = y >= 0 && y <= 9999 ? String(y).padStart(4, "0") : (y < 0 ? "-" : "+") + String(Math.abs(y)).padStart(6, "0");
  return `${year}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const HMAC = { HS256: [2, 32], HS384: [3, 48], HS512: [4, 64] };
let hmacBound = false;

function hmacB64url(alg, secret, message) {
  if (!hmacBound) {
    ObjC.bindFunction("CCHmac", ["void", ["unsigned int", "void *", "unsigned long", "void *", "unsigned long", "void *"]]);
    hmacBound = true;
  }
  const [id, len] = HMAC[alg];
  const k = utf8(secret), m = utf8(message), out = $.NSMutableData.dataWithLength(len);
  $.CCHmac(id, k.bytes, k.length, m.bytes, m.length, out.mutableBytes);
  return out.base64EncodedStringWithOptions(0).js.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cleanToken(s) {
  return s.trim().replace(/^(authorization:\s*)?bearer\s+/i, "").replace(/^["'`]+|["'`,;]+$/g, "");
}

function jwtItems(query) {
  // "jwt <token> [secret]", or "jwt <secret>" with the token in the clipboard
  const typed = query.trim();
  const cq = cleanToken(typed);
  const first = cq.split(/\s+/)[0] || "";
  let q, secret = "";
  if (JWT_RE.test(first)) {
    q = first;
    secret = cq.slice(first.length).trim();
  } else {
    const clip = cleanToken(clipboard());
    if (JWT_RE.test(clip)) {
      q = clip;
      secret = typed;
    } else if (typed) return [info("Not a JWT", "Expected header.payload.signature (query)", "error")];
    else if (!clip) return [emptyClip("Copy a JWT, or paste it after the keyword", "jwt")];
    else return [info("Not a JWT", "Expected header.payload.signature (clipboard)", "error")];
  }
  const [h, p, sig] = q.split(".");
  const header = b64urlDecode(h), payload = b64urlDecode(p);
  const hj = header && parseJSON(header);
  if (!hj || !hj.ok || !hj.value || typeof hj.value !== "object" || Array.isArray(hj.value))
    return [info("Couldn’t decode the JWT", "The header is not base64url-encoded JSON", "error")];
  const hv = hj.value, alg = typeof hv.alg === "string" ? hv.alg : "";
  const pj = payload !== null ? parseJSON(payload) : null;
  const claims = pj && pj.ok && pj.value && typeof pj.value === "object" && !Array.isArray(pj.value) ? pj.value : null;
  const items = [];
  const now = Date.now();
  // Signature
  let sigNote = "Signature not verified";
  if (alg.toLowerCase() === "none") {
    items.push(info("⚠ Unsigned token (alg: none)", "Anyone can forge this token; never accept it server-side", "error"));
    sigNote = "Unsigned";
  } else if (secret) {
    if (own(HMAC, alg)) {
      const ok = hmacB64url(alg, secret, `${h}.${p}`) === sig;
      items.push(info(ok ? `✓ Signature verified (${alg})` : `✗ Invalid signature (${alg})`, ok ? "The secret matches" : "The secret doesn’t match, or the token was changed", ok ? "ok" : "error"));
      sigNote = ok ? "Signature verified" : "Invalid signature";
    } else items.push(info(`Can’t verify ${alg || "this"} signatures`, "Only HS256, HS384 and HS512 secrets can be checked here", "info"));
  } else if (own(HMAC, alg)) sigNote = "Signature not verified · type the secret after the keyword to check it";
  // Validity
  if (claims && typeof claims.nbf === "number" && validDate(claims.nbf * 1000) && claims.nbf * 1000 > now)
    items.unshift(info(`Not valid yet · starts ${relTime(claims.nbf * 1000)}`, `${localString(new Date(claims.nbf * 1000))} · ${sigNote}`, "error"));
  else if (claims && typeof claims.exp === "number" && validDate(claims.exp * 1000)) {
    const exp = claims.exp * 1000;
    items.unshift(info(exp > now ? `Valid · expires ${relTime(exp)}` : `Expired ${relTime(exp)}`, `${localString(new Date(exp))} · ${sigNote}`, exp > now ? "ok" : "error"));
  } else items.unshift(info(claims ? "No expiry (exp) claim" : "Payload is not a JSON object", sigNote, "info"));
  // Shown and copied with number literals kept exactly (large numeric IDs would otherwise be rounded)
  const px = pj && pj.ok ? parseExact(payload) : null;
  if (px) {
    const v = px.value;
    items.push(row("Payload", stringify(v, INDENT), oneLine(stringify(v), 100), "jwt"));
  } else {
    const raw = payload !== null ? payload : p;
    items.push(row("Payload (not JSON)", raw, oneLine(raw, 100), "jwt"));
  }
  items.push(row(`Header · ${alg || "no alg"}`, JSON.stringify(hv, null, INDENT), oneLine(JSON.stringify(hv), 100), "jwt"));
  const NAMES = { iss: "Issuer", sub: "Subject", aud: "Audience", exp: "Expires", nbf: "Not before", iat: "Issued at", jti: "JWT ID", scope: "Scope", email: "Email", name: "Name" };
  for (const [k, v] of Object.entries(claims ? px.value : {})) {
    const label = own(NAMES, k) ? `${NAMES[k]} (${k})` : k;
    if (["exp", "nbf", "iat", "auth_time"].includes(k) && typeof v === "number" && validDate(v * 1000)) {
      const d = new Date(v * 1000);
      items.push(row(`${label}: ${localString(d)}`, String(v), `${relTime(v * 1000)} · ${d.toISOString()} · ↩ Copy value`, "clock"));
    } else {
      const val = isRawNum(v) ? restore(`"${v}"`) : typeof v === "string" ? v : stringify(v);
      items.push(row(`${label}: ${val}`, val, "↩ Copy value · ⌘↩ Paste", "jwt"));
    }
  }
  return items;
}

// ---------- Regex ----------

function parseRegex(q) {
  // "/pattern/flags => replacement" or "pattern => replacement"
  let replacement = null;
  const arrow = q.lastIndexOf(" => ");
  if (arrow >= 0) {
    // \n and \t in the replacement insert a line break or tab (they can't be typed in Alfred)
    replacement = q.slice(arrow + 4).replace(/\\([nt\\])/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"));
    q = q.slice(0, arrow);
  } else if (/^\/.*\/[dgimsuyv]* =>$/s.test(q)) {
    // "/pattern/ => " whose trailing space was trimmed away: replace matches with nothing
    replacement = "";
    q = q.slice(0, -3);
  }
  let pattern = q, flags = "g";
  const m = q.match(/^\/(.*)\/([dgimsuyv]*)$/s);
  if (m) {
    pattern = m[1];
    flags = m[2].includes("g") ? m[2] : m[2] + "g";
  }
  return { pattern, flags, replacement };
}

// JavaScriptCore silently gives up (returns "no match") after ~1 s of backtracking; detect it
const SLOW_MS = 800;
function execAll(re, s) {
  const matches = [];
  let slow = false;
  re.lastIndex = 0;
  for (;;) {
    const t0 = Date.now();
    const m = re.exec(s);
    if (!m) {
      slow = Date.now() - t0 > SLOW_MS;
      break;
    }
    matches.push(m);
    if (m[0] === "") {
      const cp = s.codePointAt(re.lastIndex);
      re.lastIndex += (re.unicode || re.unicodeSets) && cp > 0xffff ? 2 : 1;
    }
    if (re.lastIndex > s.length) break;
  }
  return { matches, slow };
}

const SLOW_INFO = () => info("⚠ Pattern too slow: matching gave up", "Catastrophic backtracking (e.g. nested quantifiers like (a+)+). Results are incomplete", "error");

function regexItems(query) {
  if (!query.trim()) return [info("Type a regular expression", "Tests it against the clipboard. Use /pattern/flags, and add “ => replacement” to replace", "regex")];
  const subject = clipboard();
  if (!subject) return [emptyClip("Copy the text to test against", "regex")];
  const { pattern, flags, replacement } = parseRegex(query);
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    return [info("Invalid regular expression", e.message, "error")];
  }
  if (env("DT_TEST_HANG", "") === "1") for (;;); // test hook: simulates a JavaScriptCore without a backtracking limit
  let { matches, slow } = execAll(re, subject);
  const items = [];
  if (replacement !== null) {
    const t0 = Date.now();
    const out = subject.replace(re, replacement);
    slow = slow || Date.now() - t0 > SLOW_MS;
    items.push(row(`Replace ${plural(matches.length, "match")}: ${oneLine(out, 80)}`, out, "Clipboard with replacements applied · ↩ Copy · ⌘↩ Paste", "regex"));
  }
  if (slow) items.unshift(SLOW_INFO());
  if (!matches.length) {
    if (!slow) items.push(info("No matches", `/${pattern}/${flags} against ${plural(subject.length, "character")} of clipboard`, "info"));
    return items;
  }
  const all = matches.map((m) => m[0]).join("\n");
  items.push(row(`${plural(matches.length, "match")} · /${pattern}/${flags}`, all, "↩ Copy all matches, one per line · ⌘↩ Paste", "ok"));
  for (const [i, m] of matches.slice(0, MAX_MATCHES).entries()) {
    const groups = m.slice(1).map((g, j) => `$${j + 1}=${g === undefined ? "∅" : g}`);
    if (m.groups) for (const [k, g] of Object.entries(m.groups)) groups.push(`${k}=${g === undefined ? "∅" : g}`);
    items.push(row(`${i + 1}. ${m[0] === "" ? "(empty match)" : m[0]}`, m[0], `at ${m.index}${groups.length ? " · " + oneLine(groups.join("  "), 100) : ""}`, "regex"));
  }
  if (matches.length > MAX_MATCHES) items.push(info(`…and ${matches.length - MAX_MATCHES} more`, "Copy all matches from the summary row", "info"));
  return items;
}

// ---------- Hash ----------

let CRC_TABLE = null;
function crc32JS(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// CommonCrypto (and zlib for CRC32) through the ObjC bridge: fast, no subprocess
const CC = { md5: ["CC_MD5", 16], sha1: ["CC_SHA1", 20], sha256: ["CC_SHA256", 32], sha512: ["CC_SHA512", 64] };
for (const [fn] of Object.values(CC)) ObjC.bindFunction(fn, ["void *", ["void *", "unsigned int", "void *"]]);
let zlibCRC = true;
try {
  ObjC.bindFunction("crc32", ["unsigned long", ["unsigned long", "void *", "unsigned int"]]);
} catch (e) {
  zlibCRC = false;
}

function digestData(algo, data) {
  const [fn, len] = CC[algo];
  const out = $.NSMutableData.dataWithLength(len);
  $[fn](data.bytes, data.length, out.mutableBytes);
  return dataHex(out);
}

function crc32Data(data) {
  let v = null;
  if (zlibCRC) {
    try {
      v = Number($.crc32(0, data.bytes, data.length));
    } catch (e) {
      zlibCRC = false;
    }
  }
  if (v === null || !Number.isFinite(v)) v = crc32JS($.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding).js);
  return v.toString(16).padStart(8, "0");
}

const MAX_FILE = 1024 * 1024 * 1024; // CC_* take a 32-bit length

// A checksum in the clipboard: a bare hex digest, "SHA256: …", or `shasum` / BSD output ("<hash>  file", "SHA256 (file) = <hash>")
function clipboardChecksum() {
  const clip = clipboard();
  if (!clip || clip.length > 10000) return "";
  for (const m of clip.matchAll(/[0-9a-f]+/gi)) {
    const before = clip[m.index - 1], after = clip[m.index + m[0].length];
    if ((before && /\w/.test(before)) || (after && /\w/.test(after))) continue;
    if ([8, 32, 40, 64, 128].includes(m[0].length)) return m[0].toLowerCase();
  }
  return "";
}

function hashItems(query) {
  let data, label, isFile = false;
  let path = typeof query === "string" ? query.trim().replace(/^~(?=\/)/, $.NSHomeDirectory().js) : "";
  let copied = false;
  if (query === "") {
    // Nothing typed: a file copied in Finder is hashed rather than its name
    const files = clipboardFiles();
    if (files.length > 1) return [info(`${plural(files.length, "file")} copied`, "Copy a single file to hash it, or type text after the keyword", "error")];
    if (files.length === 1) { path = files[0]; copied = true; }
  }
  const fm = $.NSFileManager.defaultManager, isDir = Ref();
  if (path.startsWith("/") && fm.fileExistsAtPathIsDirectory(path, isDir)) {
    if (isDir[0]) return [info("That’s a folder", "Hash works on a single file", "error")];
    const attrs = fm.attributesOfItemAtPathError(path, $());
    if (attrs.isNil()) return [info("Couldn’t read that file", path, "error")];
    if (Number(attrs.fileSize) > MAX_FILE) return [info("File too large", "Hashing is limited to 1 GB", "error")];
    data = $.NSData.dataWithContentsOfFileOptionsError(path, 1, $());
    if (data.isNil()) return [info("Couldn’t read that file", path, "error")];
    label = `${copied ? "copied file " : ""}${path.split("/").pop()} (${plural(Number(data.length), "byte")})`;
    isFile = true;
  } else {
    const src = inputOrClipboard(query);
    if (!src.text) return [emptyClip("Type text after the keyword, or copy some", "hash")];
    data = utf8(src.text);
    label = `${src.source} (${plural(Number(data.length), "byte")})`;
  }
  // Compare with a checksum in the clipboard, e.g. copied from a download page
  const expected = isFile && !copied ? clipboardChecksum() : "";
  const up = (h) => (HASH_UPPER ? h.toUpperCase() : h);
  const items = [];
  let matched = false;
  for (const [name, algo] of [["MD5", "md5"], ["SHA-1", "sha1"], ["SHA-256", "sha256"], ["SHA-512", "sha512"], ["CRC32", "crc32"]]) {
    const h = algo === "crc32" ? crc32Data(data) : digestData(algo, data);
    const ok = expected && h === expected;
    matched = matched || ok;
    items.push(row(`${name}: ${up(h)}`, up(h), `${ok ? "✓ Matches the clipboard · " : ""}${name} of ${label}`, ok ? "ok" : "hash"));
  }
  if (expected) items.unshift(info(matched ? "✓ Checksum matches the clipboard" : "✗ No hash matches the clipboard", `Clipboard: ${expected.slice(0, 16)}…`, matched ? "ok" : "error"));
  return items;
}

// ---------- Encode / decode ----------

const HTML_ENC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const HTML_DEC = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–" };
const PRINTABLE = /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/;

function b64encode(text) {
  return utf8(text).base64EncodedStringWithOptions(0).js;
}

function b64decode(text) {
  const t = text.trim().replace(/\s+/g, "");
  if (t.length < 8 || t.length % 4 === 1 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null;
  return b64urlDecode(t.replace(/=+$/, ""));
}

function encItems(query) {
  const src = inputOrClipboard(query);
  const t = src.text;
  if (!t) return [emptyClip("Type text after the keyword, or copy some", "enc")];
  const items = [];
  const decoded = [];
  // Decoders first, only when they apply
  const b = b64decode(t);
  if (b !== null && b !== "" && PRINTABLE.test(b)) decoded.push(row(`Base64 decode: ${oneLine(b, 80)}`, b, "Decoded text · ↩ Copy · ⌘↩ Paste", "enc"));
  if (/%[0-9A-Fa-f]{2}/.test(t)) {
    try {
      const u = decodeURIComponent(t.replace(/\+/g, " "));
      decoded.push(row(`URL decode: ${oneLine(u, 80)}`, u, "Percent-decoded text", "enc"));
    } catch (e) {}
  }
  if (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(t)) {
    const h = t.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e) =>
      e[0] === "#" ? safeCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) ?? all : lookup(HTML_DEC, e.toLowerCase()) ?? all
    );
    if (h !== t) decoded.push(row(`HTML decode: ${oneLine(h, 80)}`, h, "Entities replaced with characters", "enc"));
  }
  if (/^(?:[0-9a-f]{2}\s?)+$/i.test(t.trim()) && t.trim().replace(/\s/g, "").length % 2 === 0) {
    try {
      const bytes = t.trim().replace(/\s/g, "").match(/../g).map((x) => String.fromCharCode(parseInt(x, 16))).join("");
      const s = fromBytes(bytes);
      if (/[\p{L}\p{N}]/u.test(s) && PRINTABLE.test(s)) decoded.push(row(`Hex decode: ${oneLine(s, 80)}`, s, "UTF-8 text from hex bytes", "enc"));
    } catch (e) {}
  }
  if (/\\u[0-9a-f]{4}|\\u\{[0-9a-f]+\}/i.test(t)) {
    const s = t.replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi, (all, a, c) => safeCodePoint(parseInt(a || c, 16)) ?? all);
    if (s !== t) decoded.push(row(`Unicode unescape: ${oneLine(s, 80)}`, s, "\\uXXXX sequences replaced", "enc"));
  }
  if (/\\[nrt"'\\0]/.test(t)) {
    const s = t.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[nrt0"'\\bfv])/gi, (all, e) =>
      ({ n: "\n", r: "\r", t: "\t", 0: "\0", b: "\b", f: "\f", v: "\v" })[e] ?? (/^[ux]/i.test(e) ? safeCodePoint(parseInt(e.replace(/[ux{}]/gi, ""), 16)) ?? all : e));
    decoded.push(row(`Backslash unescape: ${oneLine(s, 80)}`, s, "\\n, \\t, \\\" … replaced with characters", "enc"));
  }
  const num = t.trim().match(/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|-?\d{1,40})$/i);
  if (num) {
    // BigInt keeps every digit, even beyond 2^53
    const val = BigInt(num[1].replace(/^0([xbo])/i, (_, p) => "0" + p.toLowerCase()));
    const neg = val < 0n, abs = neg ? -val : val, sign = neg ? "-" : "";
    for (const [label, str] of [["Decimal", String(val)], ["Hexadecimal", `${sign}0x${abs.toString(16)}`], ["Binary", `${sign}0b${abs.toString(2)}`], ["Octal", `${sign}0o${abs.toString(8)}`]])
      if (str.toLowerCase() !== num[1].toLowerCase()) decoded.push(row(`${label}: ${str}`, str, `Number base conversion of ${num[1]}`, "hash"));
  }
  items.push(...decoded);
  const b64 = b64encode(t);
  items.push(row(`Base64: ${oneLine(b64, 80)}`, b64, `Encode ${src.source} as Base64`, "enc"));
  const b64u = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  items.push(row(`Base64URL: ${oneLine(b64u, 80)}`, b64u, "URL-safe Base64 without padding", "enc"));
  const url = encodeURIComponent(t);
  items.push(row(`URL encode: ${oneLine(url, 80)}`, url, "Percent-encode for use in a URL component", "enc"));
  const html = t.replace(/[&<>"']/g, (c) => HTML_ENC[c]);
  items.push(row(`HTML encode: ${oneLine(html, 80)}`, html, "Escape & < > \" '", "enc"));
  const hex = dataHex(utf8(t));
  items.push(row(`Hex: ${oneLine(hex, 80)}`, hex, "UTF-8 bytes as hex", "enc"));
  const esc = JSON.stringify(t).slice(1, -1);
  if (esc !== t) items.push(row(`Backslash escape: ${oneLine(esc, 80)}`, esc, "Escape quotes, backslashes and control characters", "enc"));
  const uni = t.replace(/[^\x00-\x7f]/gu, (c) => { const cp = c.codePointAt(0); return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`; });
  if (uni !== t) items.push(row(`Unicode escape: ${oneLine(uni, 80)}`, uni, "Non-ASCII as \\uXXXX", "enc"));
  return items;
}

// ---------- Epoch ----------

function epochItems(query) {
  const q = query.trim();
  let d, how;
  if (!q || q.toLowerCase() === "now") {
    d = new Date();
    how = "Now";
  } else if (/^-?\d+(\.\d+)?$/.test(q)) {
    const n = parseFloat(q), a = Math.abs(n);
    if (a < 1e11) { d = new Date(n * 1000); how = "Unix seconds"; }
    else if (a < 1e14) { d = new Date(n); how = "Unix milliseconds"; }
    else if (a < 1e17) { d = new Date(n / 1000); how = "Unix microseconds"; }
    else { d = new Date(n / 1e6); how = "Unix nanoseconds"; }
  } else {
    const t = Date.parse(q);
    if (isNaN(t)) return [info("Couldn’t read that date", "Type a Unix timestamp, an ISO 8601 date, or leave empty for now", "error")];
    d = new Date(t);
    how = "Date";
  }
  if (isNaN(d.getTime())) return [info("Date out of range", q, "error")];
  const s = Math.floor(d.getTime() / 1000);
  return [
    row(localString(d), localString(d), `${how} · local time · ${relTime(d.getTime())}`, "clock"),
    row(`${d.toISOString()}`, d.toISOString(), "ISO 8601 (UTC)", "clock"),
    row(localISO(d), localISO(d), "ISO 8601 with local offset", "clock"),
    row(`${s}`, String(s), "Unix seconds", "clock"),
    row(`${d.getTime()}`, String(d.getTime()), "Unix milliseconds", "clock"),
    row(d.toUTCString(), d.toUTCString(), "RFC 7231 / HTTP date", "clock"),
  ];
}

// ---------- Diff ----------

const MAX_DIFF_FILE = 10 * 1024 * 1024;

// The last `limit` text entries, "missing" when Clipboard History is off, or "error" when the database can't be read
function clipboardHistory(limit) {
  const db = env("DT_TEST_CLIPBOARD_DB", `${$.NSHomeDirectory().js}/Library/Application Support/Alfred/Databases/clipboard.alfdb`);
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(db)) return "missing";
  // Alfred writes to this database (rollback journal): wait up to 1 s for its lock instead of failing at once
  const out = pipe("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 1000", db, `SELECT item FROM clipboard WHERE dataType = 0 ORDER BY ts DESC LIMIT ${Number(limit)};`]);
  if (out === null) return "error";
  try {
    return out ? JSON.parse(out).map((r) => r.item) : [];
  } catch (e) {
    return "error";
  }
}

function cacheDir() {
  const dir = env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}devtoolbox`);
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}

function writeFile(path, text) {
  $(wellFormed(text)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}

function unifiedDiff(a, b, labelA, labelB, nameA = labelA, nameB = labelB) {
  // One diff at a time: the folder is emptied first, so copies of compared files don't pile up in the cache
  const fm = $.NSFileManager.defaultManager, dir = `${cacheDir()}/diff`;
  fm.removeItemAtPathError(dir, $());
  fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  const fa = `${dir}/${labelA}.txt`, fb = `${dir}/${labelB}.txt`;
  writeFile(fa, a.endsWith("\n") ? a : a + "\n");
  writeFile(fb, b.endsWith("\n") ? b : b + "\n");
  // diff exits 1 when files differ, so run through sh to normalise the status; "--" guards names starting with "-".
  // --label puts the real names in the ---/+++ headers instead of the cache copies' names
  const out = pipe("/bin/sh", ["-c", 'cd "$0" && /usr/bin/diff -u --label "$3" --label "$4" -- "$1" "$2"; [ $? -le 1 ]', dir, `${labelA}.txt`, `${labelB}.txt`, nameA, nameB]);
  return { text: out, fileA: fa, fileB: fb };
}

function diffStats(d) {
  let add = 0, del = 0;
  for (const l of d.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

function diffItems(query) {
  let files = query.split("\t").map((f) => f.trim()).filter(Boolean);
  if (!files.length) {
    // Nothing typed: two files copied in Finder are compared instead of Clipboard History
    const copied = clipboardFiles();
    if (copied.length === 2) files = copied;
  }
  const pathLike = files.length > 1 && files.every((f) => f.startsWith("/"));
  if (pathLike && files.length !== 2) return [info("Select exactly two files", `${plural(files.length, "file")} selected`, "error")];
  let a, b, la, lb, na, nb;
  if (pathLike) {
    const fm = $.NSFileManager.defaultManager;
    const read = (p) => {
      const attrs = fm.attributesOfItemAtPathError(p, $());
      if (attrs.isNil() || Number(attrs.fileSize) > MAX_DIFF_FILE) return null;
      const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, $());
      return s.isNil() ? null : s.js;
    };
    a = read(files[0]);
    b = read(files[1]);
    if (a === null || b === null) return [info("Couldn’t read those files as UTF-8 text", `${files.map((f) => f.split("/").pop()).join(" · ")} · up to 10 MB each`, "error")];
    // kept short: "<name>.a.txt" must stay within the 255-byte file name limit
    na = files[0].split("/").pop();
    nb = files[1].split("/").pop();
    la = na.replace(/[^\w.-]/g, "_").slice(0, 100) + ".a";
    lb = nb.replace(/[^\w.-]/g, "_").slice(0, 100) + ".b";
  } else {
    const h = clipboardHistory(2);
    if (h === "missing") return [info("Alfred’s Clipboard History is not available", "Turn it on in Alfred Preferences → Features → Clipboard History, or copy two files in Finder", "error")];
    if (h === "error") return [info("Couldn’t read Alfred’s Clipboard History", "The database is busy or unreadable. Try again in a moment", "error")];
    if (h.length < 2) return [info("Need two text entries in Clipboard History", "Copy the two texts to compare, then try again", "info")];
    b = h[0];
    a = h[1];
    la = na = "previous";
    lb = nb = "current";
  }
  if (a === b) return [info("Identical", "Both texts are the same", "ok")];
  let jsonNote = "";
  const ja = parseExact(a), jb = parseExact(b);
  if (ja.ok && jb.ok && ja.value && jb.value && typeof ja.value === "object" && typeof jb.value === "object") {
    a = stringify(sortKeys(ja.value), 2);
    b = stringify(sortKeys(jb.value), 2);
    jsonNote = " · JSON, keys sorted";
    if (a === b) return [info("Same JSON", "Only formatting or key order differs", "ok")];
  }
  const d = unifiedDiff(a, b, la, lb, na, nb);
  if (d.text === null) return [info("Couldn’t compare the texts", "The diff command returned an error. Try again, or check that the workflow’s cache folder is writable", "error")];
  const st = diffStats(d.text);
  // The diff travels as a file path, so large diffs don't bloat the Script Filter JSON
  const file = `${cacheDir()}/devtoolbox.diff`;
  writeFile(file, d.text);
  const vars = { diff_a: d.fileA, diff_b: d.fileB, diff_file: file };
  const text = d.text.length > LARGE ? { copy: "Diff too large for ⌘C: press ⌘↩ to copy it", largetype: d.text.slice(0, 5000) + "…" } : { copy: d.text, largetype: d.text.length > 5000 ? d.text.slice(0, 5000) + "…" : d.text };
  return [
    {
      title: `+${st.add} −${st.del} · ${pathLike ? `${files[0].split("/").pop()} → ${files[1].split("/").pop()}` : "previous → current clipboard"}${jsonNote}`,
      subtitle: "↩ Open diff · ⌘↩ Copy unified diff · ⌥↩ Open in the Workflow’s diff app",
      arg: file,
      valid: true,
      variables: Object.assign({ diff_action: "open" }, vars),
      text,
      icon: { path: "icons/diff.png" },
      mods: {
        cmd: { arg: file, subtitle: "Copy the unified diff", variables: Object.assign({ diff_action: "copy" }, vars) },
        alt: { arg: file, subtitle: "Compare side by side in the diff app set in the Workflow’s Configuration", variables: Object.assign({ diff_action: "app" }, vars) },
      },
    },
  ];
}

// Side-by-side apps. Alfred's PATH has no Homebrew or /usr/local/bin, so the command-line tool is looked up
// in the usual folders and then inside the app bundle (VS Code and BBEdit ship theirs there).
const DIFF_APPS = {
  filemerge: { name: "FileMerge", tool: "opendiff", dirs: ["/usr/bin"] },
  vscode: { name: "Visual Studio Code", tool: "code", args: ["--diff"], bundle: ["com.microsoft.VSCode", "Contents/Resources/app/bin/code"] },
  kaleidoscope: { name: "Kaleidoscope", tool: "ksdiff" },
  // bbdiff exits like diff: 1 means "the files differ", not an error
  bbedit: { name: "BBEdit", tool: "bbdiff", bundle: ["com.barebones.bbedit", "Contents/Helpers/bbdiff"], okStatus: [0, 1] },
};
const TOOL_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function findTool(spec) {
  const fm = $.NSFileManager.defaultManager;
  const testDirs = env("DT_TEST_TOOL_DIRS", null); // used by the test suite only: never looks at real apps
  const dirs = testDirs !== null ? testDirs.split(":") : spec.dirs || TOOL_PATH.split(":");
  for (const d of dirs) if (fm.isExecutableFileAtPath(`${d}/${spec.tool}`)) return `${d}/${spec.tool}`;
  if (spec.bundle && testDirs === null) {
    const app = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(spec.bundle[0]);
    const p = app.isNil() ? "" : `${app.path.js}/${spec.bundle[1]}`;
    if (p && fm.isExecutableFileAtPath(p)) return p;
  }
  return null;
}

// Action for the diff result: open / copy / app
function diffAction(arg) {
  const action = env("diff_action", "open");
  const a = env("diff_a", ""), b = env("diff_b", "");
  const file = env("diff_file", arg);
  if (action === "copy") {
    const s = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, $());
    if (s.isNil()) return "Couldn’t read the diff";
    const pb = $.NSPasteboard.generalPasteboard;
    pb.clearContents;
    pb.setStringForType(s, $.NSPasteboardTypeString);
    return "Diff copied";
  }
  if (action === "app") {
    const spec = lookup(DIFF_APPS, env("diff_app", "filemerge").trim()) || DIFF_APPS.filemerge;
    const cmd = findTool(spec);
    if (!cmd) return spec === DIFF_APPS.filemerge ? "FileMerge needs Xcode installed" : `${spec.name}: its command-line tool (${spec.tool}) is not installed`;
    const t = $.NSTask.alloc.init;
    t.executableURL = $.NSURL.fileURLWithPath(cmd);
    t.arguments = [...(spec.args || []), a, b];
    const env2 = $.NSMutableDictionary.dictionaryWithDictionary(ENV);
    env2.setObjectForKey(TOOL_PATH, "PATH"); // "code" and friends are scripts that look up helpers on PATH
    t.environment = env2;
    t.standardOutput = $.NSFileHandle.fileHandleWithNullDevice; // not a pipe: opendiff returns at once instead of waiting for FileMerge
    t.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    if (!t.launchAndReturnError($())) return `Couldn’t start ${spec.name}`;
    t.waitUntilExit;
    if (!(spec.okStatus || [0]).includes(t.terminationStatus)) return spec === DIFF_APPS.filemerge ? "FileMerge needs Xcode installed" : `${spec.name} couldn’t open the comparison`;
    return "";
  }
  // No app registered for .diff files: fall back to the default text editor
  if (!$.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(file))) pipe("/usr/bin/open", ["-t", file]);
  return "";
}

// ---------- Smart hub ----------

const TOOLS = [
  ["json", "JSON", "Format, minify, sort keys, TypeScript types", "json"],
  ["uuid", "UUID", "UUID v4/v7, ULID, Nano ID", "uuid"],
  ["jwt", "JWT", "Decode tokens and check expiry", "jwt"],
  ["regex", "Regex", "Test a pattern against the clipboard", "regex"],
  ["hash", "Hash", "MD5, SHA-1, SHA-256, SHA-512, CRC32", "hash"],
  ["enc", "Encode", "Base64, URL, HTML, hex, Unicode", "enc"],
  ["epoch", "Epoch", "Unix timestamps and dates", "clock"],
  ["diff", "Diff", "Compare the last two clipboard entries", "diff"],
  ["case", "Case", "camelCase, snake_case, kebab-case, Title Case…", "case"],
];
const HANDLERS = { case: caseItems, json: jsonItems, uuid: uuidItems, jwt: jwtItems, regex: regexItems, hash: hashItems, enc: encItems, epoch: epochItems, diff: diffItems };

function smartItems(query) {
  // "dev json …" style: delegate to a tool. Selected text from the Universal Action can also start
  // with a tool name ("hash tables are…"), so multi-line text is never delegated, and a delegated
  // argument that the tool can't use falls back to detection on the whole text.
  const m = query.match(/^(\w+)(?:[ \t]+([\s\S]*))?$/);
  const handler = m && lookup(HANDLERS, m[1].toLowerCase());
  if (handler && !/[\r\n]/.test(query)) {
    const res = handler(m[2] || "");
    if (!m[2] || res.some((it) => it.valid !== false)) return res;
  }
  const src = inputOrClipboard(query);
  const t = src.text.trim();
  if (!t || (/^\w{0,5}$/.test(query.trim()) && query.trim() !== "")) {
    const f = query.trim().toLowerCase();
    const list = TOOLS.filter(([k, name]) => !f || k.startsWith(f) || name.toLowerCase().startsWith(f));
    if (list.length || !t) {
      const menu = list.map(([k, name, sub, icon]) => {
        const kw = env("keyword_" + k, "").trim() || k; // a required keyword can still arrive empty
        return { title: `${name}  ·  ${kw}`, subtitle: sub, autocomplete: `${k} `, valid: false, icon: { path: `icons/${icon}.png` } };
      });
      if (clipTooLarge && !f) menu.unshift(emptyClip("", "error"));
      return menu;
    }
  }
  const items = [];
  const bare = cleanToken(t);
  let ids;
  if (JWT_RE.test(bare) && bare.startsWith("eyJ")) items.push(...jwtItems(t));
  else if (/^[\[{]/.test(t) && (parseJSON(t).ok || relaxedJSON(t) !== null)) items.push(...jsonItems(src));
  else if (t.includes("\n") && csvToJSON(t)) items.push(...jsonItems(src));
  else if ((ids = decodeIdItems(t, true))) items.push(...ids);
  else if (/^-?\d{9,19}(\.\d+)?$/.test(t) || (/^\d{4}-\d{2}-\d{2}/.test(t) && !isNaN(Date.parse(t)))) items.push(...epochItems(t));
  if (!ids && t.length <= 200 && !t.includes("\n")) items.push(...caseItems(src).filter((it) => it.valid !== false).slice(0, 5));
  items.push(...encItems(src));
  items.push(...hashItems(src).filter((it) => it.valid !== false));
  return items;
}

// ---------- entry ----------

function run(argv) {
  const [cmd, ...rest] = argv;
  // Several files from a Universal Action may arrive as separate arguments
  const query = cmd === "diff" ? rest.join("\t") : rest.join(" ");
  let wd = null;
  try {
    switch (cmd) {
      case "json": return output(jsonItems(query));
      case "uuid": return output(uuidItems(query));
      case "jwt": return output(jwtItems(query));
      case "regex":
        wd = watchdog(3, output([SLOW_INFO()]));
        return output(regexItems(query));
      case "hash": return output(hashItems(query));
      case "enc": return output(encItems(query));
      case "epoch": return output(epochItems(query), { rerun: query.trim() ? undefined : 1 });
      case "diff": return output(diffItems(query));
      case "case": return output(caseItems(query));
      case "smart": return output(smartItems(query));
      // Nothing is printed on success: osascript would print "\n" for "", which could show an empty notification
      case "diff-action": return diffAction(query) || undefined;
      default: return output([info(`Unknown command: ${cmd}`, "", "error")]);
    }
  } catch (e) {
    return output([info("DevToolbox error", String(e && e.message ? e.message : e), "error")]);
  } finally {
    if (wd) wd.terminate;
  }
}
