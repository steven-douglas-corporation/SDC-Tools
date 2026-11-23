import os
import tempfile
import unittest
from pathlib import Path

from inventory import crawler, db


def make_tree(base: Path) -> None:
    (base / "1151_Acme_Machine" / "Mechanical").mkdir(parents=True)
    (base / "1151_Acme_Machine" / "Documents").mkdir()
    (base / "Empty").mkdir()
    (base / "top.txt").write_text("hello")
    (base / "1151_Acme_Machine" / "Mechanical" / "part.SLDPRT").write_bytes(b"x" * 100)
    (base / "1151_Acme_Machine" / "Mechanical" / "drawing.SLDDRW").write_bytes(b"x" * 50)
    (base / "1151_Acme_Machine" / "Documents" / "scope.docx").write_bytes(b"x" * 10)
    (base / "1151_Acme_Machine" / "README").write_text("no extension")


class CrawlTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name) / "share"
        self.base.mkdir()
        make_tree(self.base)
        self.conn = db.connect(":memory:")
        self.addCleanup(self.conn.close)
        self.root = crawler.normalize_root(str(self.base))

    def statuses(self) -> dict[str, int]:
        return {
            r["status"]: r["n"]
            for r in self.conn.execute("SELECT status, COUNT(*) AS n FROM dir GROUP BY status")
        }

    def file_names(self) -> set[str]:
        return {r["name"] for r in self.conn.execute("SELECT name FROM file")}

    def test_full_crawl_records_every_dir_and_file(self) -> None:
        stats = crawler.crawl(self.conn, str(self.base), workers=2)

        self.assertIsNone(stats.stopped)
        self.assertEqual(stats.dirs_done, 5)  # root + 4
        self.assertEqual(stats.files, 5)
        self.assertEqual(self.statuses(), {"done": 5})
        self.assertEqual(
            self.file_names(), {"top.txt", "part.SLDPRT", "drawing.SLDDRW", "scope.docx", "README"}
        )

        part = self.conn.execute(
            "SELECT f.ext, f.size, f.mtime, d.path, d.depth FROM file f "
            "JOIN dir d ON d.id = f.dir_id WHERE f.name = 'part.SLDPRT'"
        ).fetchone()
        self.assertEqual(part["ext"], ".sldprt")
        self.assertEqual(part["size"], 100)
        self.assertEqual(part["depth"], 2)
        self.assertEqual(part["path"], os.path.join(self.root, "1151_Acme_Machine", "Mechanical"))
        on_disk = os.stat(self.base / "1151_Acme_Machine" / "Mechanical" / "part.SLDPRT")
        self.assertEqual(part["mtime"], int(on_disk.st_mtime))

        readme = self.conn.execute("SELECT ext FROM file WHERE name = 'README'").fetchone()
        self.assertEqual(readme["ext"], "")

    def test_limit_then_resume_finishes_without_duplicates(self) -> None:
        first = crawler.crawl(self.conn, str(self.base), workers=1, limit_dirs=2)
        self.assertEqual(first.stopped, "directory limit reached")
        self.assertEqual(first.dirs_done, 2)
        self.assertGreater(self.statuses().get("pending", 0), 0)

        second = crawler.crawl(self.conn, str(self.base), workers=1)
        self.assertIsNone(second.stopped)
        self.assertEqual(first.dirs_done + second.dirs_done, 5)
        self.assertEqual(self.statuses(), {"done": 5})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM file").fetchone()[0], 5)

    def test_second_run_with_nothing_queued_does_nothing(self) -> None:
        crawler.crawl(self.conn, str(self.base))
        again = crawler.crawl(self.conn, str(self.base))
        self.assertEqual(again.dirs_done, 0)
        self.assertIsNone(again.stopped)

    def test_rescan_picks_up_added_and_removed_files(self) -> None:
        crawler.crawl(self.conn, str(self.base))
        (self.base / "top.txt").unlink()
        (self.base / "Empty" / "new.pdf").write_bytes(b"x")

        crawler.crawl(self.conn, str(self.base), rescan=True)

        names = self.file_names()
        self.assertNotIn("top.txt", names)
        self.assertIn("new.pdf", names)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM file").fetchone()[0], 5)
        self.assertEqual(self.statuses(), {"done": 5})

    def test_access_denied_is_recorded_and_crawl_continues(self) -> None:
        def scan(path: str) -> crawler.Listing:
            if path.endswith("Documents"):
                raise PermissionError(13, "Access is denied")
            return crawler.scan_dir(path)

        stats = crawler.crawl(self.conn, str(self.base), scan=scan)

        self.assertEqual(stats.denied, 1)
        self.assertEqual(self.statuses(), {"done": 4, "denied": 1})
        row = self.conn.execute("SELECT path, error FROM dir WHERE status = 'denied'").fetchone()
        self.assertTrue(row["path"].endswith("Documents"))
        self.assertIn("PermissionError", row["error"])
        self.assertNotIn("scope.docx", self.file_names())

    def test_network_outage_leaves_work_queued_then_recovers(self) -> None:
        state = {"down": False, "failures": 0, "sleeps": 0}

        def scan(path: str) -> crawler.Listing:
            if path.endswith("Mechanical") and state["failures"] == 0:
                state["failures"] += 1
                state["down"] = True
                raise OSError(64, "The specified network name is no longer available")
            return crawler.scan_dir(path)

        def sleep(_seconds: float) -> None:
            state["sleeps"] += 1
            if state["sleeps"] >= 2:
                state["down"] = False

        stats = crawler.crawl(
            self.conn,
            str(self.base),
            workers=1,
            scan=scan,
            reachable=lambda: not state["down"],
            sleep=sleep,
        )

        self.assertIsNone(stats.stopped)
        self.assertEqual(stats.outages, 1)
        self.assertEqual(state["sleeps"], 2)
        self.assertEqual(stats.errors, 0)
        self.assertEqual(self.statuses(), {"done": 5})
        self.assertIn("part.SLDPRT", self.file_names())

    def test_outage_longer_than_the_limit_stops_and_can_resume(self) -> None:
        down = {"value": False}

        def scan(path: str) -> crawler.Listing:
            if path != self.root:
                down["value"] = True
                raise OSError(64, "The specified network name is no longer available")
            return crawler.scan_dir(path)

        stats = crawler.crawl(
            self.conn,
            str(self.base),
            scan=scan,
            reachable=lambda: not down["value"],
            sleep=lambda _s: None,
            max_outage_seconds=30,
            outage_poll_seconds=15,
        )
        self.assertEqual(stats.stopped, "network outage")
        self.assertEqual(self.statuses().get("error"), None)
        self.assertGreater(self.statuses()["pending"], 0)

        resumed = crawler.crawl(self.conn, str(self.base))
        self.assertIsNone(resumed.stopped)
        self.assertEqual(self.statuses(), {"done": 5})

    def test_error_while_reachable_is_retried_once_then_kept(self) -> None:
        calls = {"n": 0}

        def scan(path: str) -> crawler.Listing:
            if path.endswith("Empty"):
                calls["n"] += 1
                raise OSError(5, "Input/output error")
            return crawler.scan_dir(path)

        stats = crawler.crawl(self.conn, str(self.base), scan=scan, reachable=lambda: True)

        self.assertIsNone(stats.stopped)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(self.statuses(), {"done": 4, "error": 1})

    def test_removed_directory_is_marked_missing(self) -> None:
        crawler.crawl(self.conn, str(self.base))
        (self.base / "Empty").rmdir()

        crawler.crawl(self.conn, str(self.base), rescan=True)

        self.assertEqual(self.statuses(), {"done": 4, "missing": 1})

    def test_directory_links_are_recorded_but_not_followed(self) -> None:
        target, link = self.base / "1151_Acme_Machine", self.base / "Link"
        if crawler.IS_WINDOWS:
            # A junction needs no special privilege, unlike a symlink.
            import subprocess

            made = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True
            )
            if made.returncode != 0:
                self.skipTest("could not create a junction")
        else:
            os.symlink(target, link, target_is_directory=True)

        crawler.crawl(self.conn, str(self.base))

        if crawler.IS_WINDOWS:
            row = self.conn.execute("SELECT status FROM dir WHERE name = 'Link'").fetchone()
            self.assertEqual(row["status"], "skipped")
        # Either way the link's contents are not counted a second time.
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM file WHERE name = 'part.SLDPRT'").fetchone()[0], 1
        )


