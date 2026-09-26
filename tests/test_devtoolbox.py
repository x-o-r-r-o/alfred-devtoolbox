#!/usr/bin/env python3
"""End-to-end tests: run the script filters the way Alfred does and validate the JSON."""
import json, os, plistlib, re, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
CACHE = tempfile.mkdtemp(prefix="devtoolbox-test-")


def sf(cmd, query="", clipboard="", **env):
    e = dict(os.environ, DT_TEST_CLIPBOARD=clipboard, alfred_workflow_cache=CACHE, **env)
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
        self.assertEqual(sf("jwt", clipboard="a.b.c")[0]["title"], "Could not decode JWT")


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
        self.assertEqual(sf("epoch", "banana")[0]["title"], "Could not read that date")

    def test_now(self):
        import time
        it = sf("epoch")
        secs = [int(a) for a in args(it) if re.fullmatch(r"\d{10}", a)]
        self.assertLess(abs(secs[0] - time.time()), 5)


class DiffTests(unittest.TestCase):
    def test_files(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a b.txt"), os.path.join(d, "b.txt")
        write(a, "one\ntwo\n")
        write(b, "one\nthree\n")
        it = sf("diff", f"{a}\t{b}")
        self.assertTrue(it[0]["title"].startswith("+1 −1"))
        self.assertIn("+three", it[0]["arg"])
        self.assertEqual(it[0]["variables"]["diff_action"], "open")
        self.assertEqual(it[0]["mods"]["alt"]["variables"]["diff_action"], "app")

    def test_identical_and_binary(self):
        d = tempfile.mkdtemp()
        a, b = os.path.join(d, "a"), os.path.join(d, "b")
        write(a, "x")
        write(b, "x")
        self.assertEqual(sf("diff", f"{a}\t{b}")[0]["title"], "Identical")
        write(b, b"\xff\xfe\x00")
        self.assertTrue(sf("diff", f"{a}\t{b}")[0]["title"].startswith("Can't read"))


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
        self.assertEqual(sf("hash", CACHE)[0]["title"], "That's a folder")
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


if __name__ == "__main__":
    unittest.main(verbosity=1)
