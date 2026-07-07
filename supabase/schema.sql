-- CAPTION THIS — schema for the Btown Games caption contest.
-- Paste this WHOLE file into the Supabase SQL Editor (same btown-games
-- project as the scores leaderboard) and click Run.
--
-- ⚠️ ONE THING TO EDIT FIRST: search for CHOOSE_YOUR_ADMIN_PASSPHRASE below
-- and replace it with your real admin passphrase (keep the quotes).
--
-- Security model matches the existing scores schema: RLS locks every table
-- completely; the public anon key can ONLY go through the security-definer
-- functions below. Admin functions additionally require the passphrase,
-- which is stored only as a bcrypt hash.
--
-- Weekly lifecycle (America/New_York):
--   Each photo runs Monday–Sunday. Captions open Mon 00:00 → Wed 12:00
--   (noon); voting runs Wed 12:00 → Sun 23:59; then the round is done and
--   the oldest 'approved' photo is promoted. Promotion happens inside
--   advance_rounds(), which is called by every get_current_round() AND by
--   a Monday-morning GitHub Action — zero maintenance.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables

create table if not exists public.caption_photos (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique
    check (storage_path ~ '^submissions/[A-Za-z0-9-]+\.jpg$'),
  credit text not null default '' check (length(credit) <= 120),
  status text not null default 'pending'
    check (status in ('pending','approved','live','done','rejected')),
  week_of date,                    -- the Monday this photo's round started
  captions_until timestamptz,     -- caption phase ends (Wed noon NY)
  votes_until timestamptz,        -- voting ends / round over (Mon 00:00 NY)
  submitted_by uuid not null,
  created_at timestamptz not null default now()
);
-- at most one photo may be live at a time
create unique index if not exists caption_photos_one_live
  on public.caption_photos ((true)) where status = 'live';

create table if not exists public.captions (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references public.caption_photos(id) on delete cascade,
  player_id uuid not null,
  token text not null,             -- device secret; proves caption ownership
  name text not null,
  text text not null check (length(text) between 1 and 140),
  created_at timestamptz not null default now(),
  unique (photo_id, player_id)     -- one caption per player per photo
);

create table if not exists public.caption_votes (
  caption_id uuid not null references public.captions(id) on delete cascade,
  voter_player_id uuid not null,
  voter_token text not null,       -- proves vote ownership (for undo/change)
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (caption_id, voter_player_id)  -- one vote per player per caption
);

create table if not exists public.admin_config (
  id boolean primary key default true check (id),  -- single row
  pass_hash text not null
);

-- ⚠️⚠️⚠️ EDIT THIS LINE: set your admin passphrase (then run the file) ⚠️⚠️⚠️
insert into public.admin_config (pass_hash)
values (crypt('CHOOSE_YOUR_ADMIN_PASSPHRASE', gen_salt('bf')))
on conflict (id) do update set pass_hash = excluded.pass_hash;

-- Lock everything down: anon can only use the functions below.
alter table public.caption_photos enable row level security;
alter table public.captions enable row level security;
alter table public.caption_votes enable row level security;
alter table public.admin_config enable row level security;
revoke all on table public.caption_photos from anon, authenticated;
revoke all on table public.captions from anon, authenticated;
revoke all on table public.caption_votes from anon, authenticated;
revoke all on table public.admin_config from anon, authenticated;

-- --------------------------------------------------------------- helpers

create or replace function public.ct_ny_now() returns timestamp
language sql stable as $$
  select now() at time zone 'America/New_York';
$$;

-- the Monday of the current week, NY time
create or replace function public.ct_week_monday() returns date
language sql stable as $$
  select (public.ct_ny_now()::date
          - (extract(isodow from public.ct_ny_now())::int - 1));
$$;

-- NY wall-clock date+time -> timestamptz
create or replace function public.ct_ny_ts(d date, hrs int) returns timestamptz
language sql stable as $$
  select (d::timestamp + make_interval(hours => hrs))
         at time zone 'America/New_York';
$$;

create or replace function public.ct_is_admin(p_pass text) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from admin_config
    where pass_hash = crypt(coalesce(p_pass, ''), pass_hash)
  );
$$;
revoke all on function public.ct_is_admin(text) from public, anon, authenticated;

