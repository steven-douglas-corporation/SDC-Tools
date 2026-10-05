"""Tests for the parts of paylocity_ingest that don't need SFTP or SQL.

    python -m unittest discover -s tools/data-warehouse/ingest
"""
import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

import openpyxl

from paylocity_ingest import header_names, read_workbook, remote_folder, report_key, sheet_rows


class ReportKeyTest(unittest.TestCase):
    def test_strips_paylocity_version_stamp(self):
        self.assertEqual(report_key("Employee_Information_10-04-26_05-00-54.xlsx"), "employee_information")
        self.assertEqual(report_key("Employee_Information.xlsx"), "employee_information")

    def test_strips_run_time_suffix(self):
        self.assertEqual(report_key("TEMP_LABOR_230038.xls"), "temp_labor")

    def test_keeps_years_and_dates_that_are_part_of_the_name(self):
        self.assertEqual(report_key("Job_Hours_2025.xlsx"), "job_hours_2025")
        self.assertEqual(report_key("Hours Through 20250131.xlsx"), "hours_through_20250131")

    def test_spaces_and_repeated_underscores(self):
        self.assertEqual(report_key("Temp Employees Listing _10-01-26_05-05-40.PDF"), "temp_employees_listing")
        self.assertEqual(report_key("Paid_Expenses___DSB_09-30-26_05-01-09.xlsx"), "paid_expenses_dsb")

    def test_remote_folder(self):
        self.assertEqual(remote_folder("/employees/Employee_Information.xlsx"), Path("employees"))
        self.assertEqual(remote_folder("/Paid_Expenses___DSB.xlsx"), Path("."))


class SheetRowsTest(unittest.TestCase):
    def test_blank_and_duplicate_headers_get_unique_names(self):
        self.assertEqual(header_names(["Job#", None, "ME", "ME", ""]), ["Job#", "column_2", "ME", "ME_2", "column_5"])

    def test_data_rows_are_objects_keyed_by_header(self):
        rows = [("Employee Id", "Work Date", "Hours"),
                ("0114", dt.datetime(2026, 3, 11), 2.5),
                ("0115", None, 4)]
        out = list(sheet_rows(rows))
        self.assertEqual([(n, kind) for n, kind, _ in out], [(1, "header"), (2, "data"), (3, "data")])
        self.assertEqual(json.loads(out[0][2]), ["Employee Id", "Work Date", "Hours"])
        self.assertEqual(json.loads(out[1][2]), {"Employee Id": "0114", "Work Date": "2026-03-11T00:00:00", "Hours": 2.5})
        self.assertEqual(json.loads(out[2][2]), {"Employee Id": "0115", "Hours": 4})  # blank cell left out

    def test_rows_above_the_header_are_kept_as_preamble(self):
        rows = [("Steven Douglas Corp", None), (None, None), ("Name", "Hours"), ("A", 1)]
        out = list(sheet_rows(rows, header_row=3))
        self.assertEqual([(n, kind) for n, kind, _ in out], [(1, "preamble"), (3, "header"), (4, "data")])
        self.assertEqual(json.loads(out[0][2]), ["Steven Douglas Corp"])  # trailing blanks trimmed

    def test_cells_past_the_header_get_positional_names(self):
        out = list(sheet_rows([("A",), (1, 2)]))
        self.assertEqual(json.loads(out[1][2]), {"A": 1, "column_2": 2})


class ReadWorkbookTest(unittest.TestCase):
    def test_reads_every_sheet_of_an_xlsx(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "Report.xlsx"
            book = openpyxl.Workbook()
            book.active.title = "Report"
            book.active.append(["Job ID", "Job Title"])
            book.active.append(["4508931", "Industrial Electrician"])
            book.create_sheet("Old").append(["Job#"])
            book.save(path)

            sheets = {name: list(sheet_rows(rows)) for name, rows in read_workbook(path)}

        self.assertEqual(list(sheets), ["Report", "Old"])
        self.assertEqual(json.loads(sheets["Report"][1][2]), {"Job ID": "4508931", "Job Title": "Industrial Electrician"})


if __name__ == "__main__":
    unittest.main()
