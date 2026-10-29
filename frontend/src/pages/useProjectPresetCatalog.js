import { useEffect, useState } from 'react';
import { systemApi } from '../api/system.js';
import { loadProjectPresetCatalog, projectPresetCatalogState } from './projectPresetCatalog.js';

export function useProjectPresetCatalog(nodeId, localCatalog) {
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!nodeId) return;
    return loadProjectPresetCatalog(nodeId, systemApi.getProviders, setState);
  }, [nodeId]);
  return projectPresetCatalogState(state, nodeId, localCatalog);
}
