// CAPTION THIS — app shell: tabs, weekly round, results, photo submission.
import {
  rpc, photoUrl, uploadPhoto, resizeImage,
  playerId, playerToken, getName, setName,
} from './api.js';
import { createDeck } from './swipe.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function toast(msg, type = 'info', ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.className = type;
  show(t);
  if (!reducedMotion.matches) {
    void t.offsetWidth;
    t.classList.add('toast-in');
  }
  clearTimeout(toast._hide);
  clearTimeout(toast._remove);
  toast._hide = setTimeout(() => {
    if (reducedMotion.matches) return show(t, false);
    t.classList.remove('toast-in');
    t.classList.add('toast-out');
    toast._remove = setTimeout(() => show(t, false), 180);
  }, ms);
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
  if (tab !== 'week') {
    roundRunId += 1;
    deck?.destroy();
    deck = null;
  }
  if (tab !== 'results') cancelResultsEffects();
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
let roundRunId = 0;

async function loadRound() {
  const activeRun = ++roundRunId;
  const panels = ['round-loading', 'round-none', 'round-caption', 'round-vote', 'round-upcoming'];
  panels.forEach((id) => show($(id), id === 'round-loading'));
  let data;
  try {
    data = await rpc('get_current_round');
  } catch (e) {
    if (activeRun !== roundRunId) return;
    $('round-loading').textContent = 'Hmm, couldn’t reach the contest. Try again in a minute?';
    console.error(e);
    return;
  }
  if (activeRun !== roundRunId) return;
  round = data;
  show($('round-loading'), false);
  $('week-chip').textContent = round.photo
    ? `week of ${new Date(round.photo.week_of + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : '';

  if (!round.photo || round.phase === 'none') return show($('round-none'));
  if (round.phase === 'upcoming') return show($('round-upcoming'));
  if (round.phase === 'caption') return showCaptionPhase();
  if (round.phase === 'vote') return showVotePhase(activeRun);
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
    toast('Caption submitted! 🎤', 'success');
  } catch (err) {
    toast(err.message || 'Could not submit — try again?', 'error');
  }
  btn.disabled = false;
});

async function showVotePhase(activeRun) {
  deck?.destroy();
  deck = null;
  show($('round-vote'));
  $('vote-progress-label').textContent = 'Loading captions…';
  $('vote-progress-label').classList.remove('count-pop');
  $('vote-progress-track').classList.remove('animating');
  show($('vote-progress-track'));
  $('vote-progress-fill').style.width = '0%';
  let data;
  try {
    data = await rpc('get_captions_to_swipe', { p_photo: round.photo.id, p_player: playerId() });
  } catch (e) {
    if (activeRun !== roundRunId) return;
    toast('Could not load captions — try again?', 'error');
    console.error(e);
    return;
  }
  if (activeRun !== roundRunId) return;
  let voted = data.voted;
  const total = data.total;
  const src = photoUrl(round.photo.storage_path);

  const progress = ({ animate = false } = {}) => {
    const label = $('vote-progress-label');
    const track = $('vote-progress-track');
    const fill = $('vote-progress-fill');
    const percent = total === 0 ? 0 : Math.min(100, (voted / total) * 100);
    label.textContent = total === 0 ? '' : `${voted} of ${total} judged`;
    track.style.setProperty('--segments', Math.max(1, Math.min(total, 30)));
    track.setAttribute('aria-valuemax', String(total));
    track.setAttribute('aria-valuenow', String(voted));
    show(track, total > 0);
    track.classList.toggle('animating', animate && !reducedMotion.matches);
    fill.style.width = `${percent}%`;
    if (animate && !reducedMotion.matches) {
      label.classList.remove('count-pop');
      void label.offsetWidth;
      label.classList.add('count-pop');
    } else {
      label.classList.remove('count-pop');
    }
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
}

$('btn-yep').onclick = () => deck?.vote(1);
$('btn-nope').onclick = () => deck?.vote(-1);
$('btn-undo').onclick = () => deck?.undo();

// ---------------- RESULTS ----------------
let resultsRunId = 0;
let resultsTimers = [];
const revealedResults = new Set();

function cancelResultsEffects() {
  resultsRunId += 1;
  resultsTimers.forEach(clearTimeout);
  resultsTimers = [];
}

function formatNet(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

// Ported from higher-or-lower's short, eased score count.
function countUp(el, target, ms, activeRun) {
  if (reducedMotion.matches || ms === 0) {
    el.textContent = formatNet(target);
    return;
  }
  const started = performance.now();
  let frame = null;
  let fallback = null;
  const finish = (showTarget = true) => {
    if (frame) cancelAnimationFrame(frame);
    if (fallback) clearTimeout(fallback);
    frame = null;
    fallback = null;
    if (showTarget && activeRun === resultsRunId) el.textContent = formatNet(target);
  };
  el.textContent = '0';
  const tick = (now) => {
    if (activeRun !== resultsRunId) return finish(false);
    const progress = Math.min((now - started) / ms, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatNet(Math.round(target * eased));
    if (progress < 1) frame = requestAnimationFrame(tick);
    else finish();
  };
  frame = requestAnimationFrame(tick);
  fallback = setTimeout(finish, ms + 400);
}

function shouldRevealResults(photoId) {
  const key = `caption-results-revealed:${photoId}`;
  if (revealedResults.has(key)) return false;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch { /* the in-memory guard still prevents a replay */ }
  revealedResults.add(key);
  return true;
}

async function loadResults() {
  cancelResultsEffects();
  const activeRun = resultsRunId;
  let data;
  try {
    data = await rpc('get_results');
  } catch (e) {
    if (activeRun !== resultsRunId) return;
    toast('Could not load results', 'error');
    console.error(e);
    return;
  }
  if (activeRun !== resultsRunId) return;
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
  const rows = data.top || [];
  const reveal = shouldRevealResults(data.photo.id) && !reducedMotion.matches;
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'result-row' + (i === 0 ? ' winner' : '');
    const net = document.createElement('div');
    net.className = 'net' + (row.net < 0 ? ' neg' : '');
    net.textContent = reveal ? '0' : formatNet(row.net);
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
    if (reveal) {
      const delay = (rows.length - 1 - i) * 60;
      li.classList.add('reveal-row');
      li.style.animationDelay = `${delay}ms`;
      const timer = setTimeout(() => {
        if (activeRun === resultsRunId) countUp(net, row.net, 520, activeRun);
      }, delay);
      resultsTimers.push(timer);
    }
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
