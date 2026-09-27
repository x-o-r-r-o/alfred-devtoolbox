#!/usr/bin/env python3
"""End-to-end tests: run the script filters the way Alfred does and validate the JSON."""
import json, os, plistlib, re, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
# Like Alfred's real cache folder: a path with spaces
CACHE = os.path.join(tempfile.mkdtemp(prefix="devtoolbox-test-"), "Caches", "com.runningwithcrayons.Alfred",
                     "Workflow Data", "io.github.x-o-r-r-o.devtoolbox")
os.makedirs(CACHE)
# Tests never read the real pasteboard's files or Alfred's real Clipboard History
FAKE = dict(DT_TEST_CLIPBOARD_FILES="", DT_TEST_CLIPBOARD_DB=os.path.join(CACHE, "no-such.alfdb"))


def sf(cmd, query="", clipboard="", **env):
    e = dict(os.environ, DT_TEST_CLIPBOARD=clipboard, alfred_workflow_cache=CACHE, **dict(FAKE, **env))
    out = subprocess.run(["osascript", "-l", "JavaScript", "./devtoolbox.js", cmd, query], cwd=SRC, env=e,
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    data = json.loads(out.stdout)
    validate(data)
    return data["items"]


def write(path, data):
    with open(path, "wb" if isinstance(data, bytes) else "w") as f:
        f.write(data)


def validate(data):
    assert isinstance(data.get("items"), list)
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        if "icon" in it:
            assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m


def args(items):
    return [i.get("arg") for i in items if i.get("valid", True) is not False]


def find(items, prefix):
    for i in items:
        if i["title"].startswith(prefix):
            return i
    raise AssertionError(f"no item starting with {prefix!r}: {[i['title'] for i in items]}")


JWT = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
       "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyLCJleHAiOjE1MTYyMzkwMjJ9."
       "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")


class JSONTests(unittest.TestCase):
    def test_pretty_minify_sort(self):
        it = sf("json", clipboard='{"b":1,"a":[1,2]}')
        self.assertTrue(it[0]["title"].startswith("Valid JSON · 2 keys"))
        self.assertEqual(find(it, "Pretty")["arg"], '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}')
        self.assertEqual(find(it, "Minify")["arg"], '{"b":1,"a":[1,2]}')
        self.assertTrue(find(it, "Sort")["arg"].startswith('{\n  "a"'))

    def test_indent_config(self):
        it = sf("json", clipboard='{"a":1}', json_indent="tab")
        self.assertEqual(find(it, "Pretty")["arg"], '{\n\t"a": 1\n}')
        it = sf("json", clipboard='{"a":1}', json_indent="4")
        self.assertEqual(find(it, "Pretty")["arg"], '{\n    "a": 1\n}')

    def test_typed_json_and_filter(self):
        it = sf("json", '[1, 2]', clipboard="not json")
        self.assertEqual(find(it, "Minify")["arg"], "[1,2]")
        it = sf("json", "min", clipboard='{"a": 1}')
        self.assertEqual([i["title"] for i in it], ["Minify"])
        it = sf("json", "zzz", clipboard='{"a": 1}')
        self.assertEqual(it[0]["title"], "No matching action")

    def test_typescript(self):
        it = sf("json", "ts", clipboard='{"user":{"id":1,"tags":["a"],"x-y":null},"items":[{"a":1},{"a":2,"b":"s"}]}')
        ts = it[0]["arg"]
        self.assertIn("export interface Root", ts)
        self.assertIn("user: User;", ts)
        self.assertIn('"x-y": null;', ts)
        self.assertIn("items: Item[];", ts)
        self.assertIn("b?: string;", ts)

    def test_invalid_and_empty(self):
        it = sf("json", clipboard="{bad")
        self.assertEqual(it[0]["title"], "Invalid JSON")
        it = sf("json", clipboard="")
        self.assertEqual(it[0]["title"], "Clipboard is empty")

    def test_unescape_string(self):
        it = sf("json", clipboard=json.dumps('{"a":1}'))
        self.assertEqual(find(it, "Unescape")["arg"], '{\n  "a": 1\n}')


