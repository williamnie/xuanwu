import { useCallback, useEffect, useRef, useState } from 'react';
import { commandCenterApi } from '../../api/commandCenter.js';
import { eventsApi } from '../../api/events.js';
import { createInboxController, inboxInitialState } from './inboxController.js';

export function useInbox() {
  const [state, setState] = useState(inboxInitialState);
  const ref = useRef(null);
  useEffect(() => {
    const controller = createInboxController({ fetchPage: commandCenterApi.getInbox, onChange: setState });
    ref.current = controller;
    void controller.refresh();
    const unsubscribe = eventsApi.subscribeToEvents(controller.event);
    // Preserve the existing Attention freshness check, including elapsed reminders.
    const interval = window.setInterval(controller.refresh, 30_000);
    return () => {
      ref.current = null;
      unsubscribe(); window.clearInterval(interval); controller.dispose();
    };
  }, []);
  const refresh = useCallback(() => ref.current?.refresh(), []);
  const loadMore = useCallback(() => ref.current?.loadMore(), []);
  return { state, refresh, loadMore };
}
