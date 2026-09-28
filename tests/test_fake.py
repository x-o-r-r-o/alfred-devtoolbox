#!/usr/bin/env python3
"""End-to-end tests for the `fake` keyword (random and fake data): run it the way Alfred does."""
import csv, io, json, os, plistlib, re, subprocess, sys, tempfile, time, unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_devtoolbox import CACHE, ROOT, SRC, alfred_env, find, sf, validate  # noqa: E402

RESERVED_PHONES = {
    "en_US": r"^\(\d{3}\) 555-01\d\d$",
    "en_GB": r"^(020 7946 0|07700 900|0161 496 0|0121 496 0|0131 496 0|0141 496 0|0113 496 0|0117 496 0|029 2018 0|01632 960)\d{3}$",
    "en_AU": r"^\(0[2378]\) (5550|7010) \d{4}$",
    "de_DE": r"^(030 23125|069 90009|040 66969|0221 4710|089 99998)\d{3}$",
    "fr_FR": r"^0(1 99 00|2 61 91|3 53 01|4 65 71|5 36 49|6 39 98) \d\d \d\d$",
}
TEST_CARDS = {"4242424242424242", "4000056655665556", "5555555555554444", "2223003122003222", "5200828282828210",
              "378282246310005", "371449635398431", "6011111111111117", "6011000990139424", "3056930009020004",
              "36227206271667", "3566002020360505", "6200000000000005"}


def fake(query="", **env):
    return sf("fake", query, **env)


def value(item):
    """The copied value: large ones are resolved from the cache like resolve.sh does."""
    arg = item["arg"]
    if arg.startswith("dtfile:"):
        with open(arg[7:], encoding="utf-8") as f:
            return f.read()
    return arg


def lines(item):
    return value(item).split("\n")


def by_uid(items, gid):
    for it in items:
        if it.get("uid") == "fake." + gid:
            return it
    raise AssertionError(f"no fake.{gid}: {[i.get('uid') for i in items]}")


def luhn(n):
    total = 0
    for i, d in enumerate(reversed(n)):
        d = int(d)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def iban_ok(iban):
    s = iban[4:] + iban[:4]
    return int("".join(str(int(ch, 36)) for ch in s)) % 97 == 1


def run_alfred_fake(query, **extra):
    home = tempfile.mkdtemp(prefix="fake home ")
    e = alfred_env(home, **extra)
    out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./devtoolbox.js", "fake", query], cwd=SRC, env=e,
                         capture_output=True, timeout=30)
    assert out.returncode == 0, out.stderr
    data = json.loads(out.stdout.decode("utf-8"))
    validate(data)
    return e, data["items"]


