const CARET_VIEWPORT_GAP_PX = 4;

export function shouldKeepPromptEditorCaretVisible(event, enabled) {
  return Boolean(
    enabled &&
    event?.key === 'Enter' &&
    event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229,
  );
}

export function nextPromptEditorScrollTop({
  caretBottom,
  caretTop,
  scrollTop,
  viewportBottom,
  viewportTop,
}, gap = CARET_VIEWPORT_GAP_PX) {
  if (caretBottom > viewportBottom - gap) {
    return scrollTop + caretBottom - viewportBottom + gap;
  }
  if (caretTop < viewportTop + gap) {
    return Math.max(0, scrollTop - (viewportTop + gap - caretTop));
  }
  return scrollTop;
}

export function schedulePromptEditorCaretScroll(view) {
  window.requestAnimationFrame(() => {
    const container = view.dom.closest('.prompt-editor-content');
    if (!container) return;
    const caret = view.coordsAtPos(view.state.selection.head);
    const viewport = container.getBoundingClientRect();
    container.scrollTop = nextPromptEditorScrollTop({
      caretBottom: caret.bottom,
      caretTop: caret.top,
      scrollTop: container.scrollTop,
      viewportBottom: viewport.bottom,
      viewportTop: viewport.top,
    });
  });
}
