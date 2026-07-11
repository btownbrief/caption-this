// CAPTION THIS — app shell: tabs, weekly round, results, photo submission.
import {
  rpc, photoUrl, uploadPhoto, resizeImage,
  playerId, playerToken, getName, setName,
} from './api.js';
import { createDeck } from './swipe.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => show(t, false), ms);
}

// ---------------- name picking (shared arcade identity) ----------------
function ensureName() {
  return new Promise((resolve) => {
    if (getName()) return resolve(getName());
    show($('name-modal'));
    $('name-input').focus();
    const save = () => {
      const v = $('name-input').value.trim();
      if (!v) return;
      setName(v);
      show($('name-modal'), false);
      resolve(getName());
    };
    $('name-save').onclick = save;
    $('name-input').onkeydown = (e) => { if (e.key === 'Enter') save(); };
  });
}

// ---------------- tabs ----------------
const views = { week: $('view-week'), results: $('view-results'), submit: $('view-submit') };
function goto(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('sel', b.dataset.tab === tab));
  Object.entries(views).forEach(([k, v]) => show(v, k === tab));
  if (tab === 'results') loadResults();
  if (tab === 'week') loadRound();
}
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => goto(b.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => goto(b.dataset.goto)));

function fmtDeadline(iso) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
}

// ---------------- THIS WEEK ----------------
let round = null;
let deck = null;

