"""Customer and job names here are invented; real ones stay out of the repo."""

import tempfile
import unittest
from pathlib import Path

from inventory import crawler, db
from mining import jobs, names


class ParseTest(unittest.TestCase):
    def test_delimited_job(self) -> None:
        job = names.parse("1151_Acme Electric_FK0555 Widget Assembly Machine")
        self.assertEqual(
            (job.kind, job.number, job.customer, job.customer_source, job.description),
            ("job", 1151, "Acme Electric", "delimited", "FK0555 Widget Assembly Machine"),
        )

    def test_delimiter_variants(self) -> None:
        self.assertEqual(names.parse("1081__Acme_Light Soak Chamber").customer, "Acme")
        spaced = names.parse("1059 _Acme_Bias Cart x 2")
        self.assertEqual((spaced.number, spaced.customer, spaced.quantity), (1059, "Acme", 2))
        mixed = names.parse("512 Acme_2012 T-M Spares")
        self.assertEqual((mixed.customer, mixed.description), ("Acme", "2012 T-M Spares"))

    def test_older_style_leaves_customer_for_later(self) -> None:
        job = names.parse("430 Globex Drive Mtr Upgd (x2)")
        self.assertEqual((job.kind, job.number, job.customer, job.quantity), ("job", 430, None, 2))
        self.assertEqual(job.description, "Globex Drive Mtr Upgd (x2)")

    def test_quantities(self) -> None:
        self.assertEqual(names.parse("1101_Acme_Coil Stacker QTY (8)").quantity, 8)
        self.assertEqual(names.parse("1176_Acme_Bubbler (Qty 2)").quantity, 2)
        self.assertIsNone(names.parse("1160_Acme_Y-Site Assembly Machine").quantity)

    def test_kinds_that_are_not_jobs(self) -> None:
        self.assertEqual(names.parse("2024_Spares").kind, "bucket")
        self.assertEqual(names.parse("2026 Parts Cost").kind, "bucket")
        self.assertEqual(names.parse("XXXX_CUSTOMER_XXXXXXX (TEMPLATE)").kind, "template")
        self.assertEqual(names.parse("WATER JET JOBS").kind, "other")
        self.assertEqual(names.parse("_MECHANICAL LIBRARY").kind, "other")
        self.assertEqual(names.parse("10005_Project Schedules").kind, "other")
        self.assertEqual(names.parse("3-CREDIT CARD RECEIPTS").kind, "other")

    def test_placeholders(self) -> None:
        unnumbered = names.parse("XXXX_Acme_Top Coil Assembly")
        self.assertEqual((unnumbered.kind, unnumbered.number, unnumbered.customer), ("placeholder", None, "Acme"))
        struck = names.parse("xxx1098_Acme_ S7 Wet Hi-Pot")
        self.assertEqual((struck.kind, struck.number, struck.description), ("placeholder", 1098, "S7 Wet Hi-Pot"))

    def test_bare_number(self) -> None:
        job = names.parse("3721")
        self.assertEqual((job.kind, job.number, job.description), ("job", 3721, ""))


