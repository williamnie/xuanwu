import { groupedAvailableAgentProfiles, unavailableSelectedAgentProfile } from '../utils/codeAgents.js';

// catalog 接受本机或项目节点目录，分组与不可用选择始终使用同一目录。
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
              {profile.name} · {profile.model || '编程工具默认模型'}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
