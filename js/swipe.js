// Tinder-style swipe deck. Cards are the week's photo with each caption
// overlaid; drag right = 👍 (+1), left = 👎 (-1). Exposes button voting and
// single-level undo (which retracts the vote server-side via onVote(id, 0)).

const THRESHOLD = 0.28;   // fraction of deck width to commit a swipe
const MAX_STACK = 3;      // rendered cards at once

export function createDeck(deckEl, cards, { photoSrc, onVote, onEmpty, onProgress }) {
  const queue = [...cards];
  let lastVoted = null;     // { card, value } for undo
  let busy = false;

  function makeCardEl(card) {
    const el = document.createElement('div');
    el.className = 'card';
    el.style.backgroundImage = `url("${photoSrc}")`;
    el.innerHTML = `
      <div class="stamp yep">👍 YEP</div>
      <div class="stamp nope">👎 NOPE</div>
      <div class="card-caption">
        <div class="card-text"></div>
        <div class="card-name"></div>
      </div>`;
    el.querySelector('.card-text').textContent = `“${card.text}”`;
    el.querySelector('.card-name').textContent = `— ${card.name}`;
    el.dataset.id = card.id;
    return el;
  }

  function render() {
    deckEl.textContent = '';
    queue.slice(0, MAX_STACK).forEach((card, i) => {
      const el = makeCardEl(card);
      el.style.zIndex = MAX_STACK - i;
      el.style.transform = `translateY(${i * 10}px) scale(${1 - i * 0.035})`;
      deckEl.prepend(el);
      if (i === 0) attachDrag(el, card);
    });
    if (queue.length === 0) onEmpty?.();
    onProgress?.();
  }

  function flyOut(el, value, fromX = 0, fromY = 0) {
    const dir = value > 0 ? 1 : -1;
    el.style.transition = 'transform .35s ease, opacity .35s ease';
    el.style.transform =
      `translate(${dir * (deckEl.clientWidth * 1.3)}px, ${fromY - 40}px) rotate(${dir * 24}deg)`;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 360);
  }

  async function commit(card, value, el, x = 0, y = 0) {
    if (busy) return;
    busy = true;
    queue.shift();
    if (el) flyOut(el, value, x, y);
    lastVoted = { card, value };
    try {
      await onVote(card.id, value);
    } catch (e) {
      // put the card back so the vote isn't silently lost
      queue.unshift(card);
      lastVoted = null;
      console.warn(e);
    }
    busy = false;
    render();
  }

  function attachDrag(el, card) {
    el.classList.add('top');
    let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

    el.addEventListener('pointerdown', (e) => {
      if (busy) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY; dx = 0; dy = 0;
      el.classList.add('dragging');
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dx = e.clientX - startX; dy = e.clientY - startY;
      const rot = dx / 18;
      el.style.transform = `translate(${dx}px, ${dy * 0.4}px) rotate(${rot}deg)`;
      const strength = Math.min(1, Math.abs(dx) / (deckEl.clientWidth * THRESHOLD));
      el.querySelector('.stamp.yep').style.opacity = dx > 0 ? strength : 0;
      el.querySelector('.stamp.nope').style.opacity = dx < 0 ? strength : 0;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if (Math.abs(dx) > deckEl.clientWidth * THRESHOLD) {
        commit(card, dx > 0 ? 1 : -1, el, dx, dy * 0.4);
      } else {
        el.style.transition = 'transform .25s ease';
        el.style.transform = '';
        el.querySelector('.stamp.yep').style.opacity = 0;
        el.querySelector('.stamp.nope').style.opacity = 0;
        setTimeout(() => { el.style.transition = ''; }, 260);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  return {
    vote(value) {   // button fallback for the top card
      if (busy || queue.length === 0) return;
      const el = deckEl.querySelector('.card.top');
      commit(queue[0], value, el);
    },
    async undo() {
      if (busy || !lastVoted) return;
      busy = true;
      const { card } = lastVoted;
      lastVoted = null;
      try {
        await onVote(card.id, 0);      // retract server-side
        queue.unshift(card);
      } catch (e) { console.warn(e); }
      busy = false;
      render();
    },
    get canUndo() { return Boolean(lastVoted); },
    get remaining() { return queue.length; },
    render,
  };
}
