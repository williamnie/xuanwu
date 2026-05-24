import { useCallback, useEffect, useRef, useState } from 'react';

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48;

export function getScrollBottomDistance(element) {
  if (!element) return 0;
  const scrollHeight = Number(element.scrollHeight) || 0;
  const scrollTop = Number(element.scrollTop) || 0;
  const clientHeight = Number(element.clientHeight) || 0;
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function isNearScrollBottom(element, threshold = AUTO_SCROLL_BOTTOM_THRESHOLD_PX) {
  return getScrollBottomDistance(element) <= threshold;
}

export function scrollToBottom(element, behavior = 'auto') {
  if (!element) return;
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top: element.scrollHeight, behavior });
    return;
  }
  element.scrollTop = element.scrollHeight;
}

export function useSmartAutoScroll({ resetKey, watchKey }) {
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const frameRef = useRef(0);
  const shouldFollowRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const scheduleScrollToBottom = useCallback((behavior = 'auto') => {
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      scrollToBottom(scrollRef.current, behavior);
      shouldFollowRef.current = true;
      setShowScrollButton(false);
    });
  }, []);

  const updateFollowState = useCallback(() => {
    const nearBottom = isNearScrollBottom(scrollRef.current);
    shouldFollowRef.current = nearBottom;
    setShowScrollButton(!nearBottom);
    return nearBottom;
  }, []);

  const handleScroll = useCallback(() => {
    if (!updateFollowState()) {
      window.cancelAnimationFrame(frameRef.current);
    }
  }, [updateFollowState]);

  const scrollToLatest = useCallback(() => {
    scheduleScrollToBottom('auto');
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    shouldFollowRef.current = true;
    setShowScrollButton(false);
    scheduleScrollToBottom('auto');
  }, [resetKey, scheduleScrollToBottom]);

  useEffect(() => {
    if (shouldFollowRef.current) scheduleScrollToBottom('auto');
  }, [watchKey, scheduleScrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (shouldFollowRef.current) scheduleScrollToBottom('auto');
      else updateFollowState();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [resetKey, scheduleScrollToBottom, updateFollowState]);

  useEffect(() => () => {
    window.cancelAnimationFrame(frameRef.current);
  }, []);

  return { scrollRef, contentRef, showScrollButton, handleScroll, scrollToLatest };
}
