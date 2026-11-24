"""Names here are invented; real ones stay out of the repo."""

import tempfile
import unittest
from pathlib import Path

from findings import acl, scan
from findings.rules import RULES
from inventory import crawler, db


def matching_rules(name: str, *, folder: bool = False) -> set[str]:
    return {r.id for r in RULES if not (folder and r.files_only) and r.pattern.search(name)}


class RuleTest(unittest.TestCase):
    def test_names_that_should_match(self) -> None:
        for name, rule in (
            ("Passwords.xlsx", "password-in-name"),
            ("server_credentials.txt", "password-in-name"),
            ("vault.kdbx", "password-store"),
            ("id_rsa", "private-key"),
            ("site.pfx", "private-key"),
            (".env.production", "config-with-secrets"),
            ("payroll_2024.xlsx", "payroll"),
            ("Paystub March.pdf", "payroll"),
            ("Salaries2023.xlsx", "payroll"),
            ("Jane SSN card.jpg", "government-id"),
            ("drivers license scan.pdf", "government-id"),
            ("W-2 2023.pdf", "tax-form"),
            ("Form 1099.pdf", "tax-form"),
            ("1099-MISC vendor.pdf", "tax-form"),
            ("I-9 Jane.pdf", "tax-form"),
            ("Resume - J Doe.docx", "hr-document"),
            ("Offer Letter.docx", "hr-document"),
            ("3-CREDIT CARD RECEIPTS", "payment-card"),
            ("Bank Statement Jan.pdf", "bank-details"),
            ("voided_check.pdf", "bank-details"),
            ("2022 Tax Return.pdf", "tax-return"),
            ("company.qbw", "company-books"),
            ("Acme NDA signed.pdf", "nda"),
            ("Mutual Non-Disclosure.docx", "nda"),
            ("archive.pst", "mailbox"),
            ("db_backup_2024.sql", "database-backup"),
            ("Invoice 4471.pdf", "invoices-receipts"),
        ):
            self.assertIn(rule, matching_rules(name), name)

    def test_shop_words_that_must_not_match(self) -> None:
        for name in (
            "1099_Acme_Rinse Dry",  # a job number
            "W2 Weldment.sldprt",  # a part
            "Wire Termination Chart.pdf",
            "24 HR Soak Test.xlsx",
            "CV Joint Assy.sldasm",
            "Temperature Compensation.docx",
            "Agenda.docx",  # contains "nda"
            "Lessons Learned.docx",  # contains "ssn"
            "Secretary Desk Layout.dwg",  # contains "secret"
            "BLH5K-1 Driver Instructions.pdf",  # a part number, not a tax schedule
            "Hi-Pot Re-Wire Instructions.pdf",
            "8-CVV-2 Lube Station.pdf",
            "drawing.bak",
            "Private Label Carton.pdf",
        ):
            self.assertEqual(matching_rules(name), set(), name)

    def test_extension_rules_do_not_apply_to_folders(self) -> None:
        self.assertEqual(matching_rules("mail.pst", folder=True), set())
        self.assertIn("payroll", matching_rules("Payroll", folder=True))


