import { useEffect, useState } from 'react';
import { systemApi } from '../../api/system.js';
import { useProjectNodes } from '../../store/useProjectNodes.js';
import { remoteSessionProviders } from './remoteSessionProviders.js';

export default function useNewSessionProviders(selectedProject, projectId, providerCatalog, providerRuntimeStatus) {
  const nodesById = useProjectNodes();
  const nodeId = selectedProject?.node_id || '';
  const nodeOnline = nodesById.get(nodeId)?.online;
  const [remoteCatalog, setRemoteCatalog] = useState(null);
  const remoteCatalogCurrent = remoteCatalog?.projectId === projectId && remoteCatalog?.nodeId === nodeId
    && remoteCatalog?.nodeOnline === nodeOnline;
  const newProviderCatalog = nodeId ? (remoteCatalogCurrent ? remoteCatalog.catalog : []) : providerCatalog;
  const newProviderStatus = nodeId ? remoteSessionProviders(newProviderCatalog) : providerRuntimeStatus;
  const newSessionBlockedReason = nodeId
    ? nodeOnline === false || newProviderCatalog.some(entry => entry.node_online === false)
      ? '节点离线'
      : !remoteCatalogCurrent ? '正在读取节点编程工具'
        : remoteCatalog.error || (nodeOnline !== true ? '正在确认节点状态' : '')
    : '';

  useEffect(() => {
    if (!nodeId) return undefined;
    let alive = true;
    const controller = new AbortController();
    systemApi.getProviders({ projectId, signal: controller.signal }).then(catalog => {
      if (alive) setRemoteCatalog({ projectId, nodeId, nodeOnline, catalog: Array.isArray(catalog) ? catalog : [], error: '' });
    }).catch(error => {
      if (alive) setRemoteCatalog({ projectId, nodeId, nodeOnline, catalog: [], error: error.message || '读取节点编程工具失败' });
    });
    return () => { alive = false; controller.abort(); };
  }, [projectId, nodeId, nodeOnline]);

  return { nodeId, newProviderCatalog, newProviderStatus, newSessionBlockedReason };
}
