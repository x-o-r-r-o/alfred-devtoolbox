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

const MAX_TEXT = 2 * 1024 * 1024; // ignore clipboards larger than 2 MB
const MAX_MATCHES = 50;
const INDENT = { "2": 2, "4": 4, tab: "\t" }[env("json_indent", "2")] || 2;
const HASH_UPPER = env("hash_uppercase", "0") === "1";

// ---------- helpers ----------

function clipboard() {
  const fake = env("DT_TEST_CLIPBOARD", null); // used by the test suite only
  if (fake !== null) return fake;
  const fakeFile = env("DT_TEST_CLIPBOARD_FILE", null);
  if (fakeFile !== null) return $.NSString.stringWithContentsOfFileEncodingError(fakeFile, $.NSUTF8StringEncoding, $()).js;
  const s = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
  if (s.isNil()) return "";
  const t = s.js;
  return t.length > MAX_TEXT ? "" : t;
}

function inputOrClipboard(query) {
  if (query && typeof query === "object") return query; // already resolved by the smart hub
  return query !== "" ? { text: query, source: "query" } : { text: clipboard(), source: "clipboard" };
}

function oneLine(s, max = 120) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : /(s|x|ch|sh)$/.test(word) ? "es" : "s"}`;
}

// A result row whose arg is copied (↩) or pasted (⌘↩).
// Large values are written to the cache and resolved by ./resolve.sh after selection,
// so the Script Filter JSON stays small.
const LARGE = 50000;
let largeCount = 0;
function row(title, value, subtitle, icon, extra = {}) {
  let v = String(value), text = { copy: v, largetype: v };
  if (v.length > LARGE) {
    const path = `${cacheDir()}/result-${largeCount++}.txt`;
    writeFile(path, v);
    v = `dtfile:${path}`;
    text = { copy: "Result too large for ⌘C: press ↩ to copy it", largetype: "Result too large for Large Type" };
  } else if (v.length > 5000) text.largetype = v.slice(0, 5000) + "…";
  return Object.assign(
    {
      title: oneLine(title),
      subtitle: subtitle || "↩ Copy · ⌘↩ Paste · ⌘L Large Type",
      arg: v,
      valid: v !== "",
      text,
      icon: { path: `icons/${icon}.png` },
      mods: { cmd: { valid: v !== "", subtitle: "Paste into the frontmost app" } },
    },
    extra
  );
}

function info(title, subtitle, icon = "info") {
  return { title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon}.png` } };
}

function output(items, extra = {}) {
  return JSON.stringify(Object.assign({ skipknowledge: true, items }, extra));
}