async function loadRound() {
  const panels = ['round-loading', 'round-none', 'round-caption', 'round-vote', 'round-upcoming'];
  panels.forEach((id) => show($(id), id === 'round-loading'));
  try {
    round = await rpc('get_current_round');
  } catch (e) {
    $('round-loading').textContent = 'Hmm, couldn’t reach the contest. Try again in a minute?';
    console.error(e);
    return;
  }
  show($('round-loading'), false);
  $('week-chip').textContent = round.photo
    ? `week of ${new Date(round.photo.week_of + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : '';

  if (!round.photo || round.phase === 'none') return show($('round-none'));
  if (round.phase === 'upcoming') return show($('round-upcoming'));
  if (round.phase === 'caption') return showCaptionPhase();
  if (round.phase === 'vote') return showVotePhase();
}

function showCaptionPhase() {
  show($('round-caption'));
  $('caption-photo').src = photoUrl(round.photo.storage_path);
  $('caption-credit').textContent = round.photo.credit ? `📷 ${round.photo.credit}` : '';
  show($('caption-credit'), Boolean(round.photo.credit));
  $('caption-deadline').textContent = `Captions close ${fmtDeadline(round.phase_ends_at)} — then Btown votes.`;
  $('caption-count-line').textContent =
    round.caption_count > 0 ? `${round.caption_count} caption${round.caption_count === 1 ? '' : 's'} in so far` : 'Be the first to caption it!';
}

$('caption-text').addEventListener('input', () => {
  $('caption-chars').textContent = String(140 - $('caption-text').value.length);
});

$('caption-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('caption-text').value.trim();
  if (!text) return;
  await ensureName();
  const btn = $('caption-submit');
  btn.disabled = true;
  try {
    await rpc('submit_caption', {
      p_photo: round.photo.id, p_player: playerId(), p_token: playerToken(),
      p_name: getName(), p_text: text,
    });
    show($('caption-done'));
    toast('Caption submitted! 🎤');
  } catch (err) {
    toast(err.message || 'Could not submit — try again?');
  }
  btn.disabled = false;
});

async function showVotePhase() {
  show($('round-vote'));
  $('vote-progress').textContent = '…';
  let data;
  try {
    data = await rpc('get_captions_to_swipe', { p_photo: round.photo.id, p_player: playerId() });
  } catch (e) {
    toast('Could not load captions — try again?');
    console.error(e);
    return;
  }
  let voted = data.voted;
  const total = data.total;
  const src = photoUrl(round.photo.storage_path);

  const progress = () => {
    $('vote-progress').textContent = total === 0 ? '' : `${voted} of ${total} judged`;
    show($('deck-empty'), deck && deck.remaining === 0);
    $('btn-undo').disabled = !deck?.canUndo;
    if (total === 0) $('deck-empty').querySelector('p').textContent =
      'No captions to judge yet (yours doesn’t count — no self-votes!). Check back soon.';
    if (deck?.remaining === 0) show($('deck-empty'));
  };

  deck = createDeck($('deck'), data.cards, {
    photoSrc: src,
    onVote: async (id, value) => {
      await rpc('vote_caption', {
        p_caption: id, p_player: playerId(), p_token: playerToken(), p_value: value,
      });
      voted += value === 0 ? -1 : 1;
    },
    onEmpty: () => show($('deck-empty')),
    onProgress: progress,
  });
  deck.render();
  progress();
}

$('btn-yep').onclick = () => deck?.vote(1);
$('btn-nope').onclick = () => deck?.vote(-1);
$('btn-undo').onclick = () => deck?.undo();

// ---------------- RESULTS ----------------
async function loadResults() {
  let data;
  try {
    data = await rpc('get_results');
  } catch (e) {
    toast('Could not load results');
    console.error(e);
    return;
  }
  const has = Boolean(data.photo);
  show($('results-none'), !has);
  show($('results-body'), has);
  if (!has) return;

  $('results-photo').src = photoUrl(data.photo.storage_path);
  $('results-credit').textContent = data.photo.credit ? `📷 ${data.photo.credit}` : '';
  $('results-stats').textContent =
    `${data.caption_count} captions · ${data.total_votes} swipes of judgment from Btown`;

  const list = $('results-list');
  list.textContent = '';
  (data.top || []).forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'result-row' + (i === 0 ? ' winner' : '');
    const net = document.createElement('div');
    net.className = 'net' + (row.net < 0 ? ' neg' : '');
    net.textContent = (row.net > 0 ? '+' : '') + row.net;
    const body = document.createElement('div');
    body.className = 'body';
    if (i === 0) {
      const tag = document.createElement('div');
      tag.className = 'winner-tag';
      tag.textContent = '🏆 WINNER · as seen in the BTown Brief';
      body.appendChild(tag);
    }
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = `“${row.text}”`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `— ${row.name} · 👍 ${row.up} / 👎 ${row.down}`;
    body.append(text, meta);
    const rank = document.createElement('div');
    rank.className = 'rank';
    rank.textContent = i === 0 ? '🏆' : `${i + 1}`;
    li.append(rank, body, net);
    list.appendChild(li);
  });
}

// ---------------- SUBMIT A PHOTO ----------------
let pendingBlob = null;

$('photo-input').addEventListener('change', async () => {
  const file = $('photo-input').files[0];
  if (!file) return;
  $('photo-status').className = 'hint';
  $('photo-status').textContent = 'Processing photo…';
  try {
    pendingBlob = await resizeImage(file);
    $('photo-preview').src = URL.createObjectURL(pendingBlob);
    show($('photo-preview'));
    show($('photo-drop-inner'), false);
    $('photo-submit').disabled = false;
    $('photo-status').textContent = '';
  } catch (e) {
    pendingBlob = null;
    $('photo-status').className = 'hint err';
    $('photo-status').textContent = 'Couldn’t read that image — try a different one?';
    console.error(e);
  }
});

$('photo-submit').addEventListener('click', async () => {
  if (!pendingBlob) return;
  const btn = $('photo-submit');
  btn.disabled = true;
  $('photo-status').className = 'hint';
  $('photo-status').textContent = 'Uploading…';
  try {
    const path = await uploadPhoto(pendingBlob);
    await rpc('submit_photo', {
      p_player: playerId(), p_token: playerToken(),
      p_path: path, p_credit: $('photo-credit').value,
    });
    $('photo-status').className = 'hint ok';
    $('photo-status').textContent =
      'Thanks! Photos are reviewed and usually go up within a day or two. 🙌';
    pendingBlob = null;
    $('photo-input').value = '';
    $('photo-credit').value = '';
    show($('photo-preview'), false);
    show($('photo-drop-inner'));
  } catch (e) {
    $('photo-status').className = 'hint err';
    $('photo-status').textContent = e.message || 'Upload failed — try again?';
    btn.disabled = false;
  }
});

// ---------------- go ----------------
loadRound();