class PathTest(unittest.TestCase):
    @unittest.skipUnless(crawler.IS_WINDOWS, "Windows path forms")
    def test_extended_paths(self) -> None:
        self.assertEqual(crawler.extended(r"\\server\share\a"), r"\\?\UNC\server\share\a")
        self.assertEqual(crawler.extended(r"C:\a\b"), r"\\?\C:\a\b")
        self.assertEqual(crawler.extended(r"\\?\C:\a"), r"\\?\C:\a")

    @unittest.skipUnless(crawler.IS_WINDOWS, "Windows long paths")
    def test_paths_longer_than_260_characters_are_crawled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            deep = crawler.extended(os.path.join(tmp, *["d" * 60] * 6))
            os.makedirs(deep)
            with open(deep + "\\leaf.txt", "w") as f:
                f.write("x")
            conn = db.connect(":memory:")
            try:
                stats = crawler.crawl(conn, tmp)
                self.assertIsNone(stats.stopped)
                self.assertEqual(stats.files, 1)
                longest = conn.execute("SELECT MAX(LENGTH(path)) FROM dir").fetchone()[0]
                self.assertGreater(longest, 260)
            finally:
                conn.close()
                # TemporaryDirectory cannot remove over-long paths itself.
                import shutil

                shutil.rmtree(crawler.extended(tmp), ignore_errors=True)
                os.makedirs(tmp, exist_ok=True)


if __name__ == "__main__":
    unittest.main()
