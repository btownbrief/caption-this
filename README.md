# 💬 CAPTION THIS

Btown's weekly community caption contest — part of the [Btown Games](https://btownbrief.github.io) arcade from the [BTown Brief](https://www.btownbrief.com).

**Play it: https://btownbrief.github.io/caption-this/**

## How a week works (all times Vermont)

| When | What |
| --- | --- |
| Monday 00:00 → Wednesday noon | ✍️ Caption submissions open on the new photo |
| Wednesday noon → Sunday night | 🔥 Tinder-style swipe voting (👍 right / 👎 left) |
| Monday morning | 🏆 Winner crowned on the Results tab, next photo goes live automatically |

Readers can also **submit photos** for future weeks; they sit in a review
queue until the editor approves them from `admin.html`.

## Architecture

Plain static site — no build step. `index.html` + `style.css` + ES modules
in `js/`. Backend is the shared Btown Games Supabase project: everything is
locked behind RLS and the public key can only call the security-definer
RPCs in [`supabase/schema.sql`](supabase/schema.sql). Setup steps in
[`supabase/SETUP.md`](supabase/SETUP.md).

- `js/api.js` — Supabase RPC + storage upload + shared `btown-*` player identity
- `js/swipe.js` — the swipe deck (pointer physics, stamps, undo)
- `js/main.js` — tabs, weekly round phases, results, photo submission
- `js/admin.js` + `admin.html` — the Editor's Desk (passphrase-gated moderation)

GitHub Actions:

- `deploy.yml` — GitHub Pages deploy on push
- `promote.yml` — Monday-morning round rollover (the game also self-heals on load)
- `pending-photos.yml` — every 2h, opens/closes a GitHub issue when reader
  photos await review (the issue email is the notification)
