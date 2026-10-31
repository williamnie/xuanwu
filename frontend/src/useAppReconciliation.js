import { eventsApi } from './api/events.js';
import { useCallback, useEffect } from 'react';

import { systemApi } from './api/system.js';
import { createBackendConnectionMonitor } from './api/backendConnectionMonitor.js';

import { selectRefreshData, selectSetBackendConnectionState, useDataStore } from './store/dataStore';
import { RECONCILE_INTERVAL_MS } from './utils/stateGuards';


const WORK_SUMMARY_RECONCILE_EVENT_TYPES = new Set([
  'issue.created',
  'issue.deleted',
  'issue.status_changed',
  'issue.updated',
]);

const PROJECT_RECONCILE_EVENT_TYPES = new Set([
  'runner.started',
  'runner.stopped',
  'runner.hold',
  'runner.hold_active',
  'runner.hold_check.failed',
  'runner.hold_cleared',
]);

const PAGE_DATA_SLICES = {
  analytics: ['workSummary'],
  automations: ['projects'],
  'inbox': ['projects', 'workSummary'],
  settings: ['projects', 'workSummary'],
  tasks: ['projects', 'workSummary'],
  handoffs: ['projects'],
};

function getReconcileSlices(currentPage) {
  return PAGE_DATA_SLICES[currentPage] || [];
}

export function useAppReconciliation({ authReady, currentPage }) {
  const refreshData = useDataStore(selectRefreshData);
  const setBackendConnectionState = useDataStore(selectSetBackendConnectionState);
  const refreshVisibleData = useCallback(() => {
    refreshData(getReconcileSlices(currentPage));
  }, [currentPage, refreshData]);

  const refreshVisibleWorkSummary = useCallback(() => {
    if (getReconcileSlices(currentPage).includes('workSummary')) refreshData(['workSummary']);
  }, [currentPage, refreshData]);

  useEffect(() => {
    if (!authReady) return undefined;
    refreshVisibleData();
    // SSE 是主通道；低频 reconcile 只兜底补偿断线期间错过的事件。
    if (getReconcileSlices(currentPage).length === 0) return undefined;

    const interval = setInterval(refreshVisibleData, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [authReady, currentPage, refreshVisibleData]);

  // 订阅 SSE 实时变更，触发数据刷新
  useEffect(() => {
    if (!authReady) return undefined;
    const monitor = createBackendConnectionMonitor({
      onStateChange: setBackendConnectionState,
      probe: signal => systemApi.getCoreHealth({ signal }),
    });
    const unsubscribe = eventsApi.subscribeToEvents(
      (event) => {
        if (WORK_SUMMARY_RECONCILE_EVENT_TYPES.has(event.type)) {
          refreshVisibleWorkSummary();
        } else if (PROJECT_RECONCILE_EVENT_TYPES.has(event.type)) {
          refreshData(['projects']);
        }
      },
      () => monitor.onError(),
      () => monitor.onOpen()
    );
    return () => {
      monitor.stop();
      unsubscribe();
    };
  }, [authReady, refreshData, refreshVisibleWorkSummary, setBackendConnectionState]);

}
