// 节点切换时立即隐藏旧目录；请求失败不能回退到中心工具。
export function projectPresetCatalogState(state, nodeId, localCatalog) {
  if (!nodeId) return { catalog: localCatalog, loading: false, error: '' };
  if (state?.nodeId !== nodeId) return { catalog: [], loading: true, error: '' };
  return state;
}

export function loadProjectPresetCatalog(nodeId, getProviders, publish) {
  let active = true;
  publish({ nodeId, catalog: [], loading: true, error: '' });
  getProviders({ nodeId }).then(catalog => {
    if (active) publish({ nodeId, catalog: Array.isArray(catalog) ? catalog : [], loading: false, error: '' });
  }).catch(error => {
    if (active) publish({ nodeId, catalog: [], loading: false, error: error.message || '读取节点编程工具失败' });
  });
  return () => { active = false; };
}
