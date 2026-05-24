export function isProjectSessionGroupCollapsed(group, collapsedState = {}, options = {}) {
  const explicitState = collapsedState[group?.id];
  if (typeof explicitState === 'boolean') return explicitState;

  const shouldAutoCollapseEmpty = options.autoCollapseEmptyProjects !== false;
  if (!shouldAutoCollapseEmpty) return false;

  return (group?.sessions?.length || 0) === 0;
}
