export function availableCodeAgentIDs(catalog) {
  return new Set(
    (Array.isArray(catalog) ? catalog : [])
      .filter((entry) => entry?.enabled !== false && entry?.submittable === true)
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

export function effectiveProjectProvider(project, profiles = []) {
  const defaultProfileID = String(project?.default_agent_profile_id || '');
  const profile = defaultProfileID
    ? (Array.isArray(profiles) ? profiles : []).find((item) => item?.id === defaultProfileID)
    : null;
  return String(profile?.provider || project?.provider || '');
}
