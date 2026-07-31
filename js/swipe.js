// Tinder-style swipe deck. Cards are the week's photo with each caption
// overlaid; drag right = 👍 (+1), left = 👎 (-1). Exposes button voting and
// single-level undo (which retracts the vote server-side via onVote(id, 0)).

const THRESHOLD = 0.28;   // fraction of deck width to commit a swipe
const MAX_STACK = 3;      // rendered cards at once

export function createDeck(deckEl, cards, { photoSrc, onVote, onEmpty, onProgress }) {
  const queue = [...cards];
  let lastVoted = null;     // { card, value } for undo
  let busy = false;
  let active = true;
  let settleTimer = null;

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

  function render({ settleTop = false, animateProgress = false } = {}) {
    if (!active) return;
    deckEl.textContent = '';
    queue.slice(0, MAX_STACK).forEach((card, i) => {
      const el = makeCardEl(card);
      el.style.zIndex = MAX_STACK - i;
      el.style.transform = `translateY(${i * 10}px) scale(${1 - i * 0.035})`;
      deckEl.prepend(el);
      if (i === 0) {
        if (settleTop) el.classList.add('spring-in');
        attachDrag(el, card);
      }
    });
    if (queue.length === 0) onEmpty?.();
    onProgress?.({ animate: animateProgress });
  }

  function flyOut(el, value, fromX = 0, fromY = 0) {
    const dir = value > 0 ? 1 : -1;
    el.querySelector(value > 0 ? '.stamp.yep' : '.stamp.nope').classList.add('punch');
    el.style.transition = 'transform .22s ease-out, opacity .22s ease-out';
    el.style.transform =
      `translate(${dir * (deckEl.clientWidth * 1.3)}px, ${fromY - 40}px) rotate(${dir * 24}deg)`;
    el.style.opacity = '0';
  }

  async function commit(card, value, el, x = 0, y = 0) {
    if (busy) return;
    busy = true;
    try {
      await onVote(card.id, value);
      if (!active) return;
      queue.shift();
      lastVoted = { card, value };
      if (el) flyOut(el, value, x, y);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!active) return;
        busy = false;
        render({ settleTop: true, animateProgress: true });
      }, el ? 225 : 0);
    } catch (e) {
      if (!active) return;
      lastVoted = null;
      if (el) {
        el.style.transition = 'transform .2s ease-out';
        el.style.transform = '';
        el.querySelectorAll('.stamp').forEach((stamp) => { stamp.style.opacity = 0; });
      }
      busy = false;
      console.warn(e);
    }
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
      try {
        await onVote(card.id, 0);      // retract server-side
        if (!active) return;
        lastVoted = null;
        queue.unshift(card);
        busy = false;
        render({ animateProgress: true });
      } catch (e) {
        busy = false;
        console.warn(e);
      }
    },
    destroy() {
      active = false;
      clearTimeout(settleTimer);
    },
    get canUndo() { return Boolean(lastVoted); },
    get remaining() { return queue.length; },
    render,
  };
}
