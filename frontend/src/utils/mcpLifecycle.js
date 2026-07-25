const degradedValues = new Set(['degraded', 'error', 'failed', 'offline', 'unavailable']);

export function mcpServerLifecycleStates(server = {}) {
  const states = [];
  const status = clean(server.status);
  const readiness = clean(server.readiness);
  if (status === 'discovered') states.push('discovered');
  states.push(server.enabled ? 'enabled' : 'disabled');
  if (server.enabled && readiness === 'ready') states.push('ready');
  if (server.enabled && (degradedValues.has(status) || degradedValues.has(readiness))) states.push('degraded');
  return [...new Set(states)];
}

function clean(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
