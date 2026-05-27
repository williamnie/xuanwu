package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const (
	selectionReasonIssueOverride   = "issue_override"
	selectionReasonProjectDefault  = "project_default"
	selectionReasonProviderDefault = "provider_default"
)

type RunSelection struct {
	ProfileID         string   `json:"profile_id"`
	ProfileName       string   `json:"profile_name,omitempty"`
	ProviderID        string   `json:"provider_id"`
	Capabilities      []string `json:"capabilities"`
	CapabilitySummary string   `json:"capability_summary"`
	SelectionReason   string   `json:"selection_reason"`
}

func (r *Runner) ResolveIssueRunSelection(ctx context.Context, issue store.Issue) (RunSelection, error) {
	project, err := r.store.GetProject(ctx, issue.ProjectID)
	if err != nil {
		return RunSelection{}, err
	}
	selection, err := r.resolveProjectRunSelection(ctx, issue, project)
	if err != nil {
		return RunSelection{}, err
	}
	if project.Hold != nil {
		return RunSelection{}, fmt.Errorf("project %s 处于 hold 状态: %s", project.ID, project.Hold.Message)
	}
	if err := r.EnsureCleanWorktree(ctx, project.CWD); err != nil {
		return RunSelection{}, err
	}
	return selection, nil
}

func (r *Runner) ResolveIssueQueueSelection(ctx context.Context, issue store.Issue) (RunSelection, error) {
	project, err := r.store.GetProject(ctx, issue.ProjectID)
	if err != nil {
		return RunSelection{}, err
	}
	return r.resolveProjectRunSelection(ctx, issue, project)
}

func (r *Runner) resolveProjectRunSelection(
	ctx context.Context,
	issue store.Issue,
	project store.Project,
) (RunSelection, error) {
	selection, err := r.buildRunSelection(ctx, issue, project)
	if err != nil {
		return RunSelection{}, err
	}
	return selection, r.validateRunSelection(project.ID, selection)
}

func (r *Runner) buildRunSelection(
	ctx context.Context,
	issue store.Issue,
	project store.Project,
) (RunSelection, error) {
	profile, profileID, reason, err := r.lookupIssueProfile(ctx, issue, project)
	if err != nil {
		return RunSelection{}, err
	}
	providerID := project.Provider
	if profile != nil && strings.TrimSpace(profile.Provider) != "" {
		providerID = profile.Provider
	}
	providerID = strings.ToLower(strings.TrimSpace(firstNonEmpty(providerID, store.ProviderCodex)))
	capabilities := capabilityStrings(r.capabilitiesForID(providerID))
	return RunSelection{
		ProfileID: profileID, ProfileName: profileName(profile), ProviderID: providerID,
		Capabilities: capabilities, CapabilitySummary: strings.Join(capabilities, ","),
		SelectionReason: reason,
	}, nil
}

func (r *Runner) lookupIssueProfile(
	ctx context.Context,
	issue store.Issue,
	project store.Project,
) (*store.AgentProfile, string, string, error) {
	if profileID := strings.TrimSpace(issue.AgentProfileID); profileID != "" {
		profile, err := r.store.GetAgentProfile(ctx, profileID)
		if err != nil {
			return nil, "", "", err
		}
		return &profile, profile.ID, selectionReasonIssueOverride, nil
	}
	if profileID := strings.TrimSpace(project.DefaultAgentProfileID); profileID != "" {
		if project.DefaultAgentProfile != nil && project.DefaultAgentProfile.ID == profileID {
			return project.DefaultAgentProfile, profileID, selectionReasonProjectDefault, nil
		}
		profile, err := r.store.GetAgentProfile(ctx, profileID)
		if err != nil {
			return nil, "", "", err
		}
		return &profile, profile.ID, selectionReasonProjectDefault, nil
	}
	return nil, "", selectionReasonProviderDefault, nil
}

func (r *Runner) applyRunSelection(ctx context.Context, issueID int64, project *store.Project, selection RunSelection) error {
	if selection.ProfileID != "" {
		profile, err := r.store.GetAgentProfile(ctx, selection.ProfileID)
		if err != nil {
			return err
		}
		project.DefaultAgentProfileID = profile.ID
		project.DefaultAgentProfile = &profile
		applyAgentProfileExecutionPreset(project, profile)
	}
	project.Provider = selection.ProviderID
	return r.persistRunSelection(ctx, issueID, selection)
}

func (r *Runner) validateRunSelection(projectID string, selection RunSelection) error {
	provider, ok := r.providerByID(selection.ProviderID)
	if !ok {
		return providerMismatchError(
			store.Project{ID: projectID, Provider: selection.ProviderID}, r.providerID(),
		)
	}
	if !capabilitiesForProvider(provider, selection.ProviderID).Supports(agent.CapabilityIssueExecution) {
		return fmt.Errorf(
			"provider %q 不支持 capability %q", selection.ProviderID, agent.CapabilityIssueExecution,
		)
	}
	return nil
}

func (r *Runner) capabilitiesForID(providerID string) agent.Capabilities {
	provider, ok := r.providerByID(providerID)
	if ok {
		return capabilitiesForProvider(provider, providerID)
	}
	return agent.CapabilitiesForProviderID(providerID)
}

func (r *Runner) persistRunSelection(ctx context.Context, issueID int64, selection RunSelection) error {
	if err := r.store.UpdateOpenIssueRunSelection(ctx, issueID, selection.ProviderID,
		selection.ProfileID, selection.CapabilitySummary, selection.SelectionReason); err != nil {
		return err
	}
	return nil
}

func (r *Runner) recordRunSelectionEvent(ctx context.Context, issueID int64, selection RunSelection) {
	body, _ := json.Marshal(selection)
	e, err := r.store.AddIssueEvent(ctx, issueID, "issue.run_selected", string(body))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{ID: e.ID, Type: e.Type, IssueID: issueID, Payload: e.Payload, CreatedAt: e.CreatedAt})
}

func capabilityStrings(capabilities agent.Capabilities) []string {
	items := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		items = append(items, string(capability))
	}
	return items
}

func profileName(profile *store.AgentProfile) string {
	if profile == nil {
		return ""
	}
	return strings.TrimSpace(profile.Name)
}
