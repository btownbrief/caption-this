# Caption This — agent instructions

Shared brain for any AI agent working in this repo (Codex, Claude Code, etc.).
Read `README.md` first for the weekly flow and architecture — this file adds the rules
an agent needs. Stephen is non-technical — explain consequential changes in plain
language.

## What this is
Btown's weekly community caption contest. Plain static site, **no build step**:
`index.html` + `admin.html` + `style.css` + ES modules in `js/`. Deployed by GitHub
Pages via `.github/workflows/deploy.yml` on push.

## The moving parts
- `js/api.js` — Supabase RPC + storage upload + shared `btown-*` player identity
- `js/swipe.js` — swipe voting deck (pointer physics, undo)
- `js/main.js` — tabs, weekly round phases, results, reader **photo submission**
- `js/admin.js` + `admin.html` — the Editor's Desk (moderation)
- Actions: `promote.yml` (Monday-morning round rollover — the game also self-heals on
  load), `pending-photos.yml` (every 2h, opens/closes a GitHub issue when reader photos
  await review — the issue email is Stephen's notification), `deploy.yml`.

## Submissions & approval — this is MANUAL, there is no AI in it
Reader captions and reader-submitted photos sit in a **review queue** until the editor
approves them from `admin.html`. The admin dashboard is **passphrase-gated**: every admin
RPC verifies the passphrase server-side (`admin_check_pass`); the pass is cached in
localStorage after first unlock. Approve/reject/promote all go through security-definer
RPCs. **No moderation model, no AI API — do not add one unless Stephen explicitly asks.**

## Backend rules
Shared Btown Games Supabase project. Everything is behind RLS; the public anon key can
**only** call the security-definer RPCs in `supabase/schema.sql` (setup in
`supabase/SETUP.md`). Never put a service-role key or the admin passphrase in client JS
or commit it — the passphrase is checked server-side by design.

## Before you finish
No test suite. If you changed RPC calls or the round-phase logic, walk the weekly flow
(submit → vote → results) against a Supabase instance, or clearly say you could not and
what you inspected instead. Say what you verified.
