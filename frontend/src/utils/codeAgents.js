export function availableCodeAgentIDs(catalog) {
  return new Set(
    (Array.isArray(catalog) ? catalog : [])
      .filter((entry) => entry?.enabled !== false && entry?.submittable === true && supportsIssueExecution(entry))
      .map((entry) => String(entry.id || '').trim())
      .filter(Boolean),
  );
}

export function availableAgentProfiles(profiles, catalog) {
  const available = availableCodeAgentIDs(catalog);
  return (Array.isArray(profiles) ? profiles : []).filter((profile) => available.has(String(profile?.provider || '')));
}

export function codeAgentAvailable(provider, catalog) {
  return availableCodeAgentIDs(catalog).has(String(provider || ''));
}

export function codeAgentLabel(provider, catalog) {
  const id = String(provider || '').trim();
  const entry = (Array.isArray(catalog) ? catalog : []).find(item => String(item?.id || '') === id);
  return String(entry?.label || id || 'Code Agent');
}

export function groupedAvailableAgentProfiles(profiles, catalog) {
  const available = availableAgentProfiles(profiles, catalog);
  const groups = [];
  const byProvider = new Map();
  for (const profile of available) {
    const provider = String(profile?.provider || '').trim();
    if (!byProvider.has(provider)) {
      const group = { provider, label: codeAgentLabel(provider, catalog), profiles: [] };
      byProvider.set(provider, group);
      groups.push(group);
    }
    byProvider.get(provider).profiles.push(profile);
  }
  return groups;
}

export function unavailableSelectedAgentProfile(selectedProfileID, profiles, catalog) {
  const id = String(selectedProfileID || '').trim();
  if (!id || availableAgentProfiles(profiles, catalog).some(profile => profile.id === id)) return null;
  const profile = (Array.isArray(profiles) ? profiles : []).find(item => item?.id === id);
  return {
    id,
    name: String(profile?.name || id),
    provider: String(profile?.provider || ''),
    providerLabel: codeAgentLabel(profile?.provider, catalog),
  };
}

export function effectiveProjectProvider(project, profiles = []) {
  const defaultProfileID = String(project?.default_agent_profile_id || '');
  const profile = defaultProfileID
    ? (Array.isArray(profiles) ? profiles : []).find((item) => item?.id === defaultProfileID)
    : null;
  return String(profile?.provider || project?.provider || '');
}

function supportsIssueExecution(entry) {
  if (entry?.capabilities?.issueExecution === true) return true;
  return Array.isArray(entry?.legacy_capabilities) && entry.legacy_capabilities.includes('issue_execution');
}
