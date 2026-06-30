// ============================================================
// modalGuard — stop accidental "click outside to close" on dialogs.
//
// Most dialogs render <div class="wx-modal-backdrop" onClick={onClose}>
// with the modal content inside calling stopPropagation(). That means a
// click landing DIRECTLY on the dim backdrop closes the dialog — easy to
// trigger by accident while filling a form (e.g. Boss adding an employee).
//
// Rather than edit ~40 dialogs, we install ONE capture-phase listener on
// document. React 19 delegates events at the #root container, so a
// capture-phase document listener runs FIRST; if the event target IS the
// backdrop element itself (not a child — children's clicks are stopped by
// the modal's own stopPropagation before they'd reach here anyway), we
// stop propagation so React's delegated onClose never fires.
//
// Deliberately NOT touched: the cross/close button and action buttons
// (they live inside .wx-modal and have their own handlers), and the Esc
// key (a deliberate keypress, left working as a quick close). Mousedown is
// also guarded because a press-and-drag that ends off-backdrop can still
// register, and some UIs act on mousedown.
// ============================================================

function isBackdrop(el) {
  return el && el.classList && el.classList.contains('wx-modal-backdrop');
}

// Block only clicks that land squarely on the backdrop itself.
function onBackdropEvent(e) {
  if (isBackdrop(e.target)) {
    e.stopPropagation();
    // stopImmediatePropagation guards against any other capture listener
    // (or React's root) still seeing it.
    e.stopImmediatePropagation?.();
  }
}

let installed = false;
export function installModalGuard() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // Capture phase (3rd arg true) so we intercept before React's root handler.
  document.addEventListener('mousedown', onBackdropEvent, true);
  document.addEventListener('click', onBackdropEvent, true);
}