// UTF-8 <-> "byte string" (each char 0–255)
function toBytes(s) {
  return unescape(encodeURIComponent(s));
}
function fromBytes(b) {
  return decodeURIComponent(escape(b));
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

// Run a command with stdin, return stdout (trimmed) or null on failure
function pipe(path, args, input = "") {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const inP = $.NSPipe.pipe, outP = $.NSPipe.pipe, errP = $.NSPipe.pipe;
  task.standardInput = inP;
  task.standardOutput = outP;
  task.standardError = errP;
  const err = Ref();
  if (!task.launchAndReturnError(err)) return null;
  const data = $(input).dataUsingEncoding($.NSUTF8StringEncoding);
  inP.fileHandleForWriting.writeData(data);
  inP.fileHandleForWriting.closeFile;
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  if (task.terminationStatus !== 0) return null;
  return $.NSString.alloc.initWithDataEncoding(out, $.NSUTF8StringEncoding).js.trim();
}


// ---------- JSON ----------

function parseJSON(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Loose JS object literal -> JSON (unquoted keys, single quotes, trailing commas, comments)
function relaxedJSON(text) {
  let t = text.trim();
  if (!/^[\[{]/.test(t)) return null;
  t = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  t = t.replace(/'((?:[^'\\]|\\.)*)'/g, (_, c) => JSON.stringify(c.replace(/\\'/g, "'")));
  t = t.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  t = t.replace(/,\s*([}\]])/g, "$1");
  const p = parseJSON(t);
  return p.ok ? p.value : null;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(arr) {
  const cols = [];
  for (const o of arr) for (const k of Object.keys(o)) if (!cols.includes(k)) cols.push(k);
  return [cols.map(csvCell).join(","), ...arr.map((o) => cols.map((c) => csvCell(o[c])).join(","))].join("\n");
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const sep = (text.split("\n")[0].match(/\t/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? "\t" : ",";
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
  return body.map((r) => Object.fromEntries(head.map((h, i) => {
    const v = r[i];
    return [h, /^-?\d+(\.\d+)?$/.test(v) && v.length < 16 ? Number(v) : v === "true" ? true : v === "false" ? false : v];
  })));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = {};
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
    if (Array.isArray(v)) {
      if (v.length === 0) return "unknown[]";
      const objs = v.filter((x) => x && typeof x === "object" && !Array.isArray(x));
      const types = new Set();
      if (objs.length) {
        const merged = {};
        const counts = {};
        for (const o of objs) for (const k of Object.keys(o)) {
          counts[k] = (counts[k] || 0) + 1;
          if (!(k in merged) || merged[k] === null) merged[k] = o[k];
        }
        types.add(iface(merged, name.replace(/s$/, "") || name, (k) => counts[k] < objs.length));
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
  if (!src.text.trim()) return [info("Clipboard is empty", "Copy JSON, or type it after the keyword", "json")];

  let p = parseJSON(src.text);
  let fixed = false;
  if (!p.ok) {
    const lines = src.text.trim().split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1 && lines.every((l) => parseJSON(l).ok)) {
      p = { ok: true, value: lines.map((l) => JSON.parse(l)) };
      fixed = "JSON Lines";
    } else {
      const r = relaxedJSON(src.text);
      if (r !== null) { p = { ok: true, value: r }; fixed = "JS object"; }
    }
  }
  if (!p.ok) {
    const csv = csvToJSON(src.text);
    if (csv) return [
      info(`CSV · ${plural(csv.length, "row")}`, `Converted from ${src.source}`, "ok"),
      row("CSV → JSON", JSON.stringify(csv, null, INDENT), "Array of objects, one per row", "json", { match: "csv convert" }),
      row("CSV → JSON Lines", csv.map((o) => JSON.stringify(o)).join("\n"), "One object per line", "json", { match: "csv jsonl lines" }),
    ];
    // A JSON string literal that itself contains JSON (escaped) is handled by Unescape below
    return [
      info("Invalid JSON", `${p.error} (${src.source})`, "error"),
      row("Escape as JSON string", JSON.stringify(src.text), "Wrap the text in a JSON string literal · ↩ Copy · ⌘↩ Paste", "json"),
    ];
  }
  const v = p.value;
  const items = [
    row("Pretty print", JSON.stringify(v, null, INDENT), `Format JSON from ${src.source}`, "json", { match: "pretty format beautify" }),
    row("Minify", JSON.stringify(v), `Remove whitespace from JSON (${src.source})`, "json", { match: "minify compact" }),
    row("Sort keys", JSON.stringify(sortKeys(v), null, INDENT), "Pretty print with keys sorted alphabetically", "json", { match: "sort keys" }),
    row("TypeScript interfaces", toTypeScript(v), "Generate TypeScript types from this JSON", "ts", { match: "typescript ts types interface" }),
    row("Escape as JSON string", JSON.stringify(JSON.stringify(v)), "Minified JSON wrapped in a string literal", "json", { match: "escape stringify string" }),
  ];
  if (Array.isArray(v)) {
    items.push(row("JSON Lines", v.map((x) => JSON.stringify(x)).join("\n"), "One array element per line (JSONL / NDJSON)", "json", { match: "jsonl lines ndjson" }));
    if (v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x)))
      items.push(row("CSV", toCSV(v), "Array of objects as comma-separated values", "json", { match: "csv table export" }));
  }
  if (typeof v === "string") {
    const inner = parseJSON(v);
    items.unshift(row("Unescape string", inner.ok ? JSON.stringify(inner.value, null, INDENT) : v, "Decode the JSON string literal", "json", { match: "unescape unstringify" }));
  }
  const kind = Array.isArray(v) ? plural(v.length, "item") : v && typeof v === "object" ? plural(Object.keys(v).length, "key") : typeof v;
  const size = toBytes(src.text).length;
  items.unshift(info(fixed ? `Converted ${fixed} · ${kind}` : `Valid JSON · ${kind}`, `${size < 1024 ? plural(size, "byte") : (size / 1024).toFixed(1) + " KB"} from ${src.source}`, "ok"));
  if (!filter) return items;
  const words = filter.split(/\s+/);
  const hits = items.slice(1).filter((it) => words.every((w) => (it.title + " " + (it.match || "")).toLowerCase().includes(w)));
  return hits.length ? hits : [info("No matching action", "Try pretty, minify, sort, typescript or escape", "info")];
}

// ---------- Case ----------

function words(t) {
  return t
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function caseItems(query) {
  const src = inputOrClipboard(query);
  const t = src.text;
  if (!t.trim()) return [info("Clipboard is empty", "Type text after the keyword, or copy some", "case")];
  if (t.length > 5000) return [info("Text too long", "Case conversion works on up to 5,000 characters", "error")];
  const w = words(t), lw = w.map((x) => x.toLowerCase());
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const base = /\s/.test(t.trim()) ? t : w.join(" "); // identifiers like fooBar → "foo Bar"
  const sentence = base.toLowerCase().replace(/(^\s*\p{L}|[.!?]\s+\p{L})/gu, (m) => m.toUpperCase());
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "up", "via", "vs"]);
  const title = base.toLowerCase().replace(/[\p{L}\p{N}'’]+/gu, (m, off) => (off === 0 || !small.has(m) ? cap(m) : m));
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
  return list.filter(([, v]) => v).map(([name, v]) => row(`${oneLine(v, 80)}`, v, `${name} · ↩ Copy · ⌘↩ Paste`, "case", { match: name.toLowerCase() }));
}

// ---------- UUID & IDs ----------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const NANO = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

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

function uuidItems(query) {
  const q = query.trim().toLowerCase();
  const m = q.match(/^(\d+)/);
  const count = Math.min(Math.max(m ? parseInt(m[1], 10) : 1, 1), 1000);
  const filter = q.replace(/^\d+\s*/, "");
  const gen = (f) => Array.from({ length: count }, f).join("\n");
  const n = count > 1 ? ` × ${count}` : "";
  const v4 = gen(uuid4);
  const items = [
    row(`UUID v4${n}`, v4, count > 1 ? oneLine(v4, 80) : "Random UUID · ↩ Copy · ⌘↩ Paste", "uuid", { match: "v4 uuid random" }),
    row(`UUID v4 uppercase${n}`, v4.toUpperCase(), "Uppercase random UUID", "uuid", { match: "v4 upper uppercase" }),
    row(`UUID v4 without dashes${n}`, v4.replace(/-/g, ""), "32 hex characters", "uuid", { match: "v4 nodash compact hex" }),
    row(`UUID v7${n}`, gen(uuid7), "Time-ordered UUID (RFC 9562)", "uuid", { match: "v7 time sortable" }),
    row(`ULID${n}`, gen(ulid), "Sortable 26-character ID", "uuid", { match: "ulid sortable" }),
    row(`Nano ID${n}`, gen(() => nanoid()), "21-character URL-safe ID", "uuid", { match: "nanoid nano" }),
  ];
  for (const it of items) if (count === 1) it.title = `${it.title.replace(n, "")}: ${it.arg}`;
  if (!filter) return items;
  const hits = items.filter((it) => filter.split(/\s+/).every((w) => (it.title + " " + it.match).toLowerCase().includes(w)));
  return hits.length ? hits : [info("Unknown ID type", "Try v4, upper, nodash, v7, ulid or nano. Prefix a number for several, e.g. 5 v7", "info")];
}

// ---------- JWT ----------

function b64urlDecode(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const data = $.NSData.alloc.initWithBase64EncodedStringOptions(t, 0);
  if (data.isNil()) return null;
  const str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return str.isNil() ? null : str.js;
}

function relTime(ms) {
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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function jwtItems(query) {
  let q = query.trim().replace(/^Bearer\s+/i, "");
  let source = "query";
  if (!q) {
    q = clipboard().trim().replace(/^Bearer\s+/i, "");
    source = "clipboard";
  }
  if (!q) return [info("Clipboard is empty", "Copy a JWT, or paste it after the keyword", "jwt")];
  if (!JWT_RE.test(q)) return [info("Not a JWT", `Expected header.payload.signature (${source})`, "error")];
  const [h, p] = q.split(".");
  const header = b64urlDecode(h), payload = b64urlDecode(p);
  const hj = header && parseJSON(header), pj = payload && parseJSON(payload);
  if (!hj || !hj.ok || !pj || !pj.ok) return [info("Could not decode JWT", "Header or payload is not base64url-encoded JSON", "error")];
  const claims = pj.value, items = [];
  const now = Date.now();
  if (typeof claims.exp === "number") {
    const exp = claims.exp * 1000;
    items.push(info(exp > now ? `Valid · expires ${relTime(exp)}` : `Expired ${relTime(exp)}`, `${localString(new Date(exp))} · Signature not verified`, exp > now ? "ok" : "error"));
  } else items.push(info("No expiry (exp) claim", "Signature not verified", "info"));
  items.push(row("Payload", JSON.stringify(claims, null, INDENT), oneLine(JSON.stringify(claims), 100), "jwt"));
  items.push(row(`Header · ${hj.value.alg || "no alg"}`, JSON.stringify(hj.value, null, INDENT), oneLine(JSON.stringify(hj.value), 100), "jwt"));
  const NAMES = { iss: "Issuer", sub: "Subject", aud: "Audience", exp: "Expires", nbf: "Not before", iat: "Issued at", jti: "JWT ID", scope: "Scope", email: "Email", name: "Name" };
  for (const [k, v] of Object.entries(claims)) {
    const label = NAMES[k] ? `${NAMES[k]} (${k})` : k;
    if (["exp", "nbf", "iat", "auth_time"].includes(k) && typeof v === "number") {
      const d = new Date(v * 1000);
      items.push(row(`${label}: ${localString(d)}`, String(v), `${relTime(v * 1000)} · ${d.toISOString()} · ↩ Copy value`, "clock"));
    } else {
      const val = typeof v === "string" ? v : JSON.stringify(v);
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
    replacement = q.slice(arrow + 4);
    q = q.slice(0, arrow);
  }
  let pattern = q, flags = "g";
  const m = q.match(/^\/(.*)\/([dgimsuyv]*)$/s);
  if (m) {
    pattern = m[1];
    flags = m[2].includes("g") ? m[2] : m[2] + "g";
  }
  return { pattern, flags, replacement };
}

function regexItems(query) {
  if (!query.trim()) return [info("Type a regular expression", "Tests it against the clipboard. Use /pattern/flags, and add “ => replacement” to replace", "regex")];
  const subject = clipboard();
  if (!subject) return [info("Clipboard is empty", "Copy the text to test against", "regex")];
  const { pattern, flags, replacement } = parseRegex(query);
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    return [info("Invalid regular expression", e.message, "error")];
  }
  const matches = [...subject.matchAll(re)];
  const items = [];
  if (replacement !== null) {
    const out = subject.replace(re, replacement);
    items.push(row(`Replace ${plural(matches.length, "match")}: ${oneLine(out, 80)}`, out, "Clipboard with replacements applied · ↩ Copy · ⌘↩ Paste", "regex"));
  }
  if (!matches.length) {
    items.push(info("No matches", `/${pattern}/${flags} against ${plural(subject.length, "character")} of clipboard`, "info"));
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

function crc32(bytes) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < bytes.length; n++) {
    c = (crc ^ bytes.charCodeAt(n)) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

// CommonCrypto through the ObjC bridge: fast, no subprocess
const CC = { md5: ["CC_MD5", 16], sha1: ["CC_SHA1", 20], sha256: ["CC_SHA256", 32], sha512: ["CC_SHA512", 64] };
for (const [fn] of Object.values(CC)) ObjC.bindFunction(fn, ["void *", ["void *", "unsigned int", "void *"]]);

function digestData(algo, data) {
  const [fn, len] = CC[algo];
  const out = $.NSMutableData.dataWithLength(len);
  $[fn](data.bytes, data.length, out.mutableBytes);
  const bin = $.NSString.alloc.initWithDataEncoding(out, $.NSISOLatin1StringEncoding).js;
  return [...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function crc32Data(data) {
  const bin = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding).js;
  return crc32(bin);
}

const MAX_FILE = 1024 * 1024 * 1024; // CC_* take a 32-bit length

function hashItems(query) {
  let data, label;
  const path = typeof query === "string" ? query.trim().replace(/^~(?=\/)/, $.NSHomeDirectory().js) : "";
  const fm = $.NSFileManager.defaultManager, isDir = Ref();
  if (path.startsWith("/") && fm.fileExistsAtPathIsDirectory(path, isDir)) {
    if (isDir[0]) return [info("That's a folder", "Hash works on a single file", "error")];
    const size = fm.attributesOfItemAtPathError(path, $()).fileSize;
    if (size > MAX_FILE) return [info("File too large", "Hashing is limited to 1 GB", "error")];
    data = $.NSData.dataWithContentsOfFileOptionsError(path, 1, $());
    if (data.isNil()) return [info("Can't read that file", path, "error")];
    label = `${path.split("/").pop()} (${plural(Number(data.length), "byte")})`;
  } else {
    const src = inputOrClipboard(query);
    if (!src.text) return [info("Clipboard is empty", "Type text after the keyword, or copy some", "hash")];
    data = $(src.text).dataUsingEncoding($.NSUTF8StringEncoding);
    label = `${src.source} (${plural(Number(data.length), "byte")})`;
  }
  // Compare with a checksum in the clipboard, e.g. copied from a download page
  const clip = path ? clipboard().trim().toLowerCase().replace(/^(sha256|sha512|sha1|md5)[:=\s]+/, "") : "";
  const expected = /^[0-9a-f]{8,128}$/.test(clip) ? clip : "";
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
const HTML_DEC = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–" };

function b64encode(text) {
  return $(text).dataUsingEncoding($.NSUTF8StringEncoding).base64EncodedStringWithOptions(0).js;
}

function b64decode(text) {
  const t = text.trim().replace(/\s+/g, "");
  if (t.length < 8 || t.length % 4 === 1 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) return null;
  return b64urlDecode(t.replace(/=+$/, ""));
}

function encItems(query) {
  const src = inputOrClipboard(query);
  const t = src.text;
  if (!t) return [info("Clipboard is empty", "Type text after the keyword, or copy some", "enc")];
  const items = [];
  const decoded = [];
  // Decoders first, only when they apply
  const b = b64decode(t);
  if (b !== null && b !== "" && /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(b)) decoded.push(row(`Base64 decode: ${oneLine(b, 80)}`, b, "Decoded text · ↩ Copy · ⌘↩ Paste", "enc"));
  if (/%[0-9A-Fa-f]{2}/.test(t)) {
    try {
      const u = decodeURIComponent(t.replace(/\+/g, " "));
      decoded.push(row(`URL decode: ${oneLine(u, 80)}`, u, "Percent-decoded text", "enc"));
    } catch (e) {}
  }
  if (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(t)) {
    const h = t.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : HTML_DEC[e.toLowerCase()] ?? all
    );
    decoded.push(row(`HTML decode: ${oneLine(h, 80)}`, h, "Entities replaced with characters", "enc"));
  }
  if (/^(?:[0-9a-f]{2}\s?)+$/i.test(t.trim()) && t.trim().replace(/\s/g, "").length % 2 === 0) {
    try {
      const bytes = t.trim().replace(/\s/g, "").match(/../g).map((x) => String.fromCharCode(parseInt(x, 16))).join("");
      const s = fromBytes(bytes);
      decoded.push(row(`Hex decode: ${oneLine(s, 80)}`, s, "UTF-8 text from hex bytes", "enc"));
    } catch (e) {}
  }
  if (/\\u[0-9a-f]{4}|\\u\{[0-9a-f]+\}/i.test(t)) {
    const s = t.replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi, (_, a, c) => String.fromCodePoint(parseInt(a || c, 16)));
    decoded.push(row(`Unicode unescape: ${oneLine(s, 80)}`, s, "\\uXXXX sequences replaced", "enc"));
  }
  if (/\\[nrt"'\\0]/.test(t)) {
    const s = t.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[nrt0"'\\bfv])/gi, (_, e) =>
      ({ n: "\n", r: "\r", t: "\t", 0: "\0", b: "\b", f: "\f", v: "\v" })[e] ?? (/^[ux]/i.test(e) ? String.fromCodePoint(parseInt(e.replace(/[ux{}]/gi, ""), 16)) : e));
    decoded.push(row(`Backslash unescape: ${oneLine(s, 80)}`, s, "\\n, \\t, \\\" … replaced with characters", "enc"));
  }
  const num = t.trim().match(/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|-?\d{1,15})$/i);
  if (num) {
    const val = /^0o/i.test(num[1]) ? parseInt(num[1].slice(2), 8) : Number(num[1]);
    if (Number.isSafeInteger(val)) {
      for (const [label, str] of [["Decimal", String(val)], ["Hexadecimal", "0x" + val.toString(16)], ["Binary", "0b" + val.toString(2)], ["Octal", "0o" + val.toString(8)]])
        if (str.toLowerCase() !== num[1].toLowerCase()) decoded.push(row(`${label}: ${str}`, str, `Number base conversion of ${num[1]}`, "hash"));
    }
  }
  items.push(...decoded);
  const b64 = b64encode(t);
  items.push(row(`Base64: ${oneLine(b64, 80)}`, b64, `Encode ${src.source} as Base64`, "enc"));
  items.push(row(`Base64URL: ${oneLine(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), 80)}`, b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "URL-safe Base64 without padding", "enc"));
  const url = encodeURIComponent(t);
  items.push(row(`URL encode: ${oneLine(url, 80)}`, url, "Percent-encode for use in a URL component", "enc"));
  const html = t.replace(/[&<>"']/g, (c) => HTML_ENC[c]);
  items.push(row(`HTML encode: ${oneLine(html, 80)}`, html, "Escape & < > \" '", "enc"));
  const hex = hexOf([...toBytes(t)].map((c) => c.charCodeAt(0)));
  items.push(row(`Hex: ${oneLine(hex, 80)}`, hex, "UTF-8 bytes as hex", "enc"));
  const esc = JSON.stringify(t).slice(1, -1);
  if (esc !== t) items.push(row(`Backslash escape: ${oneLine(esc, 80)}`, esc, "Escape quotes, backslashes and control characters", "enc"));
  const uni = [...t].map((c) => { const cp = c.codePointAt(0); return cp < 128 ? c : cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`; }).join("");
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
    if (isNaN(t)) return [info("Could not read that date", "Type a Unix timestamp, an ISO 8601 date, or leave empty for now", "error")];
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

function clipboardHistory(limit) {
  const db = `${$.NSHomeDirectory().js}/Library/Application Support/Alfred/Databases/clipboard.alfdb`;
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(db)) return null;
  const out = pipe("/usr/bin/sqlite3", ["-readonly", "-json", db, `SELECT item FROM clipboard WHERE dataType = 0 ORDER BY ts DESC LIMIT ${limit};`]);
  if (out === null) return null;
  try {
    return out ? JSON.parse(out).map((r) => r.item) : [];
  } catch (e) {
    return null;
  }
}

function cacheDir() {
  const dir = env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}devtoolbox`);
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}

function writeFile(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}

function unifiedDiff(a, b, labelA, labelB) {
  const dir = cacheDir();
  const fa = `${dir}/${labelA}.txt`, fb = `${dir}/${labelB}.txt`;
  writeFile(fa, a.endsWith("\n") ? a : a + "\n");
  writeFile(fb, b.endsWith("\n") ? b : b + "\n");
  // diff exits 1 when files differ, so run through sh to normalise the status
  const out = pipe("/bin/sh", ["-c", 'cd "$0" && /usr/bin/diff -u "$1" "$2"; [ $? -le 1 ]', dir, `${labelA}.txt`, `${labelB}.txt`]);
  return { text: out === null ? null : out, fileA: fa, fileB: fb };
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
  const files = query.split("\t").filter(Boolean);
  let a, b, la, lb;
  if (files.length === 2) {
    const read = (p) => { const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, $()); return s.isNil() ? null : s.js; };
    a = read(files[0]);
    b = read(files[1]);
    if (a === null || b === null) return [info("Can't read those files as UTF-8 text", files.map((f) => f.split("/").pop()).join(" · "), "error")];
    la = files[0].split("/").pop().replace(/[^\w.-]/g, "_") + ".a";
    lb = files[1].split("/").pop().replace(/[^\w.-]/g, "_") + ".b";
  } else {
    const h = clipboardHistory(2);
    if (h === null) return [info("Alfred's Clipboard History is not available", "Turn it on in Alfred Preferences → Features → Clipboard History, or select two files and use the Universal Action", "error")];
    if (h.length < 2) return [info("Need two text entries in Clipboard History", "Copy the two texts to compare, then try again", "info")];
    b = h[0];
    a = h[1];
    la = "previous";
    lb = "current";
  }
  if (a === b) return [info("Identical", "Both texts are the same", "ok")];
  let jsonNote = "";
  const ja = parseJSON(a), jb = parseJSON(b);
  if (ja.ok && jb.ok && typeof ja.value === "object" && typeof jb.value === "object") {
    a = JSON.stringify(sortKeys(ja.value), null, 2);
    b = JSON.stringify(sortKeys(jb.value), null, 2);
    jsonNote = " · JSON, keys sorted";
    if (a === b) return [info("Same JSON", "Only formatting or key order differs", "ok")];
  }
  const d = unifiedDiff(a, b, la, lb);
  if (d.text === null) return [info("diff failed", "", "error")];
  const st = diffStats(d.text);
  const vars = { diff_a: d.fileA, diff_b: d.fileB };
  return [
    {
      title: `+${st.add} −${st.del} · ${files.length === 2 ? `${files[0].split("/").pop()} → ${files[1].split("/").pop()}` : "previous → current clipboard"}${jsonNote}`,
      subtitle: "↩ Open diff · ⌘↩ Copy unified diff · ⌥↩ Open in the Workflow’s diff app",
      arg: d.text,
      valid: true,
      variables: Object.assign({ diff_action: "open" }, vars),
      text: { copy: d.text, largetype: d.text },
      icon: { path: "icons/diff.png" },
      mods: {
        cmd: { arg: d.text, subtitle: "Copy the unified diff", variables: Object.assign({ diff_action: "copy" }, vars) },
        alt: { arg: d.text, subtitle: "Compare side by side in the diff app set in the Workflow’s Configuration", variables: Object.assign({ diff_action: "app" }, vars) },
      },
    },
  ];
}

// Action for the diff result: open / copy / app
function diffAction(diffText) {
  const action = env("diff_action", "open");
  const a = env("diff_a", ""), b = env("diff_b", "");
  if (action === "copy") {
    const pb = $.NSPasteboard.generalPasteboard;
    pb.clearContents;
    pb.setStringForType($(diffText), $.NSPasteboardTypeString);
    return "Diff copied";
  }
  if (action === "app") {
    const app = env("diff_app", "filemerge");
    const cmds = {
      filemerge: ["/usr/bin/opendiff", [a, b]],
      vscode: ["/usr/bin/env", ["code", "--diff", a, b]],
      kaleidoscope: ["/usr/bin/env", ["ksdiff", a, b]],
      bbedit: ["/usr/bin/env", ["bbdiff", a, b]],
    };
    const [cmd, args] = cmds[app] || cmds.filemerge;
    const t = $.NSTask.alloc.init;
    t.executableURL = $.NSURL.fileURLWithPath(cmd);
    t.arguments = args;
    const env2 = $.NSMutableDictionary.dictionaryWithDictionary(ENV);
    env2.setObjectForKey("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", "PATH");
    t.environment = env2;
    t.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
    t.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    if (!t.launchAndReturnError($())) return `Could not start ${app}`;
    t.waitUntilExit;
    if (app !== "filemerge" && t.terminationStatus !== 0) return `${app} command-line tool not found`;
    if (app === "filemerge" && t.terminationStatus !== 0) return "FileMerge needs Xcode installed";
    return "";
  }
  const file = `${cacheDir()}/clipboard.diff`;
  writeFile(file, diffText);
  $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(file));
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
  // "dev json {…}" style: delegate to a tool
  const m = query.match(/^(\w+)(?:\s+([\s\S]*))?$/);
  if (m && HANDLERS[m[1].toLowerCase()] && !/^[\[{]/.test(query)) return HANDLERS[m[1].toLowerCase()](m[2] || "");
  const src = inputOrClipboard(query);
  const t = src.text.trim();
  if (!t || /^\w{0,5}$/.test(query.trim()) && query.trim() !== "") {
    const f = query.trim().toLowerCase();
    const list = TOOLS.filter(([k, name]) => !f || k.startsWith(f) || name.toLowerCase().startsWith(f));
    if (list.length || !t) return list.map(([k, name, sub, icon]) => {
      const kw = env("keyword_" + k, k);
      return { title: `${name}  ·  ${kw}`, subtitle: sub, autocomplete: `${k} `, valid: false, icon: { path: `icons/${icon}.png` } };
    });
  }
  const items = [];
  const bare = t.replace(/^Bearer\s+/i, "");
  if (JWT_RE.test(bare) && bare.split(".")[1].length > 8) items.push(...jwtItems(t));
  else if (/^[\[{]/.test(t) && (parseJSON(t).ok || relaxedJSON(t) !== null)) items.push(...jsonItems(src));
  else if (t.includes("\n") && csvToJSON(t)) items.push(...jsonItems(src));
  else if (/^-?\d{9,19}(\.\d+)?$/.test(t) || (/^\d{4}-\d{2}-\d{2}/.test(t) && !isNaN(Date.parse(t)))) items.push(...epochItems(t));
  if (t.length <= 200 && !t.includes("\n")) items.push(...caseItems(src).slice(0, 5));
  items.push(...encItems(src));
  items.push(...hashItems(src).filter((it) => it.valid !== false));
  return items;
}

// ---------- entry ----------

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  try {
    switch (cmd) {
      case "json": return output(jsonItems(query));
      case "uuid": return output(uuidItems(query));
      case "jwt": return output(jwtItems(query));
      case "regex": return output(regexItems(query));
      case "hash": return output(hashItems(query));
      case "enc": return output(encItems(query));
      case "epoch": return output(epochItems(query), { rerun: query.trim() ? undefined : 1 });
      case "diff": return output(diffItems(query));
      case "case": return output(caseItems(query));
      case "smart": return output(smartItems(query));
      case "diff-action": return diffAction(query);
      default: return output([info(`Unknown command: ${cmd}`, "", "error")]);
    }
  } catch (e) {
    return output([info("DevToolbox error", String(e && e.message ? e.message : e), "error")]);
  }
}
