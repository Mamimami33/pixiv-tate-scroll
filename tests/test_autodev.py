"""Dependency-free safety and contract tests for the local development loop."""
import importlib.util
import os
from pathlib import Path
import unittest
import subprocess
from unittest.mock import patch
from types import SimpleNamespace

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

    def test_windows_codex_launcher_prefers_cmd_shim(self):
        def which(name):
            return {"codex.cmd": r"C:\\npm\\codex.cmd",
                    "codex.exe": None, "codex": r"C:\\npm\\codex.cmd"}.get(name)
        with patch.object(autodev, "os", SimpleNamespace(name="nt")):
            with patch.object(autodev.shutil, "which", side_effect=which):
                self.assertEqual(autodev.codex_executable(), r"C:\\npm\\codex.cmd")

    def test_posix_codex_launcher_uses_resolved_path(self):
        with patch.object(autodev, "os", SimpleNamespace(name="posix")):
            with patch.object(autodev.shutil, "which", return_value="/usr/bin/codex") as which:
                self.assertEqual(autodev.codex_executable(), "/usr/bin/codex")
                which.assert_called_once_with("codex")

    def test_missing_executable_reports_status_instead_of_traceback(self):
        result = autodev.run(["definitely-not-existing-autodev-executable-12345"],
                             Path.cwd(), timeout=3)
        self.assertEqual(result.returncode, 127)
        self.assertIn("PROCESS START ERROR", result.stdout)

    def test_isolated_worker_required_before_model_invocation(self):
        with self.assertRaisesRegex(RuntimeError, "unconfirmed host"):
            autodev.require_isolated_worker(False)
        autodev.require_isolated_worker(True)

    def test_git_porcelain_z_preserves_leading_spaces_and_rename_paths(self):
        output = " M leading space.js\\0?? 新規 file.js\\0R  renamed.js\\0old.js\\0"
        with patch.object(autodev, "run",
                          return_value=subprocess.CompletedProcess(["git"], 0, output)):
            paths = autodev.changed_paths(Path.cwd())
        self.assertEqual(paths, ["leading space.js", "新規 file.js", "renamed.js", "old.js"])

    def test_git_porcelain_z_rejects_partial_response(self):
        with patch.object(autodev, "run",
                          return_value=subprocess.CompletedProcess(["git"], 0, " M file.js")):
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                autodev.changed_paths(Path.cwd())

    def test_non_allowlisted_paths_require_review(self):
        paths = ["pixiv-tate-scroll.user.js", "tests/content-filter.cjs",
                 "index.html", "tools/autodev.py", ".github/workflows/verify.yml"]
        self.assertEqual(autodev.protected_changes(paths), paths[1:])

    def test_review_flags_for_automation_self_changes(self):
        changes = ["pixiv-tate-scroll.user.js", "tools/autodev.py", ".github/workflows/verify.yml"]
        self.assertEqual(autodev.protected_changes(changes), changes[1:])


if __name__ == "__main__":
    unittest.main()
