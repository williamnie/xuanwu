package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) ListAgentProfiles(ctx context.Context) ([]AgentProfile, error) {
	rows, err := s.db.QueryContext(ctx, agentProfileSelect+` order by created_at asc, id asc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	profiles := []AgentProfile{}
	for rows.Next() {
		profile, err := scanAgentProfile(rows)
		if err != nil {
			return nil, err
		}
		profiles = append(profiles, profile)
	}
	return profiles, rows.Err()
}

func (s *Store) CreateAgentProfile(ctx context.Context, profile AgentProfile) (AgentProfile, error) {
	t := now()
	applyAgentProfileDefaults(&profile)
	if profile.ID == "" {
		return AgentProfile{}, fmt.Errorf("agent profile id 不能为空")
	}
	if profile.Name == "" {
		return AgentProfile{}, fmt.Errorf("agent profile name 不能为空")
	}
	_, err := s.db.ExecContext(ctx, `insert into agent_profiles
		(id, name, provider, model, reasoning_effort, approval_policy, sandbox,
		default_instructions, skill_intents_json, plugin_intents_json, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		profile.ID, profile.Name, profile.Provider, profile.Model, profile.ReasoningEffort,
		profile.ApprovalPolicy, profile.Sandbox, profile.DefaultInstructions,
		profile.SkillIntents, profile.PluginIntents, t, t)
	if err != nil {
		return AgentProfile{}, err
	}
	return s.GetAgentProfile(ctx, profile.ID)
}

func (s *Store) GetAgentProfile(ctx context.Context, id string) (AgentProfile, error) {
	row := s.db.QueryRowContext(ctx, agentProfileSelect+` where id=?`, strings.TrimSpace(id))
	profile, err := scanAgentProfile(row)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentProfile{}, ErrNotFound
	}
	return profile, err
}

func (s *Store) UpdateAgentProfile(ctx context.Context, id string, patch AgentProfilePatch) (AgentProfile, error) {
	profile, err := s.GetAgentProfile(ctx, id)
	if err != nil {
		return AgentProfile{}, err
	}
	applyAgentProfilePatch(&profile, patch)
	applyAgentProfileDefaults(&profile)
	if profile.Name == "" {
		return AgentProfile{}, fmt.Errorf("agent profile name 不能为空")
	}
	_, err = s.db.ExecContext(ctx, `update agent_profiles set
		name=?, provider=?, model=?, reasoning_effort=?, approval_policy=?, sandbox=?,
		default_instructions=?, skill_intents_json=?, plugin_intents_json=?, updated_at=?
		where id=?`,
		profile.Name, profile.Provider, profile.Model, profile.ReasoningEffort,
		profile.ApprovalPolicy, profile.Sandbox, profile.DefaultInstructions,
		profile.SkillIntents, profile.PluginIntents, now(), strings.TrimSpace(id))
	if err != nil {
		return AgentProfile{}, err
	}
	return s.GetAgentProfile(ctx, id)
}

func (s *Store) DeleteAgentProfile(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	res, err := s.db.ExecContext(ctx, `delete from agent_profiles where id=?`, id)
	if err != nil {
		return err
	}
	if err := requireAffected(res); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `update projects set default_agent_profile_id='', updated_at=? where default_agent_profile_id=?`, now(), id)
	return err
}

func applyAgentProfileDefaults(profile *AgentProfile) {
	profile.ID = normalizeIdentifier(profile.ID)
	profile.Name = strings.TrimSpace(profile.Name)
	profile.Provider = normalizeProjectProvider(profile.Provider)
	profile.Model = normalizeProjectModel(profile.Model)
	profile.ReasoningEffort = strings.TrimSpace(profile.ReasoningEffort)
	profile.ApprovalPolicy = strings.TrimSpace(profile.ApprovalPolicy)
	profile.Sandbox = strings.TrimSpace(profile.Sandbox)
	profile.DefaultInstructions = strings.TrimSpace(profile.DefaultInstructions)
	profile.SkillIntents = normalizeJSONList(profile.SkillIntents)
	profile.PluginIntents = normalizeJSONList(profile.PluginIntents)
}

func applyAgentProfilePatch(profile *AgentProfile, patch AgentProfilePatch) {
	if patch.Name != nil {
		profile.Name = *patch.Name
	}
	if patch.Provider != nil {
		profile.Provider = *patch.Provider
	}
	if patch.Model != nil {
		profile.Model = *patch.Model
	}
	if patch.ReasoningEffort != nil {
		profile.ReasoningEffort = *patch.ReasoningEffort
	}
	if patch.ApprovalPolicy != nil {
		profile.ApprovalPolicy = *patch.ApprovalPolicy
	}
	if patch.Sandbox != nil {
		profile.Sandbox = *patch.Sandbox
	}
	if patch.DefaultInstructions != nil {
		profile.DefaultInstructions = *patch.DefaultInstructions
	}
	if patch.SkillIntents != nil {
		profile.SkillIntents = *patch.SkillIntents
	}
	if patch.PluginIntents != nil {
		profile.PluginIntents = *patch.PluginIntents
	}
}

func normalizeIdentifier(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ""
	}
	var out strings.Builder
	lastDash := false
	for _, r := range value {
		valid := r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-'
		if valid {
			out.WriteRune(r)
			lastDash = r == '-'
			continue
		}
		if !lastDash {
			out.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(out.String(), "-")
}

func normalizeJSONList(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "[]"
	}
	return value
}

const agentProfileSelect = `select id, name, provider, model, reasoning_effort,
	approval_policy, sandbox, default_instructions, skill_intents_json,
	plugin_intents_json, created_at, updated_at from agent_profiles`
