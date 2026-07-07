# CAPTION THIS — backend setup (one time, ~5 minutes)

This game extends the existing **btown-games** Supabase project (the same
one the arcade leaderboard uses). It adds its own tables and functions and
**does not touch the `scores` table** at all.

## 1. Choose your admin passphrase & run the schema

1. Open `supabase/schema.sql` and replace `CHOOSE_YOUR_ADMIN_PASSPHRASE`
   (near the top) with a passphrase you'll remember — it's what unlocks
   `admin.html` on your phone. Keep the surrounding quotes.
2. Go to the Supabase dashboard → your **btown-games** project →
   **SQL Editor**, paste the whole edited file, click **Run**.
   You should see "Success. No rows returned."
   - Only the bcrypt *hash* of your passphrase is stored. To change it
     later, re-run just the `insert into public.admin_config ...` statement
     with a new passphrase.
   - If only the very LAST statement fails with
     `must be owner of table objects`, everything else worked — create that
     one storage policy through the dashboard instead (step 2 below covers it).

## 2. Create the storage bucket

Dashboard → **Storage** → **New bucket**:

- Name: `caption-photos`
- **Public bucket: ON** (photos are served straight from the bucket's
  public URL; pending photos have unguessable UUID filenames and never
  appear in the game until you approve them)
- Under **Additional configuration**:
  - Restrict file upload size: **3 MB** (the page resizes photos to
    ≤1600 px JPEG before uploading, typically ~300 KB)
  - Allowed MIME types: `image/jpeg`

If the storage policy at the end of schema.sql failed to run, add it here:
Storage → `caption-photos` → **Policies** → New policy → For **INSERT**,
target role **anon**, `WITH CHECK` expression:

```sql
bucket_id = 'caption-photos'
and name ~ '^submissions/[A-Za-z0-9-]+\.jpg$'
```

No SELECT/UPDATE/DELETE policies — uploaders can add a jpeg under
`submissions/` and nothing else.

## 3. That's it

The site already ships with the shared project URL + publishable key.
Open https://btownbrief.github.io/caption-this/admin.html, enter your
passphrase, and you're the editor-in-chief.

## How the week runs (all times Vermont / America-New_York)

- **Monday 00:00 → Wednesday noon** — caption submissions open
- **Wednesday noon → Sunday 23:59** — swipe voting
- **Monday morning** — round is marked done, results move to the Results
  tab, and the oldest approved photo in your queue goes live automatically
  (a GitHub Action pings the promote function Monday mornings, and the
  game itself also self-heals on every page load).

## Notifications

`.github/workflows/pending-photos.yml` checks `get_pending_count` every
2 hours; if photos are waiting it opens a GitHub issue (GitHub emails you),
and closes it once the queue is clear.

## Cleanup / moderation

Everything moderate-able is in admin.html (approve/reject photos, remove
captions, end round early). For anything deeper, the Table Editor in the
dashboard works on `caption_photos`, `captions`, `caption_votes`.
