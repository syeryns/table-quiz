// Pointer Events로 만든 끌어다 놓기. HTML5 drag-and-drop은 iPad 터치에서 불안정하다.
//
// root 안의 [data-card] 요소를 끌어 [data-slot] 요소에 놓는다.
//   onDrop(cardId, slotId | null)  슬롯 밖에 놓으면 null
//   onTapCard(cardId), onTapSlot(slotId)  탭 방식 (카드 탭 → 슬롯 탭)
//   onLongPress(cardEl)  길게 누르면 확대 미리보기, 손을 떼면 onLongPressEnd()

const SLOP = 6;
const LONG_PRESS_MS = 450;

export function enableDnD(root, handlers) {
  let g = null; // 진행 중인 동작

  const slotAt = (x, y) => document.elementFromPoint(x, y)?.closest('[data-slot]');

  const setOver = (slot) => {
    if (g.over === slot) return;
    g.over?.classList.remove('over');
    g.over = slot && !slot.hasAttribute('data-locked') ? slot : null;
    g.over?.classList.add('over');
  };

  const startDrag = () => {
    const r = g.el.getBoundingClientRect();
    const ghost = g.el.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.append(ghost);
    g.ghost = ghost;
    g.offset = { x: g.start.x - r.left, y: g.start.y - r.top };
    g.el.classList.add('dragging');
    g.dragging = true;
    moveGhost(g.start.x, g.start.y);
  };

  const moveGhost = (x, y) => {
    g.ghost.style.transform = `translate(${x - g.offset.x}px, ${y - g.offset.y}px) scale(1.05)`;
  };

  const end = () => {
    clearTimeout(g.timer);
    g.ghost?.remove();
    g.el?.classList.remove('dragging');
    g.over?.classList.remove('over');
    g = null;
  };

  root.addEventListener('pointerdown', (e) => {
    if (g || e.button > 0) return;
    const el = e.target.closest('[data-card]');
    if (el && !el.hasAttribute('data-locked') && root.contains(el) && !handlers.disabled?.()) {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      g = { el, id: el.dataset.card, pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, dragging: false, long: false };
      g.timer = setTimeout(() => {
        if (!g || g.dragging) return;
        g.long = true;
        handlers.onLongPress?.(g.el);
      }, LONG_PRESS_MS);
      return;
    }
    const slot = e.target.closest('[data-slot]');
    if (slot && root.contains(slot)) {
      g = { slot, pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY } };
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.pointerId || !g.el || g.long) return;
    if (!g.dragging) {
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) < SLOP) return;
      clearTimeout(g.timer);
      startDrag();
    }
    moveGhost(e.clientX, e.clientY);
    // 손가락 아래 요소를 찾을 때 유령 카드는 건너뛴다 (pointer-events: none)
    setOver(slotAt(e.clientX, e.clientY));
  });

  const finish = (e, cancelled) => {
    if (!g || e.pointerId !== g.pointerId) return;
    const cur = g;
    if (cur.long) {
      end();
      handlers.onLongPressEnd?.();
      return;
    }
    if (cur.el && cur.dragging) {
      const slot = cancelled ? null : (cur.over || null);
      end();
      if (!cancelled) handlers.onDrop?.(cur.id, slot ? slot.dataset.slot : null);
      return;
    }
    end();
    if (cancelled) return;
    if (cur.el) handlers.onTapCard?.(cur.id);
    else if (cur.slot) handlers.onTapSlot?.(cur.slot.dataset.slot);
  };
  root.addEventListener('pointerup', (e) => finish(e, false));
  root.addEventListener('pointercancel', (e) => finish(e, true));
  // 길게 누를 때 iOS 메뉴가 뜨지 않게
  root.addEventListener('contextmenu', (e) => e.preventDefault());
}
