import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { placeFloatingMenu } from '../utils/floatingMenu';

export default function IssueCardMoreActions({ issue, canDelete, canEdit, onRequestDelete, onRequestEdit }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState(null);
  const [triggerElement, setTriggerElement] = useState(null);
  const [menuElement, setMenuElement] = useState(null);
  const hasActions = canDelete || canEdit;

  const updateMenuPosition = useCallback(() => {
    if (!triggerElement || typeof window === 'undefined') return;
    const anchorRect = triggerElement.getBoundingClientRect();
    const menuRect = menuElement?.getBoundingClientRect();
    setMenuPosition(placeFloatingMenu({
      anchorRect,
      menuRect,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }));
  }, [menuElement, triggerElement]);

  useLayoutEffect(() => {
    if (moreOpen) updateMenuPosition();
  }, [moreOpen, updateMenuPosition]);

  useEffect(() => {
    if (!moreOpen) return undefined;
    return bindFloatingMenuListeners({ triggerElement, menuElement, setMoreOpen, updateMenuPosition });
  }, [menuElement, moreOpen, triggerElement, updateMenuPosition]);

  if (!hasActions) return null;
  return (
    <MoreActionsButton issue={issue} setTriggerElement={setTriggerElement} moreOpen={moreOpen} setMoreOpen={setMoreOpen}>
      {moreOpen && (
        <IssueMoreMenu
          issue={issue}
          setMenuElement={setMenuElement}
          menuPosition={menuPosition}
          canEdit={canEdit}
          canDelete={canDelete}
          setMoreOpen={setMoreOpen}
          onRequestEdit={onRequestEdit}
          onRequestDelete={onRequestDelete}
        />
      )}
    </MoreActionsButton>
  );
}

function MoreActionsButton({ issue, setTriggerElement, moreOpen, setMoreOpen, children }) {
  const menuId = `issue-${issue.id}-more-menu`;
  const toggleMenu = (event) => {
    event.stopPropagation();
    setMoreOpen(open => !open);
  };
  return (
    <div className="kanban-card-more" onClick={(event) => event.stopPropagation()}>
      <button
        ref={setTriggerElement}
        type="button"
        className="kanban-card-more-trigger"
        aria-label={`更多操作：Issue #${issue.id}`}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-controls={menuId}
        onClick={toggleMenu}
      >
        <MoreHorizontal size={14} />
      </button>
      {moreOpen && children}
    </div>
  );
}

function IssueMoreMenu({ issue, setMenuElement, menuPosition, canEdit, canDelete, setMoreOpen, onRequestEdit, onRequestDelete }) {
  if (typeof document === 'undefined') return null;
  const closeWithAction = (event, action) => {
    event.stopPropagation();
    setMoreOpen(false);
    action?.(event, issue);
  };
  return createPortal(
    <div
      ref={setMenuElement}
      id={`issue-${issue.id}-more-menu`}
      className="kanban-card-more-menu floating"
      role="menu"
      aria-label={`Issue #${issue.id} 更多操作`}
      data-placement={menuPosition?.placement || 'bottom-end'}
      style={floatingMenuStyle(menuPosition)}
    >
      {canEdit && <MenuItem icon={<Pencil size={13} />} label="Edit" onClick={(event) => closeWithAction(event, onRequestEdit)} />}
      {canDelete && (
        <MenuItem danger icon={<Trash2 size={13} />} label="Delete" onClick={(event) => closeWithAction(event, onRequestDelete)} />
      )}
    </div>,
    document.body
  );
}

function MenuItem({ danger = false, icon, label, onClick }) {
  return (
    <button type="button" className={`kanban-card-more-item ${danger ? 'danger' : ''}`.trim()} role="menuitem" onClick={onClick}>
      {icon} {label}
    </button>
  );
}

function bindFloatingMenuListeners({ triggerElement, menuElement, setMoreOpen, updateMenuPosition }) {
  const closeOutside = (event) => {
    if (triggerElement?.contains(event.target) || menuElement?.contains(event.target)) return;
    setMoreOpen(false);
  };
  const closeOnEscape = (event) => {
    if (event.key === 'Escape') setMoreOpen(false);
  };
  document.addEventListener('pointerdown', closeOutside);
  document.addEventListener('keydown', closeOnEscape);
  window.addEventListener('resize', updateMenuPosition);
  window.addEventListener('scroll', updateMenuPosition, true);
  return () => {
    document.removeEventListener('pointerdown', closeOutside);
    document.removeEventListener('keydown', closeOnEscape);
    window.removeEventListener('resize', updateMenuPosition);
    window.removeEventListener('scroll', updateMenuPosition, true);
  };
}

function floatingMenuStyle(position) {
  if (!position) return { left: '-9999px', top: '-9999px' };
  return { left: `${position.left}px`, top: `${position.top}px` };
}
