#!/usr/bin/env python3
"""Bounded, local Codex development loop. Does not push, merge or publish."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

REPO_FILES = ("pixiv-tate-scroll.user.js", "tests/content-filter.cjs")
PROTECTED = ("tools/autodev.py", "tests/test_autodev.py", ".github/workflows/")


def validate_request(request: str, attempts: int, timeout: int) -> None:
    if not request.strip() or len(request) > 4000:
        raise ValueError("request must contain 1-4000 characters")
    if not 1 <= attempts <= 3:
        raise ValueError("max-attempts must be 1-3")
    if not 60 <= timeout <= 1800:
        raise ValueError("timeout must be 60-1800 seconds")


def child_env() -> dict[str, str]:
    """Avoid passing ambient API and deployment credentials to the child."""
    blocked_exact = {"GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "GIT_ASKPASS", "SSH_ASKPASS"}
    blocked_suffix = ("_API_KEY", "_SECRET", "_PASSWORD", "_TOKEN", "_CREDENTIALS")
    return {k: v for k, v in os.environ.items()
            if k.upper() not in blocked_exact and not k.upper().endswith(blocked_suffix)}


def run(args: list[str], cwd: Path, timeout: int = 120, input_text: str | None = None,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, cwd=cwd, input=input_text, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=timeout, check=False, env=env)
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(args, 124, (exc.stdout or b"").decode("utf-8", "replace")
                                 if isinstance(exc.stdout, bytes) else (exc.stdout or "") + "\nTIMEOUT")


def git(cwd: Path, *args: str) -> str:
    result = run(["git", *args], cwd)
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args[:3])} failed: {result.stdout[-1000:]}")
    return result.stdout.strip()


def checks(worktree: Path, browser_tests: bool) -> list[dict[str, object]]:
    commands = [
        ["node", "--check", REPO_FILES[0]],
        ["node", "--check", REPO_FILES[1]],
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_autodev.py"],
        ["git", "diff", "--check"],
    ]
    if browser_tests:
        commands.append(["node", REPO_FILES[1]])
    results = []
    for cmd in commands:
        outcome = run(cmd, worktree, timeout=240)
        results.append({"command": cmd, "exit_code": outcome.returncode,
                        "output_tail": outcome.stdout[-3000:]})
    return results


def base_prompt(request: str, iteration: int, feedback: str = "") -> str:
    return f"""You are implementing one bounded development request in pixiv-tate-scroll.
Request from the user:\n{request}\n
This is attempt {iteration}. Read AGENTS.md and the repository, inspect actual code,
turn ambiguous requirements into testable acceptance criteria, then implement the
smallest sound change. Ask for clarification only if a decision cannot safely be
inferred; otherwise record assumptions in your final answer. Keep the userscript's
published version and index.html installation URL unchanged unless expressly asked.
Do not push, merge, publish, change branches, commit, inspect credentials, or make
unrelated changes. Do not weaken existing tests to achieve a passing result.
No use of paid APIs or requests for secrets. Do not claim real-device verification.
If this is a repair attempt, use the provided test output to identify and fix defects.
{feedback}
"""


def protected_changes(paths: list[str]) -> list[str]:
    return [p for p in paths if any(p == guard or p.startswith(guard) for guard in PROTECTED)]


def launch(args: argparse.Namespace) -> dict[str, object]:
    validate_request(args.request, args.max_attempts, args.timeout)
    if not shutil.which("git") or not shutil.which("codex"):
        raise RuntimeError("git and the authenticated official codex CLI are required")
    repo = Path(git(Path.cwd(), "rev-parse", "--show-toplevel")).resolve()
    if not all((repo / path).is_file() for path in REPO_FILES):
        raise RuntimeError("run from the pixiv-tate-scroll repository")
    # Remote main is authoritative, not a remembered feature branch or local checkout.
    git(repo, "fetch", "origin", "main")
    base_sha = git(repo, "rev-parse", "refs/remotes/origin/main")
    local_main_before = run(["git", "rev-parse", "refs/heads/main"], repo).stdout.strip()
    branch = "autodev/" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    job_dir = Path(tempfile.mkdtemp(prefix="pts-autodev-"))
    worktree = job_dir / "worktree"
    git(repo, "worktree", "add", "-b", branch, str(worktree), base_sha)
    report: dict[str, object] = {"branch": branch, "base_sha": base_sha,
        "worktree": str(worktree), "report_dir": str(job_dir), "attempts": [],
        "browser_tests_requested": args.browser_tests, "device_verified": False,
        "published": False, "status": "blocked"}
    feedback = ""
    try:
        for i in range(1, args.max_attempts + 1):
            prompt = base_prompt(args.request, i, feedback)
            command = ["codex", "-C", str(worktree), "--sandbox", "workspace-write", "exec", "--ephemeral", "-"]
            agent = run(command, worktree, timeout=args.timeout, input_text=prompt, env=child_env())
            (job_dir / f"agent-{i}.log").write_text(agent.stdout, encoding="utf-8")
            paths = git(worktree, "status", "--porcelain", "--untracked-files=all").splitlines()
            changed = [line[3:] for line in paths]
            checks_result = checks(worktree, args.browser_tests) if args.allow_local_tests else []
            attempt = {"number": i, "agent_exit_code": agent.returncode,
                       "changed_files": changed, "protected_changes": protected_changes(changed),
                       "checks": checks_result}
            cast_attempts = report["attempts"]
            assert isinstance(cast_attempts, list)
            cast_attempts.append(attempt)
            if agent.returncode == 0 and changed and checks_result and all(c["exit_code"] == 0 for c in checks_result):
                report["status"] = "checks_passed_review_required"
                break
            if not args.allow_local_tests:
                report["status"] = "unverified_local_tests_disabled"
                break
            failures = [c for c in checks_result if c["exit_code"] != 0]
            feedback = "\nPrevious attempt exit code: " + str(agent.returncode) + "\nFailed checks:\n" + "\n".join(
                " ".join(c["command"]) + "\n" + str(c["output_tail"])[-2000:] for c in failures)
            if not changed:
                feedback += "\nNo changed files were detected."
            if not failures and changed and agent.returncode != 0:
                feedback += "\nCodex failed despite passing checks; inspect its failure."
        local_main_after = run(["git", "rev-parse", "refs/heads/main"], repo).stdout.strip()
        report["local_main_unchanged"] = local_main_before == local_main_after
        if not report["local_main_unchanged"]:
            report["status"] = "main_changed_stop_and_investigate"
        report["verification_note"] = ("Local checks are not proof of Safari/device behavior. "
            "Human review and device validation are required before publishing.")
    finally:
        (job_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="Development request, up to 4000 characters")
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=900, help="Per-agent timeout, 60-1800 seconds")
    parser.add_argument("--allow-local-tests", action="store_true", help="Run agent-modified code in this environment; use a disposable VM")
    parser.add_argument("--browser-tests", action="store_true", help="Also run Playwright browser tests; requires --allow-local-tests")
    args = parser.parse_args()
    if args.browser_tests and not args.allow_local_tests:
        parser.error("--browser-tests requires --allow-local-tests")
    try:
        report = launch(args)
    except (ValueError, RuntimeError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({k: report[k] for k in ("branch", "base_sha", "worktree", "report_dir", "status")}, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "checks_passed_review_required" else 1


if __name__ == "__main__":
    raise SystemExit(main())