class ScanTest(unittest.TestCase):
    def build(self, files: list[str], root_name: str = "Share") -> list[dict]:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name) / root_name
        for relative in files:
            target = base / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"x" * 10)
        conn = db.connect(":memory:")
        self.addCleanup(conn.close)
        crawler.crawl(conn, str(base))
        return scan.scan(conn)

    def test_flagged_folder_covers_everything_beneath_it(self) -> None:
        found = self.build(
            [
                "Admin/Payroll/2024/payroll_jan.xlsx",
                "Admin/Payroll/2024/Salaries.xlsx",
                "Admin/Payroll/Payroll Archive/old.xlsx",
            ]
        )
        self.assertEqual([(f["rule"], f["kind"]) for f in found], [("payroll", "folder")])
        self.assertTrue(found[0]["path"].endswith("Payroll"))
        self.assertEqual(found[0]["files"], 3)
        self.assertEqual(found[0]["share"], "Share")

    def test_a_different_category_inside_a_flagged_folder_is_still_reported(self) -> None:
        found = self.build(["Payroll/passwords.txt", "Payroll/stubs.pdf"])
        self.assertEqual({(f["rule"], f["kind"]) for f in found}, {("payroll", "folder"), ("password-in-name", "files")})

    def test_files_are_grouped_by_folder(self) -> None:
        found = self.build(["Jobs/A/Invoice 1.pdf", "Jobs/A/Invoice 2.pdf", "Jobs/B/Invoice 3.pdf"])
        self.assertEqual(sorted(f["files"] for f in found), [1, 2])
        self.assertEqual({f["rule"] for f in found}, {"invoices-receipts"})
        self.assertTrue(all(f["example"].startswith("Invoice") for f in found))

    def test_vendored_and_source_files_are_skipped(self) -> None:
        found = self.build(
            [
                "app/node_modules/pkg/password.txt",
                "app/node_modules/pkg/test-cert.pem",
                "app/src/PasswordInput.tsx",
                "app/src/password-notes.txt",
                "app/deploy/server.pem",
            ]
        )
        self.assertEqual(
            {(f["rule"], f["example"]) for f in found},
            {("password-in-name", "password-notes.txt"), ("private-key", "server.pem")},
        )

    def test_cad_models_are_not_documents(self) -> None:
        found = self.build(["parts/Wire Transfer Actuator.sldasm", "parts/Pulley W-2.sldprt", "parts/SSN Bracket.dwg"])
        self.assertEqual(found, [])

    def test_most_severe_first(self) -> None:
        found = self.build(["a/Invoice.pdf", "b/Acme NDA.pdf", "c/passwords.txt"])
        self.assertEqual([f["severity"] for f in found], ["high", "medium", "low"])

    def test_readable_personal_folders(self) -> None:
        found = self.build(["Jane Doe/notes.txt", "John Roe/cad/part.sldprt"], root_name="Users")
        self.assertEqual([(f["rule"], f["kind"]) for f in found], [("readable-personal-folder", "personal folder")] * 2)
        self.assertEqual({Path(f["path"]).name for f in found}, {"Jane Doe", "John Roe"})
        # The same tree under an ordinary share name is not flagged.
        self.assertEqual(self.build(["Jane Doe/notes.txt"], root_name="Projects"), [])

    def test_report_is_written(self) -> None:
        found = self.build(["c/passwords.txt"])
        with tempfile.TemporaryDirectory() as tmp:
            path = scan.write_report(found, Path(tmp) / "out" / "findings.csv")
            text = path.read_text("utf-8-sig")
            self.assertIn("password-in-name", text)
            self.assertTrue(text.startswith("severity,category,rule,share,kind,path"))


class AclTest(unittest.TestCase):
    PATH = r"\\server\share\Admin"
    OUTPUT = (
        r"\\server\share\Admin BUILTIN\Administrators:(OI)(CI)(F)" "\n"
        r"                     EXAMPLE\Domain Users:(OI)(CI)(RX)" "\n"
        r"                     EXAMPLE\jdoe:(OI)(CI)(M)" "\n"
        r"                     EXAMPLE\Contractors:(OI)(CI)(DENY)(RX)" "\n"
        r"                     EXAMPLE\Writers:(OI)(CI)(W)" "\n"
        r"                     CREATOR OWNER:(OI)(CI)(IO)(F)" "\n"
        "\n"
        "Successfully processed 1 files; Failed processing 0 files\n"
    )

    def test_parse_keeps_only_entries_that_grant_read(self) -> None:
        entries = acl.parse_icacls(self.OUTPUT, self.PATH)
        self.assertEqual(
            entries,
            [
                (r"BUILTIN\Administrators", "F"),
                (r"EXAMPLE\Domain Users", "RX"),
                (r"EXAMPLE\jdoe", "M"),
                ("CREATOR OWNER", "F"),
            ],
        )
        self.assertEqual(acl.broad_principals(entries), [r"EXAMPLE\Domain Users"])

    def test_annotate_reads_each_folder_once_and_respects_the_limit(self) -> None:
        calls = []

        def read(path: str):
            calls.append(path)
            return None if path == "bad" else [(r"EXAMPLE\Domain Users", "RX")]

        findings = [{"path": p, "who_can_read": "", "broad_access": ""} for p in ("a", "a", "bad", "c", "d")]
        ok, failed = acl.annotate(findings, limit=3, read=read)

        self.assertEqual(calls, ["a", "bad", "c"])
        self.assertEqual((ok, failed), (2, 1))
        self.assertEqual(findings[1]["broad_access"], r"EXAMPLE\Domain Users")
        self.assertEqual(findings[2]["who_can_read"], "(could not read permissions)")
        self.assertEqual(findings[4]["who_can_read"], "")  # past the limit, left blank


if __name__ == "__main__":
    unittest.main()
