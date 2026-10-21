// Touch for Studio's mouse-only drags on phones and tablets: moving the
// dashboard and map panels, and resizing the clip list. A one-finger drag that
// starts on one of them is replayed as mousedown / mousemove / mouseup, which
// is all those handlers listen for (on the map panel, as on the desktop, a
// one-finger drag moves the panel; two fingers zoom the map). Taps, scrolling
// and sliders are left to the browser.
(() => {
  if (!('ontouchstart' in window)) return;
  const HANDLES = '#dashboardVis, #dashboardVisCompact, #mapVis, .sidebar-resize-handle';
  const SKIP = 'button, input, select, textarea, a';
  let drag = null;

  const fire = (type, point, target) => target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window, button: 0, buttons: type === 'mouseup' ? 0 : 1,
    clientX: point.clientX, clientY: point.clientY, screenX: point.screenX, screenY: point.screenY
  }));

  document.addEventListener('touchstart', (e) => {
    if (drag?.moving) fire('mouseup', drag.start, drag.target); // a second finger ends the drag
    drag = null;
    if (e.touches.length !== 1 || !e.target.closest?.(HANDLES) || e.target.closest(SKIP)) return;
    const t = e.touches[0];
    drag = { target: e.target, start: { clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY }, moving: false };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!drag) return;
    if (e.touches.length !== 1) {
      if (drag.moving) fire('mouseup', drag.start, drag.target);
      drag = null;
      return;
    }
    const t = e.touches[0];
    if (!drag.moving) {
      if (Math.hypot(t.clientX - drag.start.clientX, t.clientY - drag.start.clientY) < 6) return;
      drag.moving = true;
      fire('mousedown', drag.start, drag.target);
    }
    e.preventDefault();
    fire('mousemove', t, drag.target);
  }, { passive: false });

  const end = (e) => {
    if (drag?.moving) {
      e.preventDefault(); // no click after a drag
      fire('mouseup', e.changedTouches[0] || drag.start, drag.target);
    }
    drag = null;
  };
  document.addEventListener('touchend', end, { passive: false });
  document.addEventListener('touchcancel', end, { passive: false });
})();
