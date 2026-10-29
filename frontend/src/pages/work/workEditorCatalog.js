import { availableAgentProfiles, codeAgentAvailable, effectiveProjectProvider } from '../../utils/codeAgents.js';

// projectId 与 nodeId 一起隔离结果，切换后的首帧也不能沿用旧目录。
export function workCatalogKey(projectId, nodeId = '') {
  return JSON.stringify([projectId, nodeId]);
}

export function workCatalogSelection(state, key, profileId, project) {
  const current = state?.key === key;
  const loading = !current || state.loading;
  const error = current ? state.error : '';
  const profiles = current ? state.profiles : [];
  const catalog = current ? state.catalog : [];
  const inheritedAvailable = codeAgentAvailable(effectiveProjectProvider(project, profiles), catalog);
  const selectedAvailable = !loading && !error && (profileId
    ? availableAgentProfiles(profiles, catalog).some(profile => profile.id === profileId)
    : inheritedAvailable);
  return { loading, error, profiles, catalog, inheritedAvailable, selectedAvailable };
}

// 清理函数阻止已切走项目的成功或失败响应覆盖当前项目。
export function loadWorkCatalog({ key, projectId, getProfiles, getProviders, publish }) {
  let active = true;
  publish({ key, loading: true, error: '', profiles: [], catalog: [] });
  Promise.all([getProfiles(), getProviders({ projectId })]).then(([items, catalog]) => {
    if (active) publish({ key, loading: false, error: '',
      profiles: Array.isArray(items) ? items : items?.items || [],
      catalog: Array.isArray(catalog) ? catalog : [] });
  }).catch(error => {
    if (active) publish({ key, loading: false, error: error.message || '编程工具加载失败', profiles: [], catalog: [] });
  });
  return () => { active = false; };
}