class UUIDTests(unittest.TestCase):
    def test_formats(self):
        it = sf("uuid")
        v4 = find(it, "UUID v4:")["arg"]
        self.assertRegex(v4, r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        v7 = find(it, "UUID v7")["arg"]
        self.assertRegex(v7, r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        import time
        ms = int(v7.replace("-", "")[:12], 16)
        self.assertLess(abs(ms - time.time() * 1000), 60000)
        self.assertRegex(find(it, "ULID")["arg"], r"^[0-9A-HJKMNP-TV-Z]{26}$")
        self.assertRegex(find(it, "Nano ID")["arg"], r"^[A-Za-z0-9_-]{21}$")
        self.assertRegex(find(it, "UUID v4 without")["arg"], r"^[0-9a-f]{32}$")

    def test_count_and_filter(self):
        it = sf("uuid", "5 v7")
        self.assertEqual(len(it), 1)
        ids = it[0]["arg"].split("\n")
        self.assertEqual(len(ids), 5)
        self.assertEqual(len(set(ids)), 5)
        self.assertEqual(len(sf("uuid", "5000")[0]["arg"].split("\n")), 1000)
        self.assertEqual(sf("uuid", "nope")[0]["title"], "Unknown ID type")

    def test_uniqueness(self):
        ids = sf("uuid", "200 nano")[0]["arg"].split("\n")
        self.assertEqual(len(set(ids)), 200)


class JWTTests(unittest.TestCase):
    def test_decode(self):
        it = sf("jwt", clipboard="Bearer " + JWT)
        self.assertTrue(it[0]["title"].startswith("Expired"))
        self.assertEqual(json.loads(find(it, "Payload")["arg"])["name"], "John Doe")
        self.assertTrue(find(it, "Header · HS256"))
        self.assertEqual(find(it, "Subject (sub)")["arg"], "1234567890")
        self.assertEqual(find(it, "Issued at (iat)")["arg"], "1516239022")

    def test_typed_and_invalid(self):
        self.assertTrue(sf("jwt", JWT)[1]["title"].startswith("Payload"))
        self.assertEqual(sf("jwt", clipboard="hello")[0]["title"], "Not a JWT")
        self.assertEqual(sf("jwt", clipboard="a.b.c")[0]["title"], "Couldn’t decode the JWT")


class RegexTests(unittest.TestCase):
    def test_matches_groups(self):
        it = sf("regex", r"/(\w+)@(?<host>\w+)\.com/", clipboard="a@x.com b@y.com")
        self.assertEqual(it[0]["arg"], "a@x.com\nb@y.com")
        self.assertIn("host=x", it[1]["subtitle"])

    def test_plain_flags_replace(self):
        it = sf("regex", "/HELLO/i", clipboard="hello Hello")
        self.assertTrue(it[0]["title"].startswith("2 matches"))
        it = sf("regex", r"(\d+) => <$1>", clipboard="a1 b22")
        self.assertEqual(it[0]["arg"], "a<1> b<22>")

    def test_errors(self):
        self.assertEqual(sf("regex", "(", clipboard="x")[0]["title"], "Invalid regular expression")
        self.assertEqual(sf("regex", "z", clipboard="abc")[0]["title"], "No matches")
        self.assertEqual(sf("regex", "", clipboard="abc")[0]["title"], "Type a regular expression")

    def test_empty_matches_do_not_hang(self):
        it = sf("regex", "x*", clipboard="abc")
        self.assertTrue(it[0]["title"].startswith("4 matches"))

    def test_many_matches_capped(self):
        it = sf("regex", ".", clipboard="a" * 500)
        self.assertEqual(len(it), 1 + 50 + 1)


class HashTests(unittest.TestCase):
    def test_vectors(self):
        it = sf("hash", "abc")
        self.assertEqual(find(it, "MD5")["arg"], "900150983cd24fb0d6963f7d28e17f72")
        self.assertEqual(find(it, "SHA-1")["arg"], "a9993e364706816aba3e25717850c26c9cd0d89d")
        self.assertEqual(find(it, "SHA-256")["arg"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        self.assertTrue(find(it, "SHA-512")["arg"].startswith("ddaf35a193617aba"))
        self.assertEqual(find(it, "CRC32")["arg"], "352441c2")

    def test_unicode_and_upper(self):
        it = sf("hash", clipboard="héllo 👋", hash_uppercase="1")
        import hashlib, zlib
        b = "héllo 👋".encode()
        self.assertEqual(find(it, "SHA-256")["arg"], hashlib.sha256(b).hexdigest().upper())
        self.assertEqual(find(it, "CRC32")["arg"], format(zlib.crc32(b), "08X"))


class EncTests(unittest.TestCase):
    def test_encode(self):
        it = sf("enc", "héllo & <b>")
        import base64, urllib.parse
        self.assertEqual(find(it, "Base64:")["arg"], base64.b64encode("héllo & <b>".encode()).decode())
        self.assertEqual(find(it, "URL encode")["arg"], urllib.parse.quote("héllo & <b>", safe="-_.!~*'()"))
        self.assertEqual(find(it, "HTML encode")["arg"], "héllo &amp; &lt;b&gt;")
        self.assertEqual(find(it, "Hex")["arg"], "héllo & <b>".encode().hex())
        self.assertEqual(find(it, "Unicode escape")["arg"], "h\\u00e9llo & <b>")

    def test_decode(self):
        self.assertEqual(find(sf("enc", clipboard="aMOpbGxvIHdvcmxk"), "Base64 decode")["arg"], "héllo world")
        self.assertEqual(find(sf("enc", clipboard="a%20b%26c"), "URL decode")["arg"], "a b&c")
        self.assertEqual(find(sf("enc", clipboard="&lt;p&gt; &#233; &#x1F600;"), "HTML decode")["arg"], "<p> é 😀")
        self.assertEqual(find(sf("enc", clipboard="68c3a9"), "Hex decode")["arg"], "hé")
        self.assertEqual(find(sf("enc", clipboard="\\u00e9\\u{1f600}"), "Unicode unescape")["arg"], "é😀")

    def test_no_false_base64(self):
        titles = [i["title"] for i in sf("enc", clipboard="abcd")]
        self.assertFalse(any(t.startswith("Base64 decode") for t in titles))


class EpochTests(unittest.TestCase):
    def test_units(self):
        self.assertEqual(find(sf("epoch", "0"), "1970")["arg"], "1970-01-01T00:00:00.000Z")
        for q in ("1700000000", "1700000000000", "1700000000000000", "1700000000000000000"):
            self.assertIn("2023-11-14T22:13:20.000Z", args(sf("epoch", q)), q)

    def test_dates(self):
        it = sf("epoch", "2024-02-29T12:00:00Z")
        self.assertIn("1709208000", args(it))
        self.assertEqual(sf("epoch", "banana")[0]["title"], "Couldn’t read that date")

    def test_now(self):
        import time
        it = sf("epoch")
        secs = [int(a) for a in args(it) if re.fullmatch(r"\d{10}", a)]
        self.assertLess(abs(secs[0] - time.time()), 5)

    def test_smart_hub_skips_case_rows_without_letters(self):
        # Found in the README screenshots: a timestamp got camelCase, PascalCase… rows that repeated it
        subs = [i.get("subtitle", "") for i in sf("smart", "1790500000")]
        self.assertFalse(any("camelCase" in x for x in subs))
        subs = [i.get("subtitle", "") for i in sf("smart", "user profile")]
        self.assertTrue(any("camelCase" in x for x in subs))

    def test_rows_keep_their_uid_between_reruns(self):
        # Found in real Alfred: the clock reruns every second, and without uids the selection
        # jumped back to the first row, so ↩ copied the wrong format
        import time
        a = [i["uid"] for i in sf("epoch")]
        time.sleep(1.1)
        b = [i["uid"] for i in sf("epoch")]
        self.assertEqual(a, b)
        self.assertEqual(len(set(a)), len(a))
        # typing something else gives new uids, so the selection resets to the top as usual
        self.assertNotEqual([i["uid"] for i in sf("case", "hello")], [i["uid"] for i in sf("case", "hello world")])


class DiffTests(unittest.TestCase):
    def test_files(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a b.txt"), os.path.join(d, "b.txt")
        write(a, "one\ntwo\n")
        write(b, "one\nthree\n")
        it = sf("diff", f"{a}\t{b}")
        self.assertTrue(it[0]["title"].startswith("+1 −1"))
        self.assertIn("+three", it[0]["text"]["copy"])
        with open(it[0]["arg"]) as f:  # the diff travels as a file, not inline
            self.assertIn("+three", f.read())
        self.assertEqual(it[0]["variables"]["diff_action"], "open")
        self.assertEqual(it[0]["mods"]["alt"]["variables"]["diff_action"], "app")

    def test_identical_and_binary(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a"), os.path.join(d, "b")
        write(a, "x")
        write(b, "x")
        self.assertEqual(sf("diff", f"{a}\t{b}")[0]["title"], "Identical")
        write(b, b"\xff\xfe\x00")
        self.assertTrue(sf("diff", f"{a}\t{b}")[0]["title"].startswith("Couldn’t read"))


class SmartTests(unittest.TestCase):
    def test_detects(self):
        self.assertTrue(sf("smart", clipboard=JWT)[0]["title"].startswith("Expired"))
        self.assertTrue(sf("smart", clipboard='{"a":1}')[0]["title"].startswith("Valid JSON"))
        self.assertIn("2023-11-14T22:13:20.000Z", args(sf("smart", clipboard="1700000000")))
        it = sf("smart", "hello world")
        self.assertTrue(any(i["title"].startswith("SHA-256") for i in it))

    def test_menu_and_delegate(self):
        menu = sf("smart", clipboard="")
        self.assertEqual(len(menu), 9)
        self.assertEqual(menu[0]["autocomplete"], "json ")
        self.assertEqual([i["title"].split()[0] for i in sf("smart", "js", clipboard="text")], ["JSON"])
        self.assertTrue(sf("smart", "uuid 3")[0]["title"].startswith("UUID v4 × 3"))
        self.assertIn("  ·  jsn", sf("smart", clipboard="", keyword_json="jsn")[0]["title"])


class CaseTests(unittest.TestCase):
    def test_cases(self):
        a = args(sf("case", "userIdHTTPServer"))
        for want in ("userIdHttpServer", "UserIdHttpServer", "user_id_http_server", "USER_ID_HTTP_SERVER", "user-id-http-server", "User Id Http Server"):
            self.assertIn(want, a)
        a = args(sf("case", clipboard="the lord of the rings"))
        self.assertIn("The Lord of the Rings", a)
        self.assertIn("The lord of the rings", a)
        self.assertIn("theLordOfTheRings", args(sf("case", "The Lord of the Rings")))
        self.assertIn("écoleÉté", args(sf("case", "école été")))

    def test_filters_and_limits(self):
        self.assertEqual(sf("case", clipboard="")[0]["title"], "Clipboard is empty")
        self.assertEqual(sf("case", clipboard="x" * 6000)[0]["title"], "Text too long")


class ExtraTests(unittest.TestCase):
    def test_relaxed_json(self):
        it = sf("json", clipboard="{a: 1, 'b': 'it\\'s', // note\n c: [1,2,],}")
        self.assertTrue(it[0]["title"].startswith("Converted JS object"))
        self.assertEqual(json.loads(find(it, "Minify")["arg"]), {"a": 1, "b": "it's", "c": [1, 2]})

    def test_jsonl_csv(self):
        it = sf("json", clipboard='{"a":1}\n{"a":2,"b":"x,y"}')
        self.assertTrue(it[0]["title"].startswith("Converted JSON Lines"))
        self.assertEqual(find(it, "CSV")["arg"], 'a,b\n1,\n2,"x,y"')
        it = sf("json", clipboard='name,age\nBob,3\n"A, ""B""",4')
        self.assertEqual(json.loads(find(it, "CSV → JSON")["arg"]), [{"name": "Bob", "age": 3}, {"name": 'A, "B"', "age": 4}])
        it = sf("json", clipboard="a\tb\n1\t2")
        self.assertEqual(json.loads(find(it, "CSV → JSON")["arg"]), [{"a": 1, "b": 2}])

    def test_number_bases_and_escapes(self):
        a = args(sf("enc", "255"))
        self.assertIn("0xff", a)
        self.assertIn("0b11111111", a)
        self.assertIn("0o377", a)
        self.assertIn("255", args(sf("enc", "0o377")))
        self.assertEqual(find(sf("enc", clipboard='a\\n\\"b\\"'), "Backslash unescape")["arg"], 'a\n"b"')
        self.assertEqual(find(sf("enc", clipboard='say "hi"\n'), "Backslash escape")["arg"], 'say \\"hi\\"\\n')

    def test_json_diff(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a.json"), os.path.join(d, "b.json")
        write(a, '{"x":1,"y":2}')
        write(b, '{"y":2, "x":1}')
        self.assertEqual(sf("diff", f"{a}\t{b}")[0]["title"], "Same JSON")
        write(b, '{"y":3,"x":1}')
        self.assertIn("JSON, keys sorted", sf("diff", f"{a}\t{b}")[0]["title"])


class LargeAndFileTests(unittest.TestCase):
    def test_large_results_go_through_cache(self):
        big = os.path.join(CACHE, "big.json")
        write(big, json.dumps([{"i": i, "s": "x" * 40} for i in range(5000)]))
        e = dict(os.environ, DT_TEST_CLIPBOARD_FILE=big, alfred_workflow_cache=CACHE)
        out = subprocess.run(["osascript", "-l", "JavaScript", "./devtoolbox.js", "json", ""], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertLess(len(out.stdout), 20000)
        pretty = find(json.loads(out.stdout)["items"], "Pretty")["arg"]
        self.assertTrue(pretty.startswith("dtfile:"))
        r = subprocess.run(["./resolve.sh", pretty], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertEqual(json.loads(r.stdout)[4999]["i"], 4999)
        r = subprocess.run(["./resolve.sh", "dtfile:/etc/hosts"], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertEqual(r.stdout, "dtfile:/etc/hosts")
        r = subprocess.run(["./resolve.sh", "-n"], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertEqual(r.stdout, "-n")

    def test_hash_file_and_checksum(self):
        import hashlib
        f = os.path.join(CACHE, "file with space.bin")
        write(f, bytes(range(256)) * 10)
        digest = hashlib.sha256(bytes(range(256)) * 10).hexdigest()
        it = sf("hash", f, clipboard=f"SHA256: {digest}")
        self.assertTrue(it[0]["title"].startswith("✓ Checksum matches"))
        self.assertEqual(find(it, "SHA-256")["arg"], digest)
        it = sf("hash", f, clipboard="0" * 64)
        self.assertTrue(it[0]["title"].startswith("✗"))
        self.assertEqual(sf("hash", CACHE)[0]["title"], "That’s a folder")
        self.assertEqual(find(sf("hash", "", clipboard=""), "Clipboard is empty")["valid"], False)


class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        uids = [o["uid"] for o in p["objects"]]
        self.assertEqual(len(uids), len(set(uids)))
        for src, conns in p["connections"].items():
            self.assertIn(src, uids)
            for c in conns:
                self.assertIn(c["destinationuid"], uids)
        for o in p["objects"]:
            kw = o["config"].get("keyword")
            if kw:
                self.assertRegex(kw, r"^\{var:keyword_\w+\}$")
        self.assertTrue(p["readme"].startswith("## Usage"))
        self.assertNotIn("alfredapp", p["bundleid"])
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)


def run_raw(args, clipboard="", **env):
    e = dict(os.environ, DT_TEST_CLIPBOARD=clipboard, alfred_workflow_cache=CACHE, **dict(FAKE, **env))
    return subprocess.run(["osascript", "-l", "JavaScript", "./devtoolbox.js", *args], cwd=SRC, env=e,
                          capture_output=True, text=True, timeout=30)


def b64url(obj):
    import base64
    raw = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def hs256(header, payload, secret):
    import hashlib, hmac, base64
    msg = f"{b64url(header)}.{b64url(payload)}"
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{msg}.{sig}"


class RegressionTests(unittest.TestCase):
    """One test per bug found in the audit."""

    def test_json_keeps_big_and_exotic_numbers(self):
        src = '{"id": 12345678901234567890, "f": 1.0, "e": 1e400, "n": -0, "ok": 1.5}'
        it = sf("json", clipboard=src)
        self.assertEqual(find(it, "Minify")["arg"], '{"id":12345678901234567890,"f":1.0,"e":1e400,"n":-0,"ok":1.5}')
        self.assertIn("12345678901234567890", find(it, "Pretty")["arg"])
        self.assertIn("id: number;", find(it, "TypeScript")["arg"])
        self.assertEqual(json.loads(find(it, "Escape")["arg"]), '{"id":12345678901234567890,"f":1.0,"e":1e400,"n":-0,"ok":1.5}')
        it = sf("json", clipboard='[{"a": 90071992547409931}]')
        self.assertEqual(find(it, "CSV")["arg"], "a\n90071992547409931")
        self.assertEqual(find(it, "JSON Lines")["arg"], '{"a":90071992547409931}')

    def test_json_proto_key_not_lost(self):
        it = sf("json", "sort", clipboard='{"__proto__": {"x": 1}, "b": 2}')
        self.assertEqual(json.loads(it[0]["arg"]), {"__proto__": {"x": 1}, "b": 2})

    def test_json_duplicate_keys_warned(self):
        it = sf("json", clipboard='{"a": 1, "b": {"a": 1}, "a": 2}')
        self.assertIn('Duplicate key "a"', it[0]["subtitle"])
        self.assertNotIn("Duplicate", sf("json", clipboard='{"a": {"a": 1}, "b": [{"a": 1}, {"a": 2}]}')[0]["subtitle"])

    def test_json_null_kind(self):
        self.assertEqual(sf("json", clipboard="null")[0]["title"], "Valid JSON · null")

    def test_relaxed_json_respects_strings(self):
        it = sf("json", clipboard="{a: \"b // c\", u: 'http://x.com/a', w: 'x, }', c: \"/* no */\", // real\n t: [1,],}")
        self.assertEqual(json.loads(find(it, "Minify")["arg"]),
                         {"a": "b // c", "u": "http://x.com/a", "w": "x, }", "c": "/* no */", "t": [1]})
        it = sf("json", clipboard="{s: 'say \"hi\"', q: 'it\\'s'}")
        self.assertEqual(json.loads(find(it, "Minify")["arg"]), {"s": 'say "hi"', "q": "it's"})

    def test_json_error_position(self):
        it = sf("json", clipboard='{"a": 1\n "b": 2}')
        self.assertEqual(it[0]["title"], "Invalid JSON")
        self.assertIn("line 2, column 2", it[0]["subtitle"])

    def test_json_huge_string(self):
        big = os.path.join(CACHE, "bigstr.json")
        write(big, json.dumps({"s": "x" * 1500000, "n": 12345678901234567890}))
        e = dict(os.environ, DT_TEST_CLIPBOARD_FILE=big, alfred_workflow_cache=CACHE)
        out = subprocess.run(["osascript", "-l", "JavaScript", "./devtoolbox.js", "json", ""], cwd=SRC, env=e, capture_output=True, text=True)
        items = json.loads(out.stdout)["items"]
        self.assertTrue(items[0]["title"].startswith("Valid JSON"))
        r = subprocess.run(["./resolve.sh", find(items, "Minify")["arg"]], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertTrue(r.stdout.endswith('"n":12345678901234567890}'))

    def test_csv_keeps_leading_zeros(self):
        it = sf("json", clipboard="zip,n\n01234,5\n00501,1.50")
        self.assertEqual(json.loads(find(it, "CSV → JSON")["arg"]), [{"zip": "01234", "n": 5}, {"zip": "00501", "n": "1.50"}])

    def test_csv_quoted_newlines(self):
        it = sf("json", clipboard='a,b\n"line1\nline2",2\n3,4')
        self.assertEqual(json.loads(find(it, "CSV → JSON")["arg"]), [{"a": "line1\nline2", "b": 2}, {"a": 3, "b": 4}])

    def test_case_keeps_combining_marks(self):
        a = args(sf("case", clipboard="café au lait"))
        self.assertIn("café_au_lait", a)
        self.assertIn("caféAuLait", a)

    def test_jwt_non_object_parts(self):
        none = b64url({"alg": "none"})
        it = sf("jwt", clipboard=f"{none}.{b64url(b'null')}.")
        self.assertEqual(it[0]["title"], "Payload is not a JSON object")
        self.assertTrue(any(i["title"].startswith("⚠ Unsigned") for i in it))
        it = sf("jwt", clipboard=f"{none}.{b64url(b'hello world')}.")
        self.assertEqual(find(it, "Payload (not JSON)")["arg"], "hello world")
        self.assertEqual(sf("jwt", clipboard=f"{b64url(b'null')}.{b64url({'a': 1})}.")[0]["title"], "Couldn’t decode the JWT")

    def test_jwt_out_of_range_dates(self):
        it = sf("jwt", clipboard=f"{b64url({'alg': 'HS256'})}.{b64url({'exp': 1e20, 'iat': -1e20})}.x")
        self.assertNotEqual(it[0]["title"], "DevToolbox error")
        self.assertEqual(find(it, "Expires (exp)")["arg"], "1e+20")  # kept exactly as written in the token

    def test_jwt_not_yet_valid(self):
        import time
        it = sf("jwt", clipboard=f"{b64url({'alg': 'HS256'})}.{b64url({'nbf': int(time.time()) + 3600, 'exp': int(time.time()) + 7200})}.x")
        self.assertTrue(it[0]["title"].startswith("Not valid yet"))

    def test_jwt_quotes_and_header_prefix(self):
        self.assertTrue(sf("jwt", clipboard=f'Authorization: Bearer "{JWT}"')[0]["title"].startswith("Expired"))

    def test_enc_invalid_code_points_do_not_crash(self):
        it = sf("enc", clipboard="&#99999999; &#65; \\u{110000} \\u0041")
        self.assertIn("&#99999999; A", find(it, "HTML decode")["arg"])
        self.assertIn("\\u{110000} A", find(it, "Unicode unescape")["arg"])
        self.assertEqual(find(sf("enc", clipboard="\\u{110000}\\n"), "Backslash unescape")["arg"], "\\u{110000}\n")

    def test_enc_no_false_hex_and_negative_numbers(self):
        titles = [i["title"] for i in sf("enc", clipboard="2024")]
        self.assertFalse(any(t.startswith("Hex decode") for t in titles))
        a = args(sf("enc", "-5"))
        self.assertIn("-0x5", a)
        self.assertIn("-0b101", a)
        self.assertIn("0x18ee90ff6c373e0ee4e3f0ad2", args(sf("enc", "123456789012345678901234567890")))

    def test_smart_domain_is_not_a_jwt(self):
        it = sf("smart", clipboard="www.example-domain.com")
        self.assertFalse(any("JWT" in i["title"] for i in it))

    def test_smart_does_not_delegate_multiline_or_useless(self):
        it = sf("smart", "json is great\nreally", clipboard="")
        self.assertTrue(any(i["title"].startswith("SHA-256") for i in it))
        import hashlib
        it = sf("smart", "uuid are cool", clipboard="")
        self.assertEqual(find(it, "SHA-256")["arg"], hashlib.sha256(b"uuid are cool").hexdigest())

    def test_diff_rejects_wrong_file_count(self):
        d = tempfile.mkdtemp()
        fs = [os.path.join(d, n) for n in "abc"]
        for f in fs:
            write(f, f)
        self.assertEqual(sf("diff", "\t".join(fs))[0]["title"], "Select exactly two files")

    def test_diff_files_as_separate_args_and_dash_names(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "-q"), os.path.join(d, "--version")
        write(a, "one\n")
        write(b, "two\n")
        out = run_raw(["diff", a, b])
        it = json.loads(out.stdout)["items"]
        self.assertTrue(it[0]["title"].startswith("+1 −1"), it)

    def test_diff_action_copy_reads_file(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a"), os.path.join(d, "b")
        write(a, "x\n")
        write(b, "y\n")
        it = sf("diff", f"{a}\t{b}")[0]
        self.assertTrue(os.path.exists(it["variables"]["diff_file"]))

    def test_resolve_only_reads_cache_results(self):
        e = dict(os.environ, alfred_workflow_cache=CACHE)
        os.makedirs(os.path.join(CACHE, "result-"), exist_ok=True)
        sneaky = f"dtfile:{CACHE}/result-/../bigstr.json"
        r = subprocess.run(["./resolve.sh", sneaky], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertEqual(r.stdout, sneaky)

    def test_regex_catastrophic_backtracking_is_reported(self):
        it = sf("regex", "(a+)+$", clipboard="a" * 40 + "b")
        self.assertTrue(it[0]["title"].startswith("⚠ Pattern too slow"))

    def test_regex_watchdog(self):
        import time
        t = time.time()
        out = run_raw(["regex", "x"], clipboard="x", DT_TEST_HANG="1")
        self.assertLess(time.time() - t, 8)
        self.assertTrue(json.loads(out.stdout)["items"][0]["title"].startswith("⚠ Pattern too slow"))

    def test_regex_unicode_empty_matches(self):
        it = sf("regex", "/x*/gu", clipboard="😀a")
        self.assertTrue(it[0]["title"].startswith("3 matches"))

    def test_clipboard_too_large(self):
        big = os.path.join(CACHE, "huge.txt")
        write(big, "a" * (2 * 1024 * 1024 + 10))
        e = dict(os.environ, DT_TEST_CLIPBOARD_FILE=big, alfred_workflow_cache=CACHE)
        out = subprocess.run(["osascript", "-l", "JavaScript", "./devtoolbox.js", "case", ""], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout)["items"][0]["title"], "Clipboard is larger than 2 MB")

    def test_lone_surrogates_in_output(self):
        out = run_raw(["enc", "\\ud800x"])
        self.assertEqual(out.returncode, 0)
        self.assertNotIn("\\ud800", out.stdout.lower().replace("\\\\ud800", ""))
        self.assertEqual(find(json.loads(out.stdout)["items"], "Unicode unescape")["arg"], "�x")

    def test_hash_big_file_crc_matches_zlib(self):
        import zlib, hashlib
        f = os.path.join(CACHE, "big.bin")
        blob = os.urandom(1024 * 1024) * 20
        write(f, blob)
        it = sf("hash", f)
        self.assertEqual(find(it, "CRC32")["arg"], format(zlib.crc32(blob), "08x"))
        self.assertEqual(find(it, "MD5")["arg"], hashlib.md5(blob).hexdigest())


class FeatureTests(unittest.TestCase):
    def test_jwt_verify_hs256(self):
        tok = hs256({"alg": "HS256", "typ": "JWT"}, {"sub": "1"}, "s3cret")
        self.assertTrue(any(i["title"] == "✓ Signature verified (HS256)" for i in sf("jwt", "s3cret", clipboard=tok)))
        self.assertTrue(any(i["title"] == "✗ Invalid signature (HS256)" for i in sf("jwt", f"{tok} nope")))
        it = sf("jwt", clipboard=tok)
        self.assertIn("type the secret", it[0]["subtitle"])

    def test_uuid_decode(self):
        import uuid as U
        u1 = U.uuid1()
        it = sf("uuid", str(u1).upper())
        self.assertEqual(it[0]["title"], "UUID version 1 · RFC 9562")
        import datetime
        ms = (u1.time - 0x01B21DD213814000) // 10000
        self.assertEqual(find(it, "Created (Unix ms)")["arg"], str(ms))
        self.assertIn(u1.urn, args(it))
        it = sf("uuid", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
        self.assertEqual(find(it, "Created (Unix ms)")["arg"], "1469922850259")
        v7 = find(sf("uuid"), "UUID v7")["arg"]
        self.assertTrue(sf("smart", clipboard=v7)[0]["title"].startswith("UUID version 7"))

    def test_uuid_batches_sorted(self):
        for kind in ("v7", "ulid"):
            ids = sf("uuid", f"300 {kind}")[0]["arg"].split("\n")
            self.assertEqual(ids, sorted(ids))

    def test_checksum_from_shasum_output(self):
        import hashlib
        f = os.path.join(CACHE, "dl.bin")
        write(f, b"payload")
        digest = hashlib.sha256(b"payload").hexdigest()
        self.assertTrue(sf("hash", f, clipboard=f"{digest}  dl.bin\n")[0]["title"].startswith("✓"))
        self.assertTrue(sf("hash", f, clipboard=f"SHA256 (dl.bin) = {digest}")[0]["title"].startswith("✓"))

    def test_regex_replacement_escapes(self):
        it = sf("regex", r"/,\s*/ => \n", clipboard="a, b,c")
        self.assertEqual(it[0]["arg"], "a\nb\nc")

    def test_text_stats(self):
        it = sf("case", "héllo 👋🏽 world\nbye")
        self.assertEqual(it[-1]["title"], "17 characters · 3 words · 2 lines · 25 bytes UTF-8")


class SecondPassTests(unittest.TestCase):
    def test_regex_double_backslash_is_one_backslash(self):
        self.assertEqual(sf("regex", r"/,/ => \\", clipboard="a,b")[0]["arg"], "a\\b")

    def test_hash_text_ignores_clipboard_checksum(self):
        it = sf("hash", "abc", clipboard="d41d8cd98f00b204e9800998ecf8427e")
        self.assertTrue(it[0]["title"].startswith("MD5"))

    def test_smart_md5_is_not_a_uuid(self):
        it = sf("smart", clipboard="d41d8cd98f00b204e9800998ecf8427e")
        self.assertFalse(any(i["title"].startswith("UUID version") for i in it))
        self.assertTrue(sf("uuid", "d41d8cd98f00b204e9800998ecf8427e")[0]["title"].startswith("UUID version"))

    def test_json_error_line_counts_leading_blank_lines(self):
        it = sf("json", clipboard='\n\n{"a": 1,,}')
        self.assertIn("line 3", it[0]["subtitle"])

    def test_relaxed_json_escaped_quote_and_tab(self):
        it = sf("json", clipboard="{a: \"it\\'s\", b: 'x\ty'}")
        self.assertEqual(json.loads(find(it, "Minify")["arg"]), {"a": "it's", "b": "x\ty"})

    def test_big_json_is_fast(self):
        import time
        big = os.path.join(CACHE, "perf.json")
        write(big, json.dumps([{"i": i, "big": 2**60 + i, "name": "x" * 30, "tags": ["a", "b"]} for i in range(20000)]))
        e = dict(os.environ, DT_TEST_CLIPBOARD_FILE=big, alfred_workflow_cache=CACHE)
        t = time.time()
        out = subprocess.run(["osascript", "-l", "JavaScript", "./devtoolbox.js", "json", ""], cwd=SRC, env=e, capture_output=True, text=True)
        self.assertLess(time.time() - t, 3)
        self.assertTrue(json.loads(out.stdout)["items"][0]["title"].startswith("Valid JSON · 20000 items"))


class FinalReviewTests(unittest.TestCase):
    """Bugs found in the final release review."""

    def test_prototype_names_are_not_tools_or_entities(self):
        for q in ("constructor", "constructor foo", "__proto__ x", "toString"):
            it = sf("smart", q, clipboard="hello")
            self.assertNotEqual(it[0]["title"], "DevToolbox error", q)
        it = sf("enc", "a &constructor; b")
        self.assertFalse(any("native code" in i["title"] for i in it))

    def test_jwt_prototype_alg_and_claims(self):
        tok = f"{b64url({'alg': 'constructor'})}.{b64url({'constructor': 1, '__proto__': 2})}.x"
        it = sf("jwt", tok)
        titles = [i["title"] for i in it]
        self.assertIn("constructor: 1", titles)
        self.assertIn("__proto__: 2", titles)
        it = sf("jwt", tok + " secret")
        self.assertTrue(any(t["title"].startswith("Can’t verify") for t in it))

    def test_jwt_payload_keeps_big_numbers(self):
        payload = b'{"id":12345678901234567890}'
        tok = f"{b64url({'alg': 'HS256'})}.{b64url(payload)}.x"
        it = sf("jwt", tok)
        self.assertIn("12345678901234567890", find(it, "Payload")["arg"])
        self.assertEqual(find(it, "id:")["arg"], "12345678901234567890")

    def test_csv_missing_prototype_key(self):
        it = sf("json", "csv", clipboard='[{"a":1},{"constructor":2}]')
        self.assertEqual(it[0]["arg"], "a,constructor\n1,\n,2")

    def test_titles_drop_bidi_and_control_chars(self):
        it = sf("case", clipboard="x\u202egnp.exe\x07")
        for i in it:
            self.assertNotRegex(i["title"] + i.get("subtitle", ""), "[\u202a-\u202e\u2066-\u2069\x00-\x1f]")
        self.assertIn("\u202e", find(it, "x").get("arg", "") + "".join(args(it)))

    def test_truncation_does_not_split_emoji(self):
        it = sf("case", clipboard="\U0001F600" * 100)
        self.assertNotIn("\ufffd", "".join(i["title"] for i in it))

    def test_diff_copies_do_not_pile_up(self):
        for n in range(3):
            d = tempfile.mkdtemp()
            a, b = os.path.join(d, f"x{n}"), os.path.join(d, f"y{n}")
            write(a, "1\n")
            write(b, "2\n")
            sf("diff", f"{a}\t{b}")
        self.assertEqual(sorted(os.listdir(os.path.join(CACHE, "diff"))), ["x2.a.txt", "y2.b.txt"])


def alfred_env(home, **extra):
    """The environment Alfred gives a script: no LANG/LC_*, no Homebrew on PATH, Alfred's variables."""
    bid = "io.github.x-o-r-r-o.devtoolbox"
    e = {"HOME": home, "USER": os.environ.get("USER", "user"), "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
         "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
         "alfred_workflow_cache": os.path.join(home, "Library/Caches/com.runningwithcrayons.Alfred/Workflow Data", bid),
         "alfred_workflow_data": os.path.join(home, "Library/Application Support/Alfred/Workflow Data", bid),
         "alfred_preferences": os.path.join(home, "Library/Application Support/Alfred/Alfred.alfredpreferences"),
         "alfred_version": "5.6", "alfred_version_build": "2290", "alfred_theme_subtext": "0",
         "alfred_workflow_bundleid": bid, "alfred_workflow_name": "DevToolbox", "alfred_workflow_version": "1.0.0",
         "alfred_workflow_uid": "user.workflow.TEST", "alfred_debug": "1"}
    e.update(FAKE)
    e.update(extra)
    return e


class Round4Tests(unittest.TestCase):
    """Real-runtime conditions and v1.1 improvements."""

    def run_alfred(self, args, killed=False, **extra):
        home = tempfile.mkdtemp(prefix="devtoolbox home ")
        e = alfred_env(home, **extra)
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./devtoolbox.js", *args], cwd=SRC, env=e,
                             capture_output=True, timeout=30)
        self.assertEqual(out.returncode, -9 if killed else 0, out.stderr)  # the regex watchdog uses kill -9
        return e, out.stdout.decode("utf-8")

    def test_alfred_env_fresh_install_unicode_and_large_results(self):
        # No LANG, cache folder with spaces that doesn't exist yet (fresh install)
        big = os.path.join(CACHE, "r4 big.json")
        write(big, json.dumps([{"i": i, "s": "é" * 40} for i in range(3000)], ensure_ascii=False))
        e, out = self.run_alfred(["json", ""], DT_TEST_CLIPBOARD_FILE=big)
        self.assertFalse(os.path.exists(e["alfred_workflow_data"]))  # nothing is written there
        pretty = find(json.loads(out)["items"], "Pretty")["arg"]
        self.assertTrue(pretty.startswith("dtfile:" + e["alfred_workflow_cache"] + "/result-"))
        r = subprocess.run(["/bin/bash", "./resolve.sh", pretty], cwd=SRC, env=e, capture_output=True)
        self.assertEqual(json.loads(r.stdout.decode("utf-8"))[2999]["s"], "é" * 40)
        e, out = self.run_alfred(["case", "héllo wörld 👋"], DT_TEST_CLIPBOARD="")
        self.assertIn("héllo_wörld", args(json.loads(out)["items"]))
        e, out = self.run_alfred(["regex", "x"], killed=True, DT_TEST_CLIPBOARD="x", DT_TEST_HANG="1")
        self.assertTrue(json.loads(out)["items"][0]["title"].startswith("⚠ Pattern too slow"))

    def test_alfred_env_diff_in_fresh_cache(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "ä 1.txt"), os.path.join(d, "b.txt")
        write(a, "one\nzwei\n")
        write(b, "one\ndrei\n")
        e, out = self.run_alfred(["diff", a, b])
        it = json.loads(out)["items"][0]
        self.assertTrue(it["title"].startswith("+1 −1"), it)
        self.assertTrue(it["arg"].startswith(e["alfred_workflow_cache"]))

    def test_config_values_as_alfred_passes_them(self):
        self.assertEqual(find(sf("hash", "abc", hash_uppercase="0"), "MD5")["arg"], "900150983cd24fb0d6963f7d28e17f72")
        self.assertEqual(find(sf("json", clipboard='{"a":1}', json_indent="bogus"), "Pretty")["arg"], '{\n  "a": 1\n}')
        menu = sf("smart", clipboard="", keyword_json="", keyword_uuid="  Ü2 ")
        self.assertTrue(menu[0]["title"].endswith("·  json"), menu[0])
        self.assertTrue(menu[1]["title"].endswith("·  Ü2"), menu[1])

    def test_regex_empty_replacement_after_alfred_trims(self):
        self.assertEqual(sf("regex", r"/\d+/ =>", clipboard="a1b22")[0]["arg"], "ab")
        self.assertEqual(sf("regex", r"\d => ", clipboard="a1b2")[0]["arg"], "ab")
        # without delimiters a trailing " =>" is part of the pattern (e.g. arrow functions)
        self.assertTrue(sf("regex", r"\) =>", clipboard="f = (x) => x")[0]["title"].startswith("1 match"))

    def test_regex_script_filter_keeps_spaces(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        modes = {o["config"]["keyword"]: o["config"]["argumenttrimmode"] for o in p["objects"] if "keyword" in o["config"]}
        self.assertEqual(modes["{var:keyword_regex}"], 1)
        self.assertEqual(modes["{var:keyword_json}"], 0)

    def test_uuid_name_based_nil_max(self):
        import uuid as U
        self.assertEqual(sf("uuid", "v5 dns example.com")[0]["arg"], str(U.uuid5(U.NAMESPACE_DNS, "example.com")))
        self.assertEqual(sf("uuid", "V3 URL https://é.com/a b")[0]["arg"], str(U.uuid3(U.NAMESPACE_URL, "https://é.com/a b")))
        ns = "1b671a64-40d5-491e-99b0-da01ff1f3341"
        self.assertEqual(sf("uuid", f"v5 {ns} Name")[1]["arg"], str(U.uuid5(U.UUID(ns), "Name")).upper())
        self.assertEqual(sf("uuid", "v5")[0]["valid"], False)
        self.assertEqual(sf("uuid", "v5 bogus x")[0]["title"], "Unknown namespace")
        self.assertEqual(sf("uuid", "v5 dns")[0]["title"], "Type a name after the namespace")
        self.assertEqual(sf("uuid", "nil")[0]["arg"], "00000000-0000-0000-0000-000000000000")
        self.assertEqual(sf("uuid", "max")[0]["arg"], "ffffffff-ffff-ffff-ffff-ffffffffffff")
        self.assertEqual(len(sf("uuid")), 6)  # nil and max only appear when asked for
        self.assertEqual(sf("smart", "uuid v5 dns example.com")[0]["arg"], str(U.uuid5(U.NAMESPACE_DNS, "example.com")))

    def test_hash_file_copied_in_finder(self):
        import hashlib
        f = os.path.join(CACHE, "copied file.bin")
        write(f, b"copied")
        it = sf("hash", clipboard="copied file.bin", DT_TEST_CLIPBOARD_FILES=f)
        self.assertEqual(find(it, "SHA-256")["arg"], hashlib.sha256(b"copied").hexdigest())
        self.assertIn("copied file", it[0]["subtitle"])
        self.assertEqual(find(sf("hash", "abc", DT_TEST_CLIPBOARD_FILES=f), "MD5")["arg"], "900150983cd24fb0d6963f7d28e17f72")
        self.assertEqual(sf("hash", DT_TEST_CLIPBOARD_FILES=f"{f}\t{f}")[0]["title"], "2 files copied")

    def test_diff_files_copied_in_finder(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a.txt"), os.path.join(d, "b.txt")
        write(a, "1\n")
        write(b, "2\n")
        self.assertTrue(sf("diff", DT_TEST_CLIPBOARD_FILES=f"{a}\t{b}")[0]["title"].startswith("+1 −1 · a.txt → b.txt"))

    def test_diff_headers_show_real_names(self):
        # Found in real Alfred: the copied diff showed the cache copies ("one txt.a.txt")
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "one txt"), os.path.join(d, "two.txt")
        write(a, "1\n")
        write(b, "2\n")
        diff = open(sf("diff", f"{a}\t{b}")[0]["arg"]).read()
        self.assertTrue(diff.startswith("--- one txt\n+++ two.txt\n"), diff[:80])

    def test_diff_clipboard_history_database(self):
        import sqlite3, time
        db = os.path.join(CACHE, "clipboard.alfdb")
        if os.path.exists(db):
            os.remove(db)
        c = sqlite3.connect(db, isolation_level=None)
        c.execute("CREATE TABLE clipboard(item, ts decimal, app, apppath, dataType integer, dataHash)")
        c.executemany("INSERT INTO clipboard VALUES (?, ?, '', '', ?, '')", [("old\n", 1, 0), ("new\n", 2, 0), ("/img.png", 3, 1)])
        self.assertTrue(sf("diff", DT_TEST_CLIPBOARD_DB=db)[0]["title"].startswith("+1 −1 · previous → current"))
        c.execute("BEGIN EXCLUSIVE")  # Alfred writing: wait, then say so instead of "turn it on"
        t = time.time()
        self.assertEqual(sf("diff", DT_TEST_CLIPBOARD_DB=db)[0]["title"], "Couldn’t read Alfred’s Clipboard History")
        self.assertLess(time.time() - t, 5)
        c.execute("ROLLBACK")
        c.close()
        self.assertEqual(sf("diff")[0]["title"], "Alfred’s Clipboard History is not available")

    def test_diff_app_found_outside_alfreds_path(self):
        d = tempfile.mkdtemp(prefix="tools dir ")
        log = os.path.join(d, "args.txt")
        for tool in ("bbdiff", "code"):
            write(os.path.join(d, tool), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$DT_LOG"\n')
            os.chmod(os.path.join(d, tool), 0o755)
        common = dict(diff_action="app", diff_a="/x/a b.txt", diff_b="/x/b.txt", DT_TEST_TOOL_DIRS=d, DT_LOG=log)
        out = run_raw(["diff-action", "/x/f.diff"], diff_app="bbedit", **common)
        self.assertEqual(out.stdout, "")  # nothing printed: no empty notification
        with open(log) as f:
            self.assertEqual(f.read(), "/x/a b.txt\n/x/b.txt\n")
        run_raw(["diff-action", "/x/f.diff"], diff_app="vscode", **common)
        with open(log) as f:
            self.assertEqual(f.read(), "--diff\n/x/a b.txt\n/x/b.txt\n")
        out = run_raw(["diff-action", "/x/f.diff"], diff_app="kaleidoscope", **common)
        self.assertEqual(out.stdout.strip(), "Kaleidoscope: its command-line tool (ksdiff) is not installed")

    def test_bbdiff_differ_status_is_not_an_error(self):
        # Found in real Alfred: bbdiff exits 1 when the files differ, which showed "BBEdit couldn’t open the comparison"
        d = tempfile.mkdtemp()
        for tool, status in (("bbdiff", 1), ("code", 1)):
            write(os.path.join(d, tool), "#!/bin/sh\nexit %d\n" % status)
            os.chmod(os.path.join(d, tool), 0o755)
        common = dict(diff_action="app", diff_a="/x/a.txt", diff_b="/x/b.txt", DT_TEST_TOOL_DIRS=d)
        self.assertEqual(run_raw(["diff-action", "/x/f.diff"], diff_app="bbedit", **common).stdout, "")
        self.assertEqual(run_raw(["diff-action", "/x/f.diff"], diff_app="vscode", **common).stdout.strip(), "Visual Studio Code couldn’t open the comparison")


if __name__ == "__main__":
    unittest.main(verbosity=1)
