"""The VM gate's words (sbgpu_agent/vmgate.py WORDS) against the shared fixture that @sbgpu/api's list generates
(packages/machine/fixtures/vm-gate-words.json): control accepts exactly these words in a gate report, so a word added,
removed or renamed on one side alone fails here or in src/gate-words.test.ts."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sbgpu_agent import vmgate as G  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "fixtures", "vm-gate-words.json")


class GateWordsTest(unittest.TestCase):
    def test_the_gate_words_are_exactly_the_shared_fixture(self):
        with open(FIXTURE, "rb") as f:
            data = f.read()
        self.assertEqual(len(G.WORDS), len(set(G.WORDS)), "a word listed twice")
        # (the fixture's exact bytes: the sorted words as a one-line JSON array with no spaces, and a final newline)
        self.assertEqual(data, (json.dumps(sorted(G.WORDS), separators=(",", ":")) + "\n").encode("ascii"),
                         "the gate's words differ from @sbgpu/api's: change both, then regenerate the fixture")


if __name__ == "__main__":
    unittest.main()