class ListTests(unittest.TestCase):
    def test_list_rows_and_mods(self):
        it = fake()
        uids = [i["uid"] for i in it]
        self.assertEqual(len(uids), len(set(uids)))
        self.assertEqual(uids[0], "fake.name")
        self.assertEqual(it[-1]["uid"], "fake.tips")
        self.assertIs(it[-1]["valid"], False)
        for i in it[:-1]:
            self.assertTrue(i["uid"].startswith("fake."), i)
            self.assertTrue(i["arg"], i)
            self.assertEqual(i["mods"]["cmd"]["arg"], i["arg"])
            self.assertTrue(i["mods"]["alt"]["arg"])
            self.assertIn(i["variables"]["fake_secret"], ("0", "1"))
        self.assertGreater(len(it), 40)
        self.assertTrue(sf("smart", clipboard="")[-1]["title"].startswith("Fake data"))

    def test_rows_describe_one_person_and_place(self):
        for _ in range(3):
            it = fake()
            first, last = by_uid(it, "first-name")["arg"], by_uid(it, "last-name")["arg"]
            self.assertEqual(by_uid(it, "name")["arg"], f"{first} {last}")
            email = by_uid(it, "email")["arg"]
            self.assertRegex(email, r"@example\.(com|net|org)$")
            self.assertIn(re.sub(r"[^a-z]", "", last.lower()), email)
            city = by_uid(it, "city")["arg"]
            self.assertIn(city, by_uid(it, "address")["arg"])
            self.assertIn(by_uid(it, "postcode")["arg"], by_uid(it, "address")["arg"].replace("\n", " "))
            self.assertTrue(by_uid(it, "address")["arg"].startswith(by_uid(it, "street")["arg"]))

    def test_us_address_postcode_matches_city(self):
        with open(os.path.join(SRC, "fake", "en_US.json"), encoding="utf-8") as f:
            cities = {}
            for c in json.load(f)["cities"]:
                cities.setdefault(c[0], set()).add(c[2])
        for addr in fake("address 50")[0]["arg"].split("\n\n"):
            street, rest = addr.split("\n")
            m = re.match(r"^(.+), ([A-Z]{2}) (\d{5})$", rest)
            self.assertTrue(m, addr)
            self.assertTrue(any(m.group(3).startswith(p) for p in cities[m.group(1)]), addr)

    def test_filter_and_exact_match_first(self):
        self.assertEqual(fake("name")[0]["uid"], "fake.name")
        self.assertEqual(fake("first name")[0]["uid"], "fake.first-name")
        self.assertEqual(fake("zzz")[0]["title"], "No matching generator")
        self.assertEqual(fake("em")[0]["uid"], "fake.email")  # word prefix: “lorem” doesn’t match “em”
        self.assertNotIn("fake.words", [i["uid"] for i in fake("em")])
        # rows only listed when asked for
        self.assertNotIn("fake.uuid7", [i["uid"] for i in fake()])
        self.assertEqual(fake("uuid7")[0]["uid"], "fake.uuid7")
        self.assertRegex(fake("uuid7")[0]["arg"], r"^[0-9a-f]{8}-[0-9a-f]{4}-7")
        self.assertRegex(fake("ulid")[0]["arg"], r"^[0-9A-HJKMNP-TV-Z]{26}$")

    def test_count(self):
        it = fake("email 10")
        self.assertEqual(len(it), 1)
        self.assertEqual(len(lines(it[0])), 10)
        self.assertTrue(it[0]["subtitle"].startswith("10 × Email"))
        self.assertEqual(len(lines(fake("email x3")[0])), 3)
        self.assertEqual(len(lines(fake("email 5000")[0])), 1000)
        self.assertEqual(len(fake("address 3")[0]["arg"].split("\n\n")), 3)
        # every generator at once: capped so each keystroke stays fast
        self.assertEqual(len(lines(by_uid(fake("5000"), "uuid"))), 100)

    def test_lorem(self):
        it = fake("lorem 5")
        self.assertEqual(len(by_uid(it, "words")["arg"].split()), 5)
        self.assertEqual(by_uid(it, "sentences")["arg"].count("."), 5)
        paras = by_uid(it, "paragraphs")["arg"].split("\n\n")
        self.assertEqual(len(paras), 5)
        self.assertTrue(paras[0].startswith("Lorem ipsum dolor sit amet, consectetur adipiscing elit."))
        self.assertEqual(fake("html 2")[0]["arg"].count("<p>"), 2)


class PasswordTests(unittest.TestCase):
    def test_password_length_classes_and_count(self):
        it = fake("password 32 5")
        pw = by_uid(it, "password")
        values = lines(pw)
        self.assertEqual(len(values), 5)
        for v in values:
            self.assertEqual(len(v), 32)
            for cls in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^A-Za-z0-9]"):
                self.assertRegex(v, cls)
            self.assertNotRegex(v, r"[\s'\"`\\]")
        self.assertIn("≈ 207 bits", pw["subtitle"])  # 32 × log2(90)
        self.assertEqual(len(set(values)), 5)
        for v in lines(by_uid(it, "alnum-password")):
            self.assertRegex(v, r"^[A-Za-z0-9]{32}$")
        for v in lines(by_uid(it, "clear-password")):
            self.assertNotRegex(v, r"[0O1lI|]")
        self.assertEqual(len(by_uid(it, "passphrase")["arg"].split("\n")[0].split("-")), 20)  # capped at 20 words
        self.assertRegex(fake("pin 4")[0]["arg"], r"^\d{4}$")
        self.assertEqual(len(fake("password 999")[0]["arg"]), 256)
        self.assertEqual(len(fake("password 3")[0]["arg"]), 4)
        self.assertEqual(len(lines(fake("password 20 500")[0])), 100)

    def test_secrets_are_transient_and_never_written(self):
        for f in os.listdir(CACHE):
            if f.startswith("fake-preview-"):
                os.remove(os.path.join(CACHE, f))
        it = fake("password 20 50")
        pw = it[0]
        self.assertEqual(pw["variables"], {"fake_secret": "1"})
        self.assertEqual(pw["mods"]["cmd"]["variables"], {"fake_secret": "1"})
        self.assertEqual(pw["mods"]["alt"]["variables"], {"fake_secret": "0"})
        self.assertNotIn("quicklookurl", pw)
        self.assertFalse([f for f in os.listdir(CACHE) if f.startswith("fake-preview-")])
        self.assertEqual(fake("password", fake_transient="0")[0]["variables"], {"fake_secret": "2"})
        self.assertEqual(fake("email")[0]["variables"], {"fake_secret": "0"})

    def test_passphrase_words_come_from_the_list(self):
        with open(os.path.join(SRC, "fake", "common.json"), encoding="utf-8") as f:
            c = json.load(f)
        words = set(c["adjectives"]) | set(c["nouns"]) | set(c["extraWords"])
        self.assertGreater(len(words), 1000)
        it = fake("passphrase 8 20")[0]
        for v in lines(it):
            parts = v.split("-")
            self.assertEqual(len(parts), 8)
            self.assertTrue(set(parts) <= words, parts)
        self.assertIn("≈ 81 bits", it["subtitle"])


