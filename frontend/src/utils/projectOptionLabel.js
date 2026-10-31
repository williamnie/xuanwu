// 可传入原有名称表达式，保留各选择器对空名称的处理。
export function projectOptionLabel(project, nodesById, label = project.name || project.id) {
  if (!project.node_id) return label;
  return `${label} · 远程 · ${nodesById?.get(project.node_id)?.name || project.node_id}`;
}
