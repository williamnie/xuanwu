import { useEffect } from 'react';
import { useDataStore } from './dataStore.js';

let consumers = 0;
let refreshTimer;

export function useProjectNodes() {
  const nodesById = useDataStore(state => state.nodesById);
  const refreshNodes = useDataStore(state => state.refreshNodes);
  useEffect(() => {
    void refreshNodes();
    // 所有页面共用一个轮询与请求；最后一个消费者卸载时停止。
    if (consumers++ === 0) {
      refreshTimer = window.setInterval(() => { void refreshNodes({ force: true }); }, 15_000);
    }
    return () => {
      if (--consumers === 0) window.clearInterval(refreshTimer);
    };
  }, [refreshNodes]);
  return nodesById;
}
