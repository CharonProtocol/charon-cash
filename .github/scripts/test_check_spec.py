import contextlib
import copy
import io
import json
from pathlib import Path
import runpy
import unittest


SCRIPT_DIR = Path(__file__).parent
validate = runpy.run_path(str(SCRIPT_DIR / "check-spec.py"))["validate"]


class SpecGateTests(unittest.TestCase):
    def setUp(self):
        self.baseline = json.loads(
            (SCRIPT_DIR / "qedgen-warning-baseline.json").read_text()
        )

    def check(self, findings, returncode):
        with contextlib.redirect_stdout(io.StringIO()):
            return validate(findings, returncode)

    def test_existing_warnings_are_accepted(self):
        self.assertTrue(self.check(self.baseline, 1))

    def test_resolving_warnings_is_accepted(self):
        self.assertTrue(self.check(self.baseline[:1], 1))
        self.assertTrue(self.check([], 0))

    def test_new_or_changed_warnings_are_rejected(self):
        for field, value in (
            ("rule", "new_rule"),
            ("subject", "new_handler"),
            ("message", "A different problem"),
            ("priority", 0),
        ):
            with self.subTest(field=field):
                findings = copy.deepcopy(self.baseline)
                findings[0][field] = value
                self.assertFalse(self.check(findings, 1))

    def test_error_is_rejected_even_if_tool_exits_zero(self):
        findings = copy.deepcopy(self.baseline)
        findings[0]["severity"] = "error"
        self.assertFalse(self.check(findings, 0))

    def test_unknown_severity_is_rejected(self):
        findings = copy.deepcopy(self.baseline)
        findings[0]["severity"] = "critical"
        self.assertFalse(self.check(findings, 0))

    def test_tool_failure_cannot_be_masked_by_known_warnings(self):
        for status in (-9, 2, 101):
            with self.subTest(status=status):
                self.assertFalse(self.check(self.baseline, status))
        self.assertFalse(self.check([], 1))

    def test_malformed_diagnostics_fail_closed(self):
        for findings in ({}, None, [{}], [None]):
            with self.subTest(findings=findings):
                with self.assertRaises((ValueError, KeyError, TypeError)):
                    self.check(findings, 0)


if __name__ == "__main__":
    unittest.main()
