"""End-to-end integration using a disposable Git repository and a fake Codex executable.

No model, network, paid service, or production repo is involved. The test proves
control flow, *not* actual model behavior or Safari compatibility.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'tools' / 'autodev.py'


def command(*args: str, cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, check=False, timeout=90)


@unittest.skipIf(os.name == 'nt', 'mock executable uses a Unix shebang; CI runs this on Linux')
class LocalIntegrationTests(unittest.TestCase):
    def test_failing_first_check_then_successful_second_attempt(self):
        with tempfile.TemporaryDirectory(prefix='pts-autodev-integration-') as directory:
            temp = Path(directory)
            upstream = temp / 'origin.git'
            seed = temp / 'seed'
            seed.mkdir()
            self.assertEqual(command('git', 'init', '--bare', str(upstream), cwd=temp).returncode, 0)
            self.assertEqual(command('git', 'init', '-b', 'main', cwd=seed).returncode, 0)
            self.assertEqual(command('git', 'config', 'user.email', 'ci@example.invalid', cwd=seed).returncode, 0)
            self.assertEqual(command('git', 'config', 'user.name', 'Local Integration Test', cwd=seed).returncode, 0)
            self.assertEqual(command('git', 'remote', 'add', 'origin', str(upstream), cwd=seed).returncode, 0)
            (seed / 'pixiv-tate-scroll.user.js').write_text('function okay() { return true; }\n', encoding='utf-8')
            (seed / 'tests').mkdir()
            (seed / 'tests' / 'content-filter.cjs').write_text('console.log("fixture");\n', encoding='utf-8')
            self.assertEqual(command('git', 'add', '.', cwd=seed).returncode, 0)
            self.assertEqual(command('git', 'commit', '-m', 'Main baseline', cwd=seed).returncode, 0)
            self.assertEqual(command('git', 'push', '-u', 'origin', 'main', cwd=seed).returncode, 0)
            start = command('git', 'rev-parse', 'main', cwd=seed).stdout.strip()

            fake_bin = temp / 'bin'
            fake_bin.mkdir()
            marker = temp / 'marker.json'
            fake_executable = fake_bin / 'codex'
            fake_executable.write_text(f'''#!{sys.executable}
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
marker = Path(os.environ['FAKE_CODEX_MARKER'])
if args[:2] == ['login', 'status']:
    print('Logged in (fake test only)')
    raise SystemExit(0)
if args == ['--version']:
    print('codex-test-stub')
    raise SystemExit(0)
assert '-C' in args and '--sandbox' in args and 'workspace-write' in args
assert 'exec' in args and '--ephemeral' in args and args[-1] == '-'
request = sys.stdin.read()
assert 'Source of truth' in request or 'Source of truth:' in request
assert 'actual latest-main' in request
previous = json.loads(marker.read_text()) if marker.exists() else []
previous.append({{'args': args, 'has_failed_test_feedback': 'Failed checks:' in request}})
marker.write_text(json.dumps(previous))
worktree = Path(args[args.index('-C') + 1])
if len(previous) == 1:
    (worktree / 'pixiv-tate-scroll.user.js').write_text('function broken( {{\n', encoding='utf-8')
else:
    assert 'Failed checks:' in request
    (worktree / 'pixiv-tate-scroll.user.js').write_text('function fixed() {{ return true; }}\n', encoding='utf-8')
print('fake codex run complete')
''', encoding='utf-8')
            fake_executable.chmod(0o755)
            env = dict(os.environ)
            env['PATH'] = str(fake_bin) + os.pathsep + env.get('PATH', '')
            env['FAKE_CODEX_MARKER'] = str(marker)
            run = command(sys.executable, str(RUNNER), '--request',
                          'Find and fix the fixture parsing problem',
                          '--allow-local-tests', '--max-attempts', '2', cwd=seed, env=env)
            self.assertEqual(run.returncode, 0, run.stdout + '\n' + run.stderr)
            summary = json.loads(run.stdout)
            report = json.loads((Path(summary['report_dir']) / 'report.json').read_text(encoding='utf-8'))
            self.assertEqual(report['status'], 'checks_passed_review_required')
            self.assertEqual(len(report['attempts']), 2)
            self.assertNotEqual(report['attempts'][0]['checks'][0]['exit_code'], 0)
            self.assertTrue(all(c['exit_code'] == 0 for c in report['attempts'][1]['checks']))
            self.assertTrue(report['local_main_unchanged'])
            self.assertFalse(report['published'])
            self.assertFalse(report['device_verified'])
            calls = json.loads(marker.read_text())
            self.assertEqual(len(calls), 2)
            self.assertFalse(calls[0]['has_failed_test_feedback'])
            self.assertTrue(calls[1]['has_failed_test_feedback'])
            self.assertEqual(command('git', 'rev-parse', 'main', cwd=seed).stdout.strip(), start)
            self.assertEqual(command('git', 'rev-parse', 'origin/main', cwd=seed).stdout.strip(), start)


if __name__ == '__main__':
    unittest.main()
