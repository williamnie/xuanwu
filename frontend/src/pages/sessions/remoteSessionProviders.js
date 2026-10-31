// 新建会话使用节点目录的 create 能力；只读会话能力不能用于创建。
export function remoteSessionProviders(catalog) {
  return {
    providers: (Array.isArray(catalog) ? catalog : []).map(entry => ({
      id: entry.id,
      label: entry.label || entry.id,
      ready: entry.enabled !== false && entry.submittable === true,
      available: entry.capabilities?.sessions?.create === true,
      capabilities: entry.capabilities?.sessions?.create === true ? ['sessions'] : [],
      readiness_reason: entry.readiness_reason,
    })),
  };
}
