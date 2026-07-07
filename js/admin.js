// Editor's Desk: approve/reject/promote photos, moderate captions.
// The passphrase is verified server-side by every admin RPC; after the
// first successful unlock it's kept in localStorage for convenience.
import { rpc, photoUrl } from './api.js';

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const PASS_KEY = 'caption-admin-pass';
let pass = localStorage.getItem(PASS_KEY) || '';

function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => show(t, false), ms);
}

async function unlock(candidate) {
  $('gate-status').textContent = 'Checking…';
  try {
    const ok = await rpc('admin_check_pass', { p_pass: candidate });
    if (!ok) {
      $('gate-status').textContent = 'Nope — that’s not it.';
      return;
    }
    pass = candidate;
    localStorage.setItem(PASS_KEY, pass);
    show($('gate'), false);
    show($('dash'));
    refresh();
  } catch (e) {
    $('gate-status').textContent = 'Could not reach the server.';
    console.error(e);
  }
}

$('pass-go').onclick = () => unlock($('pass-input').value);
$('pass-input').onkeydown = (e) => { if (e.key === 'Enter') unlock($('pass-input').value); };
$('lock-btn').onclick = () => {
  localStorage.removeItem(PASS_KEY);
  location.reload();
};

function photoCard(p, actions) {
  const card = document.createElement('div');
  card.className = 'admin-card';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = photoUrl(p.storage_path);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = p.credit ? `📷 ${p.credit}` : '(no credit line)';
  const row = document.createElement('div');
  row.className = 'admin-actions';
  for (const [label, cls, fn] of actions) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); toast('Done ✓'); refresh(); }
      catch (e) { toast(e.message); b.disabled = false; }
    };
    row.appendChild(b);
  }
  card.append(img, meta, row);
  return card;
}

async function refresh() {
  let data;
  try {
    data = await rpc('admin_list_photos', { p_pass: pass });
  } catch (e) {
    toast(e.message || 'Failed to load');
    if (/passphrase/i.test(e.message || '')) $('lock-btn').click();
    return;
  }

  // pending
  const pend = $('pending-list');
  pend.textContent = '';
  data.pending.forEach((p) => pend.appendChild(photoCard(p, [
    ['✅ Approve', 'good', () => rpc('admin_approve_photo', { p_pass: pass, p_photo: p.id })],
    ['🗑️ Reject', 'danger', () => rpc('admin_reject_photo', { p_pass: pass, p_photo: p.id })],
  ])));
  show($('pending-empty'), data.pending.length === 0);
  $('pending-badge').textContent = data.pending.length;
  show($('pending-badge'), data.pending.length > 0);

  // live round
  const live = $('live-card');
  live.textContent = '';
  if (data.live) {
    const card = photoCard(data.live, []);
    const meta = card.querySelector('.meta');
    const capUntil = new Date(data.live.captions_until).toLocaleString();
    const voteUntil = new Date(data.live.votes_until).toLocaleString();
    meta.textContent =
      `phase: ${data.live.phase} · ${data.live.caption_count} captions · ` +
      `captions until ${capUntil} · round ends ${voteUntil}` +
      (meta.textContent !== '(no credit line)' ? ` · ${meta.textContent}` : '');
    live.appendChild(card);
  } else {
    live.innerHTML = '<div class="hint">No live round.</div>';
  }
  show($('live-actions'), Boolean(data.live));

  // approved queue
  const q = $('queue-list');
  q.textContent = '';
  data.queue.forEach((p, i) => {
    const card = photoCard(p, [
      ['🚀 Make live now', 'ghost', () => {
        if (!confirm('End the current round (if any) and put this photo live?')) throw new Error('cancelled');
        return rpc('admin_promote_photo', { p_pass: pass, p_photo: p.id });
      }],
      ['🗑️ Reject', 'danger', () => rpc('admin_reject_photo', { p_pass: pass, p_photo: p.id })],
    ]);
    card.querySelector('.meta').textContent =
      `#${i + 1} in line · ${card.querySelector('.meta').textContent}`;
    q.appendChild(card);
  });
  show($('queue-empty'), data.queue.length === 0);

  // captions on live photo
  let caps = [];
  try { caps = await rpc('admin_list_captions', { p_pass: pass }); } catch { /* no live round */ }
  const cl = $('caption-list');
  cl.textContent = '';
  caps.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'admin-caption-row';
    const body = document.createElement('div');
    body.className = 'body';
    const text = document.createElement('div');
    text.textContent = `“${c.text}”`;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = `— ${c.name} · net ${c.net >= 0 ? '+' : ''}${c.net}`;
    body.append(text, who);
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '✕';
    del.onclick = async () => {
      if (!confirm(`Remove this caption by ${c.name}?`)) return;
      try {
        await rpc('admin_remove_caption', { p_pass: pass, p_caption: c.id });
        toast('Removed');
        row.remove();
      } catch (e) { toast(e.message); }
    };
    row.append(body, del);
    cl.appendChild(row);
  });
  show($('caption-empty'), caps.length === 0);
}

$('btn-open-voting').onclick = async () => {
  if (!confirm('Close caption submissions and start voting right now?')) return;
  try { await rpc('admin_open_voting', { p_pass: pass }); toast('Voting is open 🔥'); refresh(); }
  catch (e) { toast(e.message); }
};
$('btn-end-round').onclick = async () => {
  if (!confirm('End the round NOW? Results become final and the next photo goes live.')) return;
  try { await rpc('admin_end_round', { p_pass: pass }); toast('Round ended 🏁'); refresh(); }
  catch (e) { toast(e.message); }
};
$('refresh-btn').onclick = refresh;

// auto-unlock if a stored passphrase works
if (pass) unlock(pass);
