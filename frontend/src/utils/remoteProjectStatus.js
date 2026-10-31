// 未取得节点状态时不推断离线，避免加载或请求失败造成错误提示。
export function isWaitingForProjectNode(work, project, nodesById) {
  return work?.status === 'todo' && Boolean(project?.node_id)
    && nodesById?.get(project.node_id)?.online === false;
}