class ResolveTest(unittest.TestCase):
    def resolve(self, *folder_names: str) -> dict[str, names.JobName]:
        parsed = [names.parse(n) for n in folder_names]
        names.resolve_customers(parsed)
        return {j.raw: j for j in parsed}

    def test_known_customer_is_recognised_without_a_delimiter(self) -> None:
        got = self.resolve(
            "1050_Acme Solar_Wet Hi-Pot",
            "377 ACME SOLAR Impact Tester",
            "1145_Acme Solar, Load Automation",
            "458 Acme Solar-PBG EdgePinch Mods",
            "700 Acme Solaris Thing One",
        )
        for raw, description in (
            ("377 ACME SOLAR Impact Tester", "Impact Tester"),
            ("1145_Acme Solar, Load Automation", "Load Automation"),
            ("458 Acme Solar-PBG EdgePinch Mods", "PBG EdgePinch Mods"),
        ):
            self.assertEqual((got[raw].customer, got[raw].customer_source), ("Acme Solar", "known"), raw)
            self.assertEqual(got[raw].description, description)
        # A longer word that merely starts the same is a different name.
        self.assertIsNone(got["700 Acme Solaris Thing One"].customer)

    def test_recurring_leading_words_are_inferred(self) -> None:
        got = self.resolve(
            "472 Globex Large Burner Stand",
            "634 Globex Rod Loader Improvements",
            "698 Globex Gen II Sifter",
            "444 OEM Initech Burst Tester Upgd",
            "549 OEM Initech S-12 Upgrade",
            "598 OEM Initech Alliance Spinwelder",
            "609 Umbrella EtherNet Remote Module",
        )
        self.assertEqual(got["472 Globex Large Burner Stand"].customer, "Globex")
        self.assertEqual(got["472 Globex Large Burner Stand"].customer_source, "inferred")
        self.assertEqual(got["472 Globex Large Burner Stand"].description, "Large Burner Stand")
        self.assertEqual(got["549 OEM Initech S-12 Upgrade"].customer, "OEM Initech")
        self.assertEqual(got["549 OEM Initech S-12 Upgrade"].description, "S-12 Upgrade")
        # Seen once: not enough to call it a customer.
        self.assertIsNone(got["609 Umbrella EtherNet Remote Module"].customer)

    def test_description_terms_span_job_numbers(self) -> None:
        parsed = [
            names.parse(n)
            for n in ("430_Acme_Drive Upgd", "500_Acme_HIPOT Replication", "900_Globex_Hipot Replication Mchn")
        ]
        terms = {t["term"].lower(): t for t in names.description_terms(parsed)}
        self.assertEqual((terms["replication"]["jobs"], terms["replication"]["first_job"]), (2, 500))
        self.assertEqual(terms["replication"]["last_job"], 900)
        self.assertEqual(terms["hipot replication"]["jobs"], 2)
        self.assertEqual(terms["upgd"]["jobs"], 1)

    def test_filler_words_are_not_terms(self) -> None:
        parsed = [names.parse("941_Acme_Data Collection for Assembly and Tester")]
        terms = {t["term"].lower() for t in names.description_terms(parsed)}
        self.assertIn("data collection", terms)
        self.assertFalse({"for", "and", "collection for", "and tester"} & terms)


class AnalyseTest(unittest.TestCase):
    def test_rollup_from_a_crawled_tree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "Job Folder"
            for folder, sub, filename, size in (
                ("1151_Acme_Widget Machine", "1151 Mechanical", "part.sldprt", 100),
                ("1151_Acme_Widget Machine", "1151 Mechanical", "asm.sldasm", 300),
                ("1151_Acme_Widget Machine", "1151 Electrical", "panel.pdf", 50),
                ("1160_ACME_Feeder", "1160 Mechanical", "part.sldprt", 10),
                ("900 Acme Old Style Job", "Mechanical", "old.dwg", 5),
                ("XXXX_CUSTOMER_XXXXXXX (TEMPLATE)", "XXXX Mechanical", "readme.txt", 1),
                ("WATER JET JOBS", "misc", "cut.dxf", 7),
            ):
                target = base / folder / sub
                target.mkdir(parents=True, exist_ok=True)
                (target / filename).write_bytes(b"x" * size)

            conn = db.connect(":memory:")
            self.addCleanup(conn.close)
            crawler.crawl(conn, str(base))
            result = jobs.analyse(conn)

            by_folder = {j["folder"]: j for j in result["jobs"]}
            widget = by_folder["1151_Acme_Widget Machine"]
            self.assertEqual((widget["number"], widget["customer"], widget["files"]), (1151, "Acme", 3))
            self.assertEqual(widget["subfolders"], 2)
            self.assertEqual(by_folder["900 Acme Old Style Job"]["customer_source"], "known")
            self.assertEqual(by_folder["WATER JET JOBS"]["kind"], "other")
            self.assertEqual([j["number"] for j in result["jobs"][:3]], [900, 1151, 1160])

            self.assertEqual(len(result["customers"]), 1)
            acme = result["customers"][0]
            self.assertEqual((acme["customer"], acme["folders"]), ("Acme", 3))
            self.assertEqual((acme["first_job"], acme["last_job"]), (900, 1160))
            self.assertEqual(acme["other_spellings"], "ACME")

            folders = {f["folder"]: f for f in result["folders"]}
            self.assertEqual(folders["Mechanical"]["jobs"], 3)  # template and non-jobs not counted
            self.assertEqual(folders["Electrical"]["jobs"], 1)

            written = jobs.write_reports(result, Path(tmp) / "reports")
            self.assertEqual(len(written), 4)
            self.assertIn("1151_Acme_Widget Machine", (Path(tmp) / "reports" / "jobs.csv").read_text("utf-8-sig"))

    def test_folder_label(self) -> None:
        self.assertEqual(jobs.folder_label("1151 Mechanical"), "Mechanical")
        self.assertEqual(jobs.folder_label("XXXX Documents"), "Documents")
        self.assertEqual(jobs.folder_label("Electrical POs and Quotes"), "Electrical POs and Quotes")
        self.assertEqual(jobs.folder_label("1151"), "1151")


if __name__ == "__main__":
    unittest.main()
