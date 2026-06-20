const DEFAULT_MENU_WIDTH = 132;
const DEFAULT_MENU_HEIGHT = 44;
const DEFAULT_GAP = 6;
const DEFAULT_MARGIN = 8;

export function placeFloatingMenu({ anchorRect, menuRect = {}, viewport, gap = DEFAULT_GAP, margin = DEFAULT_MARGIN }) {
  const menuWidth = dimension(menuRect.width, DEFAULT_MENU_WIDTH);
  const menuHeight = dimension(menuRect.height, DEFAULT_MENU_HEIGHT);
  const viewportWidth = dimension(viewport?.width, DEFAULT_MENU_WIDTH + margin * 2);
  const viewportHeight = dimension(viewport?.height, DEFAULT_MENU_HEIGHT + margin * 2);
  const horizontal = chooseHorizontalPosition(anchorRect, menuWidth, viewportWidth, margin);
  const vertical = chooseVerticalPosition(anchorRect, menuHeight, viewportHeight, gap, margin);

  return {
    left: clamp(horizontal.left, margin, viewportWidth - menuWidth - margin),
    top: clamp(vertical.top, margin, viewportHeight - menuHeight - margin),
    placement: `${vertical.side}-${horizontal.align}`,
  };
}

function chooseHorizontalPosition(anchorRect, menuWidth, viewportWidth, margin) {
  const candidates = [
    { align: 'end', left: anchorRect.right - menuWidth },
    { align: 'start', left: anchorRect.left },
    { align: 'center', left: anchorRect.left + anchorRect.width / 2 - menuWidth / 2 },
  ];
  return candidates.reduce((best, candidate) => {
    const candidateScore = overflowScore(candidate.left, menuWidth, viewportWidth, margin);
    const bestScore = overflowScore(best.left, menuWidth, viewportWidth, margin);
    return candidateScore < bestScore ? candidate : best;
  });
}

function chooseVerticalPosition(anchorRect, menuHeight, viewportHeight, gap, margin) {
  const roomBelow = viewportHeight - anchorRect.bottom - margin;
  const roomAbove = anchorRect.top - margin;
  const side = roomBelow >= menuHeight + gap || roomBelow >= roomAbove ? 'bottom' : 'top';
  return {
    side,
    top: side === 'bottom' ? anchorRect.bottom + gap : anchorRect.top - menuHeight - gap,
  };
}

function overflowScore(left, width, viewportWidth, margin) {
  return Math.max(margin - left, 0) + Math.max(left + width + margin - viewportWidth, 0);
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function dimension(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