class NumberTests(unittest.TestCase):
    def test_range(self):
        it = fake("1-49 6")
        nums = [int(x) for x in lines(by_uid(it, "range"))]
        self.assertEqual(len(nums), 6)
        self.assertTrue(all(1 <= n <= 49 for n in nums))
        uniq = [int(x) for x in lines(by_uid(it, "range-unique"))]
        self.assertEqual(len(set(uniq)), 6)
        self.assertEqual(uniq, sorted(uniq))
        self.assertEqual(sorted(int(x) for x in by_uid(it, "range-shuffle")["arg"].split(", ")), list(range(1, 50)))
        for d in lines(by_uid(it, "range-decimal")):
            self.assertRegex(d, r"^\d+\.\d\d$")
            self.assertTrue(1 <= float(d) <= 49)

    def test_range_spellings(self):
        for q, lo, hi in (("1..6", 1, 6), ("1 to 6", 1, 6), ("-10--5", -10, -5), ("100-1", 1, 100), ("5-5", 5, 5)):
            for x in lines(fake(q + " 30")[0]):
                self.assertTrue(lo <= int(x) <= hi, (q, x))
        it = fake("0.5-2.25")
        self.assertEqual([i["uid"] for i in it], ["fake.range-decimal"])
        self.assertRegex(it[0]["arg"], r"^[0-2]\.\d\d$")
        self.assertEqual(fake("1-99999999999999999999")[0]["title"], "Range too large")
        # every value of a small range comes up, none outside it
        seen = [int(x) for x in lines(fake("1-6 1000")[0])]
        self.assertEqual(set(seen), set(range(1, 7)))
        for k in range(1, 7):
            self.assertTrue(100 < seen.count(k) < 240, seen.count(k))

    def test_unique_numbers_from_a_huge_range(self):
        vals = [int(x) for x in lines(by_uid(fake("1-9000000000000000 1000"), "range-unique"))]
        self.assertEqual(len(set(vals)), 1000)
        self.assertTrue(all(1 <= v <= 9000000000000000 for v in vals))
        self.assertNotIn("fake.range-shuffle", [i["uid"] for i in fake("1-5000")])

    def test_dice_and_coin(self):
        it = fake("3d6+2")[0]
        total = int(it["arg"])
        self.assertTrue(5 <= total <= 20)
        rolls = [int(x) for x in re.match(r"^([\d + ]+) \+ 2 = (\d+)", it["subtitle"].split(" · ")[1]).group(1).split(" + ")]
        self.assertEqual(sum(rolls) + 2, total)
        vals = [int(x) for x in lines(fake("d20 50")[0])]
        self.assertEqual(len(vals), 50)
        self.assertTrue(all(1 <= v <= 20 for v in vals))
        self.assertTrue(all(-1 <= int(x) <= 5 for x in lines(fake("2d3-3 40")[0])))
        self.assertEqual(fake("0d6")[0]["title"], "Unsupported dice")
        self.assertEqual(fake("d1")[0]["title"], "Unsupported dice")
        self.assertTrue(set(lines(fake("coin 40")[0])) <= {"Heads", "Tails"})

    def test_digits_and_hex_are_uniform(self):
        d = fake("digits 5000")[0]["arg"]
        self.assertEqual(len(d), 5000)
        for k in "0123456789":
            self.assertTrue(380 < d.count(k) < 620, (k, d.count(k)))
        h = fake("hex 64")[0]["arg"]
        self.assertRegex(h, r"^[0-9a-f]{64}$")

    def test_pick_and_shuffle(self):
        it = fake("pick tea, coffee, green tea")
        self.assertIn(it[0]["arg"], ("tea", "coffee", "green tea"))
        self.assertEqual(sorted(it[1]["arg"].split(", ")), ["coffee", "green tea", "tea"])
        self.assertEqual(sorted(fake("shuffle a b c d")[1]["arg"].split(" ")), ["a", "b", "c", "d"])
        self.assertIs(fake("pick onlyone")[0]["valid"], False)


