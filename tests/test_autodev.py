"""Dependency-free safety and contract tests for the local development loop."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "tools" / "autodev.py"
spec = importlib.util.spec_from_file_location("autodev", SOURCE)
autodev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(autodev)


class AutoDevTests(unittest.TestCase):
    def test_request_limits(self):
        for value, attempts, timeout in [("", 2, 900), ("  ", 2, 900),
                                         ("ok", 0, 900), ("ok", 4, 900),
                                         ("ok", 2, 30), ("ok", 2, 2000)]:
            with self.assertRaises(ValueError):
                autodev.validate_request(value, attempts, timeout)
        autodev.validate_request("Fix a bug", 2, 900)

    def test_api_keys_removed_from_subprocess_environment(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "secret", "GH_TOKEN": "secret",
                                          "MY_SERVICE_PASSWORD": "secret", "PATH": "safe"}):
            result = autodev.child_env()
        self.assertNotIn("OPENAI_API_KEY", result)
        self.assertNotIn("GH_TOKEN", result)
        self.assertNotIn("MY_SERVICE_PASSWORD", result)
        self.assertEqual(result["PATH"], "safe")

    def test_prompt_limits_scope_and_repairs(self):
        prompt = autodev.base_prompt("Improve image loading", 2, "Failed check: node")
        self.assertIn("Improve image loading", prompt)
        self.assertIn("Failed check: node", prompt)
        self.assertIn("Do not push, merge", prompt)
        self.assertIn("Do not weaken existing tests", prompt)

    def test_review_flags_for_automation_self_changes(self):
        changes = ["pixiv-tate-scroll.user.js", "tools/autodev.py", ".github/workflows/verify.yml"]
        self.assertEqual(autodev.protected_changes(changes), changes[1:])


if __name__ == "__main__":
    unittest.main()
