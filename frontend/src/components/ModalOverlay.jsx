import { createPortal } from 'react-dom';

export default function ModalOverlay({ children, className = '', onBackdropMouseDown }) {
  const portalTarget = globalThis.document?.body;
  if (!portalTarget) return null;

  const overlayClassName = ['modal-overlay', className].filter(Boolean).join(' ');
  return createPortal(
    <div
      className={overlayClassName}
      onMouseDown={onBackdropMouseDown
        ? (event) => event.target === event.currentTarget && onBackdropMouseDown(event)
        : undefined}
    >
      {children}
    </div>,
    portalTarget,
  );
}