class RecordTests(unittest.TestCase):
    def test_json_records_with_fields(self):
        it = fake("json 5 name,email,age,active,lat,id")
        self.assertEqual(it[0]["uid"], "fake.json")
        recs = json.loads(it[0]["arg"])
        self.assertEqual(len(recs), 5)
        self.assertEqual(list(recs[0]), ["name", "email", "age", "active", "lat", "id"])
        self.assertEqual([r["id"] for r in recs], [1, 2, 3, 4, 5])
        for r in recs:
            self.assertIsInstance(r["age"], int)
            self.assertIsInstance(r["active"], bool)
            self.assertIsInstance(r["lat"], float)
            self.assertIn(re.sub(r"[^a-z]", "", r["name"].split()[-1].lower()), r["email"])  # same person
        self.assertEqual([i["uid"] for i in it], ["fake.json", "fake.csv", "fake.sql", "fake.jsonl"])
        rows = list(csv.reader(io.StringIO(by_uid(it, "csv")["arg"])))
        self.assertEqual(rows[0], ["name", "email", "age", "active", "lat", "id"])
        self.assertEqual(rows[1][0], recs[0]["name"])  # the same records in every format
        self.assertEqual([json.loads(l) for l in lines(by_uid(it, "jsonl"))], recs)
        self.assertTrue(it[0]["quicklookurl"].startswith(CACHE))
        with open(it[0]["quicklookurl"], encoding="utf-8") as f:
            self.assertEqual(f.read(), it[0]["arg"])

    def test_defaults_single_object_and_spaces(self):
        rec = json.loads(fake("json 1")[0]["arg"])
        self.assertIsInstance(rec, dict)
        self.assertEqual(list(rec), ["id", "name", "email", "phone", "company", "city", "country", "createdAt"])
        self.assertRegex(rec["createdAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(len(json.loads(fake("json")[0]["arg"])), 3)
        self.assertEqual(list(json.loads(fake("json 2 name, email")[0]["arg"])[0]), ["name", "email"])
        self.assertEqual(list(json.loads(fake("ndjson 1 city")[0]["arg"])), ["city"])

    def test_unknown_field_and_prototype_keys(self):
        self.assertEqual(fake("json 2 name,bogus")[0]["title"], "Unknown field “bogus”")
        self.assertEqual(fake("json 2 constructor")[0]["title"], "Unknown field “constructor”")
        self.assertEqual(fake("json 2 toString")[0]["title"], "Unknown field “toString”")
        rec = json.loads(fake("json 1 __proto__:name,constructor:email,user:username")[0]["arg"])
        self.assertEqual(list(rec), ["__proto__", "constructor", "user"])
        self.assertIn("@example.", rec["constructor"])
        self.assertEqual(fake("__proto__")[0]["title"], "No matching generator")
        self.assertEqual(fake("@__proto__")[0]["valid"], False)
        self.assertEqual(fake("@constructor")[0]["valid"], False)

    def test_sql_escapes_quotes(self):
        for _ in range(3):
            sql = by_uid(fake("@au sql 400 last,age"), "sql")["arg"]
            if "O''Brien" in sql:
                break
        self.assertIn("O''Brien", sql)
        self.assertNotRegex(sql, r"O'Brien")
        self.assertTrue(sql.startswith("INSERT INTO users (last, age) VALUES\n  ('"))
        self.assertTrue(sql.endswith(");"))
        self.assertEqual(sql.count("\n"), 400)
        self.assertIn('"first-name"', fake("sql 1 first-name:first")[0]["arg"])  # quoted identifier

    def test_large_output_goes_through_the_cache(self):
        it = fake("json 1000")[0]
        self.assertTrue(it["arg"].startswith("dtfile:" + CACHE + "/result-"))
        self.assertEqual(it["quicklookurl"], it["arg"][7:])
        r = subprocess.run(["/bin/bash", "./resolve.sh", it["arg"]], cwd=SRC, capture_output=True,
                           env=dict(os.environ, alfred_workflow_cache=CACHE))
        self.assertEqual(len(json.loads(r.stdout.decode("utf-8"))), 1000)


class SafetyTests(unittest.TestCase):
    def test_phone_numbers_are_reserved_for_fiction(self):
        for loc, pattern in RESERVED_PHONES.items():
            for p in lines(fake("phone 60", fake_locale=loc)[0]):
                self.assertRegex(p, pattern, loc)
            for p in lines(fake("phone-intl 20", fake_locale=loc)[0]):
                self.assertRegex(p, r"^\+\d")

    def test_cards_are_published_test_numbers(self):
        for n in lines(fake("card 200")[0]):
            self.assertIn(n, TEST_CARDS)
            self.assertTrue(luhn(n), n)
        it = fake("card amex")[0]
        self.assertIn("American Express", it["subtitle"])
        self.assertRegex(it["subtitle"], r"CVC \d{4} · published test number, not a real card")
        self.assertIn(fake("card visa")[0]["arg"], {"4242424242424242", "4000056655665556"})
        self.assertIn("\nExp ", fake("card-details")[0]["arg"])

    def test_ibans(self):
        lengths = {"de": 22, "gb": 22, "fr": 27, "nl": 18, "at": 20, "ch": 21, "be": 16, "es": 24}
        for cc, n in lengths.items():
            for iban in lines(fake(f"iban {cc} 30")[0]):
                self.assertTrue(iban.startswith(cc.upper()), iban)
                self.assertEqual(len(iban), n, iban)
                self.assertTrue(iban_ok(iban), iban)
                if cc == "fr":  # national RIB key
                    b, g, a, k = iban[4:9], iban[9:14], iban[14:25], iban[25:]
                    self.assertEqual((89 * int(b) + 15 * int(g) + 3 * int(a) + int(k)) % 97, 0, iban)
                if cc == "be":
                    self.assertEqual(int(iban[4:14]) % 97 or 97, int(iban[14:]), iban)
                if cc == "es":
                    def check(ds, w=(1, 2, 4, 8, 5, 10, 9, 7, 3, 6)):
                        d = 11 - sum(int(x) * y for x, y in zip(ds, w)) % 11
                        return 0 if d == 11 else 1 if d == 10 else d
                    self.assertEqual(int(iban[12]), check("00" + iban[4:12]), iban)
                    self.assertEqual(int(iban[13]), check(iban[14:]), iban)
        self.assertTrue(fake("iban", fake_locale="fr_FR")[0]["arg"].startswith("FR"))
        self.assertTrue(fake("iban germany")[0]["arg"].startswith("DE"))

    def test_network(self):
        import ipaddress
        it = fake("ip 200")
        for ip in lines(by_uid(it, "ipv4")):
            a = ipaddress.ip_address(ip)
            self.assertTrue(a.is_global, ip)
        for ip in lines(by_uid(it, "private-ip")):
            self.assertTrue(ipaddress.ip_address(ip).is_private, ip)
        for ip in lines(by_uid(it, "ipv6")):
            a = ipaddress.ip_address(ip)
            self.assertNotIn(a, ipaddress.ip_network("2001:db8::/32"))
            self.assertIn(a, ipaddress.ip_network("2000::/3"))
        for mac in lines(fake("mac 100")[0]):
            first = int(mac[:2], 16)
            self.assertEqual(first & 3, 2, mac)  # locally administered, unicast
        self.assertRegex(fake("url")[0]["arg"], r"^https://[a-z0-9.-]+\.[a-z.]+/")
        ua = fake("user agent")[0]["arg"]
        self.assertTrue(ua.startswith("Mozilla/5.0 ("), ua)

    def test_colour_rows_share_one_colour(self):
        it = fake("colour")
        r, g, b = (int(by_uid(it, "hex-colour")["arg"][i:i + 2], 16) for i in (1, 3, 5))
        self.assertEqual(by_uid(it, "rgb")["arg"], f"rgb({r}, {g}, {b})")
        self.assertRegex(by_uid(it, "hsl")["arg"], r"^hsl\(\d{1,3}, \d{1,3}%, \d{1,3}%\)$")
        self.assertIn(by_uid(it, "rgb")["arg"], by_uid(it, "hex-colour")["subtitle"])

    def test_dates(self):
        now = time.time()
        it = fake("date 50")
        for d in lines(by_uid(it, "date")):
            t = datetime.strptime(d, "%Y-%m-%d").timestamp()
            self.assertTrue(now - 5 * 366 * 86400 < t <= now + 86400, d)
        for d in lines(by_uid(fake("birthday 50"), "birthday")):
            age = (now - datetime.strptime(d, "%Y-%m-%d").timestamp()) / (365.25 * 86400)
            self.assertTrue(17.9 < age < 80.1, d)
        for d in lines(fake("datetime 20")[0]):
            t = datetime.strptime(d, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
            self.assertTrue(now - 2 * 366 * 86400 < t <= now, d)
        self.assertRegex(fake("unix")[0]["arg"], r"^\d{10}$")
        self.assertRegex(fake("time")[0]["arg"], r"^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$")

    def test_jwt_verifies_with_the_jwt_keyword(self):
        token = fake("jwt")[0]["arg"]
        it = sf("jwt", token + " secret")
        self.assertTrue(any(i["title"].startswith("✓ Signature verified (HS256)") for i in it), it)
        self.assertTrue(it[0]["title"].startswith("Valid · expires in"))

    def test_bidi_control_and_surrogates(self):
        it = fake("pick a\u202eb, c\u0007d, 😀")
        self.assertNotIn("\u202e", it[1]["title"])
        self.assertNotIn("\u0007", it[1]["title"])
        self.assertIn(it[0]["arg"], ("a\u202eb", "c\u0007d", "😀"))
        for raw in (b"pick \xed\xa0\xbd, x", b"pick \xff\xfe, y", b"json 1 \xed\xa0\xbd:name"):
            out = subprocess.run([b"osascript", b"-l", b"JavaScript", b"./devtoolbox.js", b"fake", raw], cwd=SRC,
                                 env=dict(os.environ, alfred_workflow_cache=CACHE), capture_output=True, timeout=30)
            self.assertEqual(out.returncode, 0, out.stderr)
            validate(json.loads(out.stdout.decode("utf-8")))


class LocaleTests(unittest.TestCase):
    def test_locales(self):
        de = fake("@de")
        self.assertRegex(by_uid(de, "address")["arg"], r"^.+ \d+\n\d{5} .+$")
        self.assertEqual(by_uid(de, "region")["subtitle"].split(" · ")[0], "State")
        self.assertRegex(by_uid(de, "price")["arg"], r"^\d+,\d\d €$")
        uk = fake("@uk address")[0]["arg"]
        self.assertRegex(uk.split("\n")[-1], r"^[A-Z]{1,2}\d \d[ABDEFGHJLNPQRSTUWXYZ]{2}$", uk)
        self.assertRegex(fake("@fr address")[0]["arg"].split("\n")[-1], r"^\d{5} ")
        self.assertRegex(fake("@au address")[0]["arg"].split("\n")[-1], r" (NSW|VIC|QLD|WA|SA|ACT|TAS|NT) \d{4}$")
        self.assertEqual(fake("@xx")[0]["title"], "Locale: @us, @uk, @au, @de or @fr")
        self.assertIn("Deutschland", fake("json 1 country", fake_locale="de_DE")[0]["arg"])
        # configuration values as Alfred passes them
        self.assertRegex(fake("address", fake_locale=" de_DE ")[0]["arg"], r"\n\d{5} ")
        self.assertRegex(fake("phone 5", fake_locale="bogus")[0]["arg"], r"555-01")
        self.assertRegex(fake("phone 5", fake_locale="")[0]["arg"], r"555-01")

    def test_umlauts_in_emails_and_usernames(self):
        emails = lines(fake("email 300", fake_locale="de_DE")[0]) + lines(fake("email 300", fake_locale="fr_FR")[0])
        for e in emails:
            self.assertRegex(e, r"^[a-z0-9._]+@example\.(com|net|org)$")

    def test_no_data_file_for_other_keywords(self):
        # the word lists are only read by the fake command, so other keywords don't pay for them
        with open(os.path.join(SRC, "devtoolbox.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertEqual(src.count("readJSONFile(\""), 1)


class RegenerateTests(unittest.TestCase):
    def test_alt_reopens_the_same_generator(self):
        self.assertEqual(fake("email 10")[0]["mods"]["alt"]["arg"], "email 10")
        self.assertEqual(by_uid(fake(), "password")["mods"]["alt"]["arg"], "password 20")
        self.assertEqual(by_uid(fake("5"), "password")["mods"]["alt"]["arg"], "password 20 5")
        self.assertEqual(by_uid(fake("5"), "email")["mods"]["alt"]["arg"], "email 5")
        self.assertEqual(fake("@de address")[0]["mods"]["alt"]["arg"], "@de address")
        self.assertEqual(fake("1-6 3")[0]["mods"]["alt"]["arg"], "1-6 3")
        self.assertEqual(fake("json 5 name,email")[0]["mods"]["alt"]["arg"], "json 5 name,email")
        self.assertEqual(by_uid(fake(), "json")["mods"]["alt"]["arg"], "json 3")
        # the regenerated query puts the same row first, so ↩ still copies it
        for q in ("email 10", "password 20 5", "@de address", "first-name", "json 3"):
            self.assertEqual(fake(q)[0]["mods"]["alt"]["arg"], q)

    def test_fake_again_action(self):
        def again(q, **env):
            e = dict(os.environ, DT_TEST_ALFRED_SEARCH="1", **env)
            return subprocess.run(["osascript", "-l", "JavaScript", "./devtoolbox.js", "fake-again", q], cwd=SRC, env=e,
                                  capture_output=True, text=True, timeout=30).stdout
        self.assertEqual(again("email 10"), "fake email 10 \n")
        self.assertEqual(again("email", keyword_fake=" fk "), "fk email \n")
        self.assertEqual(again("", keyword_fake=""), "fake \n")

    def test_dev_hub_rows_have_no_alt(self):
        it = sf("smart", "fake email 3")
        self.assertEqual(len(lines(it[0])), 3)
        self.assertNotIn("alt", it[0]["mods"])


class AuditOneTests(unittest.TestCase):
    """Logic audit: one test per bug."""

    def test_regenerate_keeps_brand_and_country(self):
        self.assertEqual(fake("card amex")[0]["mods"]["alt"]["arg"], "card amex")
        self.assertEqual(fake("iban nl 3")[0]["mods"]["alt"]["arg"], "iban nl 3")
        self.assertEqual(by_uid(fake(), "card")["mods"]["alt"]["arg"], "card")

    def test_card_details_match_the_card_row(self):
        it = fake("card")
        number = by_uid(it, "card")["arg"]
        details = by_uid(it, "card-details")["arg"].split("\n")
        self.assertEqual(details[1].replace(" ", ""), number)
        self.assertIn(f"exp {details[3][4:]}", by_uid(it, "card")["subtitle"])

    def test_punctuated_and_non_latin_words(self):
        self.assertEqual(fake("e-mail")[0]["uid"], "fake.email")
        self.assertEqual(fake("名前")[0]["title"], "No matching generator")
        self.assertEqual(fake("Ünicode")[0]["title"], "No matching generator")

    def test_blank_line_hint(self):
        self.assertIn("separated by blank lines", fake("address 2")[0]["subtitle"])
        self.assertIn("one per line", fake("email 2")[0]["subtitle"])

    def test_words_before_ranges_and_dice(self):
        self.assertEqual(fake("number 1-10")[0]["uid"], "fake.range")
        self.assertTrue(1 <= int(fake("random 1..10")[0]["arg"]) <= 10)
        self.assertEqual(fake("roll 2d6")[0]["uid"], "fake.dice-roll")
        self.assertEqual(fake("dice d20 3")[0]["uid"], "fake.dice-roll")
        self.assertEqual(fake("dice")[0]["uid"], "fake.dice")


class ResponseSizeTests(unittest.TestCase):
    def test_broad_filter_with_big_count_stays_small(self):
        out = subprocess.run(["osascript", "-l", "JavaScript", "./devtoolbox.js", "fake", "a 1000"], cwd=SRC,
                             env=dict(os.environ, alfred_workflow_cache=CACHE), capture_output=True, timeout=30)
        self.assertLess(len(out.stdout), 150000)
        it = json.loads(out.stdout)["items"]
        big = [i for i in it if i["arg"].startswith("dtfile:")]
        self.assertTrue(big)
        r = subprocess.run(["/bin/bash", "./resolve.sh", big[0]["arg"]], cwd=SRC, capture_output=True,
                           env=dict(os.environ, alfred_workflow_cache=CACHE))
        self.assertEqual(len(r.stdout.decode("utf-8").split("\n")), 1000)

    def test_secrets_never_go_through_the_cache(self):
        it = fake("password 256 100")
        for i in it:
            self.assertFalse(i["arg"].startswith("dtfile:"), i["uid"])
            self.assertEqual(len(i["arg"].split("\n")), 100)


class RuntimeTests(unittest.TestCase):
    def test_alfred_env_fresh_install(self):
        e, it = run_alfred_fake("")
        self.assertGreater(len(it), 40)
        e, it = run_alfred_fake("paragraphs 2")
        self.assertTrue(it[0]["quicklookurl"].startswith(e["alfred_workflow_cache"] + "/fake-preview-"))
        with open(it[0]["quicklookurl"], encoding="utf-8") as f:
            self.assertEqual(f.read(), it[0]["arg"])
        e, it = run_alfred_fake("@fr name 20")
        self.assertTrue(any(re.search(r"[éèëïçô]", n) for n in lines(it[0])) or len(lines(it[0])) == 20)

    def test_workflow_folder_with_spaces(self):
        # Alfred runs scripts from "…/Application Support/Alfred/Alfred.alfredpreferences/workflows/user.workflow.X"
        import shutil
        home = tempfile.mkdtemp(prefix="fake home ")
        wf = os.path.join(home, "Library", "Application Support", "Alfred", "Alfred.alfredpreferences", "workflows", "user.workflow.A B")
        shutil.copytree(SRC, wf)
        e = alfred_env(home, fake_locale=" fr_FR ", fake_transient="1", keyword_fake="")
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./devtoolbox.js", "fake", "address"], cwd=wf, env=e,
                             capture_output=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        it = json.loads(out.stdout.decode("utf-8"))["items"]
        self.assertRegex(it[0]["arg"], r"\n\d{5} ")
        r = subprocess.run(["/bin/bash", "./resolve.sh", "plain value"], cwd=wf, env=e, capture_output=True)
        self.assertEqual(r.stdout, b"plain value")

    def test_config_values_as_alfred_passes_them(self):
        for v, want in (("1", "1"), ("0", "2"), (" 0 ", "2"), ("", "1")):
            self.assertEqual(fake("pin", fake_transient=v)[0]["variables"]["fake_secret"], want, v)

    def test_random_fallbacks(self):
        for mode in ("urandom", "nsuuid"):
            it = fake("password 40 20", DT_TEST_RANDOM=mode)
            vals = lines(it[0])
            self.assertEqual(len(set(vals)), 20)
            self.assertTrue(all(len(v) == 40 for v in vals))
            self.assertEqual(len(set(lines(sf("uuid", "50 nano", DT_TEST_RANDOM=mode)[0]))), 50)

    def test_every_keystroke_is_fast(self):
        worst = 0
        for q in ("", "e", "em", "email", "email 1", "email 10", "@de", "json 5 name,email", "1-100", "3d6", "5",
                  "password 32", "lorem 50", "100"):
            t = time.time()
            fake(q)
            worst = max(worst, time.time() - t)
        self.assertLess(worst, 1.0)  # measured ~0.1 s; generous for a loaded machine

    def test_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        objs = {o["uid"]: o for o in p["objects"]}
        sf_fake = next(o for o in p["objects"] if o["config"].get("keyword") == "{var:keyword_fake}")
        conns = p["connections"][sf_fake["uid"]]
        mods = {c["modifiers"]: objs[c["destinationuid"]] for c in conns}
        self.assertEqual(set(mods), {0, 1048576, 524288})
        self.assertEqual(mods[0]["type"], "alfred.workflow.utility.conditional")
        self.assertEqual(mods[0]["config"]["conditions"][0]["inputstring"], "{var:fake_secret}")
        self.assertIn("fake-again", mods[524288]["config"]["script"])
        for cond, paste in ((mods[0], False), (mods[1048576], True)):
            out = p["connections"][cond["uid"]]
            secret = [c for c in out if c.get("sourceoutputuid") == cond["config"]["conditions"][0]["uid"]]
            other = [c for c in out if "sourceoutputuid" not in c]
            self.assertEqual(len(secret), 1)
            clip = objs[secret[0]["destinationuid"]]["config"]
            self.assertEqual((clip["transient"], clip["autopaste"]), (True, paste))
            self.assertIn("resolve.sh", objs[other[0]["destinationuid"]]["config"]["script"])
            # a password copied with the transient option off still never reaches resolve.sh's argv
            plain = [c for c in out if c.get("sourceoutputuid") == cond["config"]["conditions"][1]["uid"]]
            self.assertEqual(cond["config"]["conditions"][1]["matchstring"], "2")
            clip = objs[plain[0]["destinationuid"]]
            self.assertEqual(clip["type"], "alfred.workflow.output.clipboard")
            self.assertEqual((clip["config"]["transient"], clip["config"]["autopaste"]), (False, paste))
        vars_ = {c["variable"]: c for c in p["userconfigurationconfig"]}
        self.assertEqual(vars_["keyword_fake"]["config"]["default"], "fake")
        self.assertEqual(vars_["fake_locale"]["config"]["default"], "en_US")
        self.assertIs(vars_["fake_transient"]["config"]["default"], True)
        self.assertEqual(p["version"], "1.2.0")

    def test_package_contains_the_word_lists(self):
        import zipfile
        subprocess.run([sys.executable, "tools/build.py", "--package"], cwd=ROOT, check=True, capture_output=True)
        with zipfile.ZipFile(os.path.join(ROOT, "dist", "alfred-devtoolbox-1.2.0.alfredworkflow")) as z:
            names = z.namelist()
        for n in ("fake/common.json", "fake/en_US.json", "fake/en_GB.json", "fake/en_AU.json", "fake/de_DE.json",
                  "fake/fr_FR.json", "icons/fake.png", "devtoolbox.js", "info.plist"):
            self.assertIn(n, names)
        self.assertFalse([n for n in names if n.startswith(("tests", "tools", "images")) or "prefs.plist" in n])


if __name__ == "__main__":
    unittest.main(verbosity=1)
