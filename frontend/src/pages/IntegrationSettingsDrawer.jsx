import { useEffect, useLayoutEffect, useRef } from 'react';
import ModalOverlay from '../components/ModalOverlay.jsx';
import { useI18n } from '../i18n/context.js';

export default function IntegrationSettingsDrawer({ children, onClose, open, title }) {
  const { language } = useI18n();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const bodyRef = useRef(null);
  useLayoutEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, title]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const handleKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...dialogRef.current.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex="0"]')]
        .filter(element => !element.disabled && element.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose, open]);
  return (
    <ModalOverlay className={`settings-connection-overlay${open ? '' : ' is-closed'}`} onBackdropMouseDown={onClose}>
      <section className="modal-content settings-connection-drawer" role="dialog" aria-modal="true" aria-labelledby="connection-drawer-title" ref={dialogRef}>
        <header className="settings-connection-drawer-header">
          <h2 id="connection-drawer-title">{title} · {language === 'en-US' ? 'Settings' : '设置'}</h2>
          <button className="btn btn-secondary" type="button" onClick={onClose} ref={closeRef}>{language === 'en-US' ? 'Close' : '关闭'}</button>
        </header>
        <div className="settings-connection-drawer-body" ref={bodyRef}>{children}</div>
      </section>
    </ModalOverlay>
  );
}
