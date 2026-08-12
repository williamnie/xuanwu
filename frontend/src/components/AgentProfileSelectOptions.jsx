import { groupedAvailableAgentProfiles, unavailableSelectedAgentProfile } from '../utils/codeAgents.js';

export default function AgentProfileSelectOptions({ catalog, profiles, selectedProfileID }) {
  const unavailable = unavailableSelectedAgentProfile(selectedProfileID, profiles, catalog);
  return (
    <>
      {unavailable ? (
        <optgroup label="当前选择">
          <option disabled value={unavailable.id}>
            {unavailable.providerLabel} · {unavailable.name} · 不可用
          </option>
        </optgroup>
      ) : null}
      {groupedAvailableAgentProfiles(profiles, catalog).map(group => (
        <optgroup key={group.provider} label={group.label}>
          {group.profiles.map(profile => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.model || 'Provider 默认模型'}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
