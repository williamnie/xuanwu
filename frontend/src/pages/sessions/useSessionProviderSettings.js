import { useRef, useCallback, useEffect } from 'react';
import { systemApi } from '../../api/system.js';
import { resolveLastSessionProject } from './newSessionGuards';
import { sessionSettingsForProject } from './sessionOptions';
import { messageSettingsForRuntimeKey } from './sessionRuntimeSettings';

const PROVIDER_MODELS_TIMEOUT_MS = 15_000;
export default function useSessionProviderSettings({
  setModels,
  setModelsError,
  setModelsLoading,
  projectId,
  lastProjectId,
  sessionProjects,
  setProjectId,
  setCwd,
  setSessionSettings,
  sessionSettings,
  nodeId,
  providerRuntimeStatus,
  setProviderRuntimeStatus,
  setProviderCatalog,
  setMessageSettings,
  selectedSessionRuntimeKey,
  selectedSessionProject,
  selectedId,
}) {
  const modelRequestRef = useRef(0);
  const loadModels = useCallback(async (provider = 'codex', runtimeStatus = null, nodeId = '') => {
    const requestId = modelRequestRef.current + 1;
    modelRequestRef.current = requestId;
    if (!provider) {
      setModels([]);
      setModelsError('');
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    setModels([]);
    setModelsError('');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), PROVIDER_MODELS_TIMEOUT_MS);
    try {
      const result = await systemApi.getProviderModels(provider, { nodeId, signal: controller.signal });
      const data = Array.isArray(result?.data?.data) ? result.data.data : result?.data;
      if (modelRequestRef.current !== requestId) return;
      setModels(Array.isArray(data) ? data : []);
      setModelsError('');
    } catch (err) {
      if (modelRequestRef.current !== requestId) return;
      const providerStatus = (runtimeStatus?.providers || []).find(item => item.id === provider);
      const defaultModel = String(providerStatus?.default_model || '').trim();
      setModels(defaultModel ? [{ id: defaultModel, displayName: defaultModel, isDefault: true }] : []);
      setModelsError(err.name === 'AbortError' ? `读取 ${provider} 模型列表超时` : err.message || `读取 ${provider} 模型列表失败`);
    } finally {
      window.clearTimeout(timeout);
      if (modelRequestRef.current === requestId) setModelsLoading(false);
    }
  }, [setModels, setModelsError, setModelsLoading]);

  useEffect(() => {
    if (projectId || !lastProjectId) return;
    const project = resolveLastSessionProject(sessionProjects, lastProjectId);
    if (!project) return;
    setProjectId(project.id);
    setCwd(project.cwd);
    setSessionSettings(sessionSettingsForProject(project));
  }, [lastProjectId, projectId, sessionProjects, setCwd, setProjectId, setSessionSettings]);
  
  useEffect(() => { loadModels(sessionSettings.provider, nodeId ? null : providerRuntimeStatus, nodeId); }, [loadModels, providerRuntimeStatus, sessionSettings.provider, nodeId]);
  useEffect(() => {
    let alive = true;
    Promise.allSettled([systemApi.getSystemStatus(), systemApi.getProviders()]).then(([status, catalog]) => {
      if (!alive) return;
      setProviderRuntimeStatus(status.status === 'fulfilled' ? status.value : { providers: [] });
      setProviderCatalog(catalog.status === 'fulfilled' && Array.isArray(catalog.value) ? catalog.value : []);
    });
    return () => { alive = false; };
  }, [setProviderCatalog, setProviderRuntimeStatus]);
  useEffect(() => {
    setMessageSettings(messageSettingsForRuntimeKey(selectedSessionRuntimeKey, selectedSessionProject));
  }, [selectedId, selectedSessionProject, selectedSessionRuntimeKey, setMessageSettings]);

}
