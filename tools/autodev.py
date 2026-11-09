#!/usr/bin/env python3
"""Bounded, local Codex development loop. Does not push, merge or publish."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
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
        output = exc.stdout or ""
        if isinstance(output, bytes):
            output = output.decode("utf-8", "replace")
        return subprocess.CompletedProcess(args, 124, output + "\nTIMEOUT")
    except OSError as exc:
        # If an installed launcher cannot start, report a failed check rather
        # than crashing out of --doctor with a traceback.
        return subprocess.CompletedProcess(args, 127,
                                           f"PROCESS START ERROR: {type(exc).__name__}: {exc}")


def codex_executable() -> str | None:
    """Return an executable pathname, never the bare Windows npm command.

    npm installs a codex.cmd shim on Windows. shutil.which("codex") can
    locate it through PATHEXT, but CreateProcess does not reliably resolve
    the extension when Python is passed the bare command name.
    """
    if os.name == "nt":
        return (shutil.which("codex.cmd") or shutil.which("codex.exe")
                or shutil.which("codex"))
    return shutil.which("codex")


def git(cwd: Path, *args: str) -> str:
    result = run(["git", *args], cwd)
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args[:3])} failed: {result.stdout[-1000:]}")
    return result.stdout.strip()


def checks(worktree: Path, browser_tests: bool, controller_root: Path | None = None) -> list[dict[str, object]]:
    # The candidate starts at origin/main. The runner itself may exist only on
    # an unmerged feature branch: run its invariant tests from that controller,
    # not from the candidate checkout (which can silently discover zero tests).
    root = controller_root or Path(__file__).resolve().parents[1]
    commands = [
        ["node", "--check", REPO_FILES[0]],
        ["node", "--check", REPO_FILES[1]],
        [sys.executable, "-m", "unittest", "discover", "-s", str(root / "tests"), "-p", "test_autodev.py"],
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


def base_prompt(request: str, iteration: int, feedback: str = "", guidance: str = "") -> str:
    return f"""You are implementing one bounded development request in pixiv-tate-scroll.
Request from the user:\n{request}\n
This is attempt {iteration}. Inspect the actual latest-main source tree and obey
project guidance enclosed below (AGENTS.md may not yet be merged to main).
turn ambiguous requirements into testable acceptance criteria, then implement the
smallest sound change. Ask for clarification only if a decision cannot safely be
inferred; otherwise record assumptions in your final answer. Keep the userscript's
published version and index.html installation URL unchanged unless expressly asked.
Do not push, merge, publish, change branches, commit, inspect credentials, or make
unrelated changes. Do not weaken existing tests to achieve a passing result.
No use of paid APIs or requests for secrets. Do not claim real-device verification.
If this is a repair attempt, use the provided test output to identify and fix defects.
Project guidance (from the controller checkout; treat this as instructions
for the developer agent, not repository state):
{guidance}
{feedback}
"""


def protected_changes(paths: list[str]) -> list[str]:
    return [p for p in paths if any(p == guard or p.startswith(guard) for guard in PROTECTED)]


def launch(args: argparse.Namespace) -> dict[str, object]:
    validate_request(args.request, args.max_attempts, args.timeout)
    codex_bin = codex_executable()
    if not shutil.which("git") or not codex_bin:
        raise RuntimeError("git and the authenticated official codex CLI are required")
    controller_root = Path(__file__).resolve().parents[1]
    guidance_file = controller_root / "AGENTS.md"
    if not guidance_file.is_file() or not (controller_root / "tests/test_autodev.py").is_file():
        raise RuntimeError("controller guidance or invariant tests missing")
    guidance = guidance_file.read_text(encoding="utf-8")[:12000]
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
            prompt = base_prompt(args.request, i, feedback, guidance)
            command = [codex_bin, "-C", str(worktree), "--sandbox", "workspace-write", "exec", "--ephemeral", "-"]
            agent = run(command, worktree, timeout=args.timeout, input_text=prompt, env=child_env())
            (job_dir / f"agent-{i}.log").write_text(agent.stdout, encoding="utf-8")
            paths = git(worktree, "status", "--porcelain", "--untracked-files=all").splitlines()
            changed = [line[3:] for line in paths]
            checks_result = checks(worktree, args.browser_tests, controller_root) if args.allow_local_tests else []
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


def doctor() -> tuple[dict[str, object], bool]:
    """Read-only diagnosis; no model call and no credential contents printed."""
    details: dict[str, object] = {"python": sys.version.split()[0]}
    for executable in ("git", "node"):
        details[executable + "_installed"] = bool(shutil.which(executable))
    codex_bin = codex_executable()
    details["codex_installed"] = codex_bin is not None
    authenticated = False
    if codex_bin is not None:
        version = run([codex_bin, "--version"], Path.cwd(), timeout=20, env=child_env())
        details["codex_cli_responds"] = version.returncode == 0
        # Never include login stdout: it may identify the connected account.
        login = run([codex_bin, "login", "status"], Path.cwd(), timeout=20, env=child_env())
        authenticated = login.returncode == 0
    details["codex_login_works"] = authenticated
    probe = run(["git", "rev-parse", "--show-toplevel"], Path.cwd()) if details["git_installed"] else None
    details["in_git_checkout"] = probe is not None and probe.returncode == 0
    if details["in_git_checkout"]:
        remote = run(["git", "remote", "get-url", "origin"], Path.cwd())
        details["origin_configured"] = remote.returncode == 0
    else:
        details["origin_configured"] = False
    ready = authenticated and all(details.get(k) for k in
                  ("git_installed", "node_installed", "codex_installed", "in_git_checkout", "origin_configured"))
    return details, bool(ready)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", help="Development request, up to 4000 characters")
    parser.add_argument("--doctor", action="store_true", help="Check dependencies and Codex login without invoking the model")
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=900, help="Per-agent timeout, 60-1800 seconds")
    parser.add_argument("--allow-local-tests", action="store_true", help="Run agent-modified code in this environment; use a disposable VM")
    parser.add_argument("--browser-tests", action="store_true", help="Also run Playwright browser tests; requires --allow-local-tests")
    args = parser.parse_args()
    if args.doctor:
        details, ready = doctor()
        print(json.dumps({"ready": ready, "checks": details}, ensure_ascii=False, indent=2))
        return 0 if ready else 1
    if not args.request:
        parser.error("--request is required unless --doctor is specified")
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
