
import { useCallback, useEffect, useRef, useState } from 'react';


export function useMobileSidebar() {
  const [isMobileViewport, setIsMobileViewport] = useState(() => globalThis.matchMedia?.('(max-width: 760px)').matches || false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileMenuButtonRef = useRef(null);
  const sidebarRef = useRef(null);
  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
    globalThis.requestAnimationFrame?.(() => mobileMenuButtonRef.current?.focus());
  }, []);

  const openMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(true);
  }, []);

  useEffect(() => {
    if (!globalThis.matchMedia) return undefined;
    const mediaQuery = globalThis.matchMedia('(max-width: 760px)');
    const syncMobileViewport = (event) => {
      setIsMobileViewport(event.matches);
      if (!event.matches) setMobileSidebarOpen(false);
    };
    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener('change', syncMobileViewport);
    return () => mediaQuery.removeEventListener('change', syncMobileViewport);
  }, []);

  useEffect(() => {
    if (!isMobileViewport || !mobileSidebarOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFrame = globalThis.requestAnimationFrame?.(() => {
      sidebarRef.current?.querySelector(focusableSelector)?.focus();
    });
    const handleDrawerKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileSidebar();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(sidebarRef.current?.querySelectorAll(focusableSelector) || []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleDrawerKeyDown);
    return () => {
      if (focusFrame) globalThis.cancelAnimationFrame?.(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleDrawerKeyDown);
    };
  }, [closeMobileSidebar, isMobileViewport, mobileSidebarOpen]);

  return { isMobileViewport, mobileSidebarOpen, setMobileSidebarOpen, mobileMenuButtonRef, sidebarRef, closeMobileSidebar, openMobileSidebar };
}
