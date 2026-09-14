import json
from pathlib import Path
import runpy
import unittest


SCRIPT_DIR = Path(__file__).parent
PROGRAM = SCRIPT_DIR.parents[1] / "programs" / "privacy-cash"
checker = runpy.run_path(str(SCRIPT_DIR / "check-verifying-key.py"))


class VerifyingKeyGateTests(unittest.TestCase):
    def setUp(self):
        self.source = (PROGRAM / "src/utils.rs").read_text()
        vk = json.loads((PROGRAM / "artifacts/circuits/verifyingkey2.json").read_text())
        self.expected = checker["expected_key"](vk)

    def test_committed_key_matches(self):
        self.assertEqual(self.expected, checker["actual_key"](self.source))

    def test_changed_bytes_are_detected(self):
        for field, original, changed in (
            ("vk_alpha_g1", "45, 77, 154", "45, 77, 155"),
            ("vk_ic", "35, 121, 23, 162", "35, 121, 23, 163"),
            ("nr_pubinputs", "nr_pubinputs: 7", "nr_pubinputs: 6"),
        ):
            with self.subTest(field=field):
                self.assertIn(original, self.source)
                mutated = self.source.replace(original, changed, 1)
                actual = checker["actual_key"](mutated)
                self.assertNotEqual(self.expected[field], actual[field])

    def test_g2_uses_syscall_coordinate_order(self):
        point = [["1", "2"], ["3", "4"], ["1", "0"]]
        encoded = checker["g2"](point)
        self.assertEqual([encoded[i + 31] for i in range(0, 128, 32)], [2, 1, 4, 3])


if __name__ == "__main__":
    unittest.main()