create or replace function public.ct_require_admin(p_pass text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not ct_is_admin(p_pass) then
    raise exception 'bad admin passphrase' using errcode = '28000';
  end if;
end $$;
revoke all on function public.ct_require_admin(text) from public, anon, authenticated;

-- ------------------------------------------------------ round lifecycle

-- Close a finished round and promote the oldest approved photo.
-- Idempotent; safe to call any time from anywhere.
create or replace function public.advance_rounds() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_week date;
  v_cap timestamptz;
begin
  update caption_photos set status = 'done'
  where status = 'live' and votes_until <= now();

  if not exists (select 1 from caption_photos where status = 'live') then
    v_week := ct_week_monday();
    v_cap  := ct_ny_ts(v_week + 2, 12);          -- Wednesday noon NY
    if now() >= v_cap then                        -- past Wed noon: wait for
      v_week := v_week + 7;                       -- next Monday instead
      v_cap  := ct_ny_ts(v_week + 2, 12);
    end if;
    update caption_photos
    set status = 'live', week_of = v_week,
        captions_until = v_cap,
        votes_until = ct_ny_ts(v_week + 7, 0)     -- following Monday 00:00 NY
    where id = (select id from caption_photos
                where status = 'approved'
                order by created_at limit 1);
  end if;
end $$;

create or replace function public.ct_phase(p caption_photos) returns text
language sql stable as $$
  select case
    when p.status <> 'live' then 'none'
    when p.week_of > public.ct_ny_now()::date then 'upcoming'
    when now() < p.captions_until then 'caption'
    when now() < p.votes_until then 'vote'
    else 'none'
  end;
$$;

-- ----------------------------------------------------------- player RPCs

-- The one call the game makes on load: auto-advances rounds, then reports
-- the live photo and which phase we're in.
create or replace function public.get_current_round() returns json
language plpgsql security definer set search_path = public as $$
declare
  p caption_photos;
  ph text;
begin
  perform advance_rounds();
  select * into p from caption_photos where status = 'live';
  if not found then
    return json_build_object('phase', 'none', 'photo', null);
  end if;
  ph := ct_phase(p);
  return json_build_object(
    'phase', ph,
    'phase_ends_at', case ph when 'caption' then p.captions_until
                             when 'vote' then p.votes_until
                             when 'upcoming' then ct_ny_ts(p.week_of, 0) end,
    'photo', json_build_object(
      'id', p.id, 'storage_path', p.storage_path,
      'credit', p.credit, 'week_of', p.week_of),
    'caption_count', (select count(*) from captions where photo_id = p.id)
  );
end $$;

-- Upsert the player's single caption for the live photo (caption phase only).
create or replace function public.submit_caption(
  p_photo uuid, p_player uuid, p_token text, p_name text, p_text text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  p caption_photos;
  clean_name text := left(trim(coalesce(p_name, '')), 20);
  clean_text text := left(trim(coalesce(p_text, '')), 140);
begin
  select * into p from caption_photos where id = p_photo;
  if not found or ct_phase(p) <> 'caption' then
    raise exception 'captions are closed' using errcode = 'P0001';
  end if;
  if length(clean_text) = 0 then
    raise exception 'empty caption' using errcode = 'P0001';
  end if;
  if length(clean_name) = 0 then clean_name := 'Anonymous'; end if;
  -- sanity cap: one photo can't accumulate unbounded captions
  if (select count(*) from captions where photo_id = p_photo) >= 500 then
    raise exception 'caption limit reached' using errcode = 'P0001';
  end if;
  insert into captions (photo_id, player_id, token, name, text)
  values (p_photo, p_player, p_token, clean_name, clean_text)
  on conflict (photo_id, player_id) do update
    set text = excluded.text, name = excluded.name, created_at = now()
    where captions.token = excluded.token;  -- only the owning device edits
end $$;

-- Captions the player hasn't voted on yet (never their own), random order,
-- plus progress numbers for "12 of 34 judged".
create or replace function public.get_captions_to_swipe(
  p_photo uuid, p_player uuid
) returns json
language plpgsql security definer set search_path = public as $$
declare
  p caption_photos;
begin
  select * into p from caption_photos where id = p_photo;
  if not found or ct_phase(p) <> 'vote' then
    return json_build_object('cards', '[]'::json, 'voted', 0, 'total', 0);
  end if;
  return json_build_object(
    'cards', coalesce((
      select json_agg(json_build_object('id', c.id, 'name', c.name, 'text', c.text)
                      order by random())
      from captions c
      where c.photo_id = p_photo and c.player_id <> p_player
        and not exists (select 1 from caption_votes v
                        where v.caption_id = c.id
                          and v.voter_player_id = p_player)
    ), '[]'::json),
    'voted', (select count(*) from caption_votes v
              join captions c on c.id = v.caption_id
              where c.photo_id = p_photo and v.voter_player_id = p_player),
    'total', (select count(*) from captions c
              where c.photo_id = p_photo and c.player_id <> p_player)
  );
end $$;

-- value +1 / -1 votes (upsert, token-guarded); value 0 retracts (undo).
create or replace function public.vote_caption(
  p_caption uuid, p_player uuid, p_token text, p_value int
) returns void
language plpgsql security definer set search_path = public as $$
declare
  c captions;
  p caption_photos;
begin
  if p_value not in (-1, 0, 1) then return; end if;
  select * into c from captions where id = p_caption;
  if not found then return; end if;
  select * into p from caption_photos where id = c.photo_id;
  if ct_phase(p) <> 'vote' then
    raise exception 'voting is closed' using errcode = 'P0001';
  end if;
  if c.player_id = p_player then
    raise exception 'cannot vote on your own caption' using errcode = 'P0001';
  end if;
  if p_value = 0 then
    delete from caption_votes
    where caption_id = p_caption and voter_player_id = p_player
      and voter_token = p_token;
  else
    insert into caption_votes (caption_id, voter_player_id, voter_token, value)
    values (p_caption, p_player, p_token, p_value)
    on conflict (caption_id, voter_player_id) do update
      set value = excluded.value
      where caption_votes.voter_token = excluded.voter_token;
  end if;
end $$;

-- Results of the most recently finished round: top 10 by net votes.
create or replace function public.get_results() returns json
language plpgsql security definer set search_path = public as $$
declare
  p caption_photos;
begin
  perform advance_rounds();
  select * into p from caption_photos
  where status = 'done' order by votes_until desc limit 1;
  if not found then return json_build_object('photo', null); end if;
  return json_build_object(
    'photo', json_build_object(
      'id', p.id, 'storage_path', p.storage_path,
      'credit', p.credit, 'week_of', p.week_of),
    'caption_count', (select count(*) from captions where photo_id = p.id),
    'total_votes', (select count(*) from caption_votes v
                    join captions c on c.id = v.caption_id
                    where c.photo_id = p.id),
    'top', coalesce((
      select json_agg(row_to_json(t)) from (
        select c.name, c.text,
               coalesce(sum(v.value) filter (where v.value = 1), 0)::int as up,
               coalesce(-sum(v.value) filter (where v.value = -1), 0)::int as down,
               coalesce(sum(v.value), 0)::int as net
        from captions c
        left join caption_votes v on v.caption_id = c.id
        where c.photo_id = p.id
        group by c.id, c.name, c.text, c.created_at
        order by net desc, up desc, c.created_at asc
        limit 10
      ) t
    ), '[]'::json)
  );
end $$;

-- Reader photo submission. The file itself was already uploaded to the
-- caption-photos storage bucket; this registers it as 'pending' (invisible
-- in the game until approved). Rate limit: 3 pending per player, 200 global.
create or replace function public.submit_photo(
  p_player uuid, p_token text, p_path text, p_credit text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_path !~ '^submissions/[A-Za-z0-9-]+\.jpg$' then
    raise exception 'bad photo path' using errcode = 'P0001';
  end if;
  if (select count(*) from caption_photos
      where submitted_by = p_player and status = 'pending') >= 3 then
    raise exception 'you already have 3 photos waiting for review'
      using errcode = 'P0001';
  end if;
  if (select count(*) from caption_photos where status = 'pending') >= 200 then
    raise exception 'review queue is full' using errcode = 'P0001';
  end if;
  insert into caption_photos (storage_path, credit, submitted_by)
  values (p_path, left(trim(coalesce(p_credit, '')), 120), p_player);
end $$;

-- Used by the notification GitHub Action and the admin page badge.
create or replace function public.get_pending_count() returns integer
language sql security definer stable set search_path = public as $$
  select count(*)::int from caption_photos where status = 'pending';
$$;

-- ------------------------------------------------------------ admin RPCs

create or replace function public.admin_list_photos(p_pass text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform ct_require_admin(p_pass);
  perform advance_rounds();
  return json_build_object(
    'pending', coalesce((select json_agg(row_to_json(t)) from (
      select id, storage_path, credit, created_at from caption_photos
      where status = 'pending' order by created_at) t), '[]'::json),
    'queue', coalesce((select json_agg(row_to_json(t)) from (
      select id, storage_path, credit, created_at from caption_photos
      where status = 'approved' order by created_at) t), '[]'::json),
    'live', (select row_to_json(t) from (
      select p.id, p.storage_path, p.credit, p.week_of, p.captions_until,
             p.votes_until, ct_phase(p) as phase,
             (select count(*) from captions where photo_id = p.id) as caption_count
      from caption_photos p where status = 'live') t),
    'recent_done', coalesce((select json_agg(row_to_json(t)) from (
      select id, storage_path, credit, week_of from caption_photos
      where status = 'done' order by votes_until desc limit 5) t), '[]'::json)
  );
end $$;

create or replace function public.admin_approve_photo(p_pass text, p_photo uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ct_require_admin(p_pass);
  update caption_photos set status = 'approved'
  where id = p_photo and status = 'pending';
end $$;

create or replace function public.admin_reject_photo(p_pass text, p_photo uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ct_require_admin(p_pass);
  update caption_photos set status = 'rejected'
  where id = p_photo and status in ('pending', 'approved');
end $$;

-- Force a photo live right now (ends any current round). Uses this week's
-- standard boundaries, but never starts a round whose caption window is
-- already over: past Wed noon it grants 48h of captions + 4 days of voting.
create or replace function public.admin_promote_photo(p_pass text, p_photo uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_week date;
  v_cap timestamptz;
  v_end timestamptz;
begin
  perform ct_require_admin(p_pass);
  if not exists (select 1 from caption_photos
                 where id = p_photo and status = 'approved') then
    raise exception 'photo is not in the approved queue' using errcode = 'P0001';
  end if;
  update caption_photos set status = 'done' where status = 'live';
  v_week := ct_week_monday();
  v_cap  := ct_ny_ts(v_week + 2, 12);
  v_end  := ct_ny_ts(v_week + 7, 0);
  if v_cap <= now() then
    v_cap := now() + interval '48 hours';
    v_end := v_cap + interval '4 days';
  end if;
  update caption_photos
  set status = 'live', week_of = v_week,
      captions_until = v_cap, votes_until = v_end
  where id = p_photo;
end $$;

-- Close captions early: voting starts now.
create or replace function public.admin_open_voting(p_pass text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ct_require_admin(p_pass);
  update caption_photos set captions_until = now()
  where status = 'live' and captions_until > now();
end $$;

-- End the current round now (results become final, next photo promotes).
create or replace function public.admin_end_round(p_pass text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ct_require_admin(p_pass);
  update caption_photos set votes_until = now(),
    captions_until = least(captions_until, now())
  where status = 'live';
  perform advance_rounds();
end $$;

-- Moderation: captions on the live photo, newest first, with vote counts.
create or replace function public.admin_list_captions(p_pass text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform ct_require_admin(p_pass);
  return coalesce((select json_agg(row_to_json(t)) from (
    select c.id, c.name, c.text, c.created_at,
           coalesce(sum(v.value), 0)::int as net
    from captions c
    join caption_photos p on p.id = c.photo_id and p.status = 'live'
    left join caption_votes v on v.caption_id = c.id
    group by c.id order by c.created_at desc
  ) t), '[]'::json);
end $$;

create or replace function public.admin_remove_caption(p_pass text, p_caption uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ct_require_admin(p_pass);
  delete from captions where id = p_caption;
end $$;

-- Lets the admin page verify the passphrase before storing it locally.
create or replace function public.admin_check_pass(p_pass text) returns boolean
language sql security definer stable set search_path = public as $$
  select public.ct_is_admin(p_pass);
$$;

-- ---------------------------------------------------------------- grants

grant execute on function public.get_current_round() to anon;
grant execute on function public.advance_rounds() to anon;
grant execute on function public.submit_caption(uuid, uuid, text, text, text) to anon;
grant execute on function public.get_captions_to_swipe(uuid, uuid) to anon;
grant execute on function public.vote_caption(uuid, uuid, text, int) to anon;
grant execute on function public.get_results() to anon;
grant execute on function public.submit_photo(uuid, text, text, text) to anon;
grant execute on function public.get_pending_count() to anon;
grant execute on function public.admin_list_photos(text) to anon;
grant execute on function public.admin_approve_photo(text, uuid) to anon;
grant execute on function public.admin_reject_photo(text, uuid) to anon;
grant execute on function public.admin_promote_photo(text, uuid) to anon;
grant execute on function public.admin_open_voting(text) to anon;
grant execute on function public.admin_end_round(text) to anon;
grant execute on function public.admin_list_captions(text) to anon;
grant execute on function public.admin_remove_caption(text, uuid) to anon;
grant execute on function public.admin_check_pass(text) to anon;

-- --------------------------------------------------- storage upload policy
-- Requires the 'caption-photos' bucket to exist first (see SETUP.md).
-- Anon may only CREATE jpegs under submissions/ — never read the bucket
-- listing, never overwrite, never delete. Public read happens through the
-- bucket's public URL, and pending photos are unguessable UUID names.
-- If this statement fails with "must be owner of table objects", create the
-- same policy in Dashboard → Storage → caption-photos → Policies instead.

create policy "caption photo submissions"
on storage.objects for insert to anon
with check (
  bucket_id = 'caption-photos'
  and name ~ '^submissions/[A-Za-z0-9-]+\.jpg$'
);
