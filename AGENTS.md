# Development guidance for pixiv-tate-scroll

- **Source of truth:** the latest merged `origin/main` of `Mamimami33/pixiv-tate-scroll`; do not treat older chat patches or unmerged branches as installed code.
- Make the smallest change that satisfies the user's request. Infer reasonable details, but ask for decisions that materially affect safety, privacy, or externally visible behavior.
- Preserve existing search ranking, content filtering, user settings, and release/install behavior unless the request expressly changes them.
- Never commit directly to `main`, merge, push, publish, change permissions, or add paid services without explicit authorization.
- Avoid secrets and personal account data. Do not use real pixiv credentials or bypass pixiv access restrictions in tests.
- Required verification: `node --check pixiv-tate-scroll.user.js`, `node --check tests/content-filter.cjs`, `python -m unittest discover -s tests -p test_autodev.py`, `git diff --check`, and (where available) `node tests/content-filter.cjs` with Playwright/Chromium.
- Label verification precisely: syntax check, mocked-browser regression, live browser, and **iPhone Safari with Userscripts** are different. Only claim the last if it happened on an actual device.
- Finish with: assumption(s), changed files, acceptance criteria, tests run and their outputs, untested risks, and next step. Never report successful integration solely because code was written.

The bounded local automation entry point and its limitations are documented in `docs/autodev.md`.
