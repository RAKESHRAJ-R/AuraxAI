import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// A centred dialog over a dimmed page. Closes on Escape or a click on the backdrop,
// unless `busy` (a save in flight) — closing then would hide the result of the save.
//
// Portalled to <body> on purpose: every page root carries the `.fade` entrance animation,
// and an element with a (filled) transform animation becomes the containing block for
// position:fixed descendants — rendered in place, the backdrop only covered the page body
// and the dialog was clipped at its bottom edge.
export default function Modal({ title, onClose, busy = false, wide = false, children, footer }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose, busy]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={'modal card fade' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button className="modal-x" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
