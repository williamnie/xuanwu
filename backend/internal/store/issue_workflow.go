package store

import (
	"encoding/json"
	"strings"
)

const workflowSnapshotVersion = "v0"

var defaultWorkflowStepDefs = []struct {
	id    string
	label string
}{
	{"intake", "Intake"},
	{"refine", "Refine"},
	{"review", "Review"},
	{"implement", "Implement"},
	{"verify", "Verify"},
	{"close", "Close"},
}

type issueWorkflowSnapshot struct {
	Version       string              `json:"version"`
	CurrentStepID string              `json:"current_step_id"`
	Steps         []issueWorkflowStep `json:"steps"`
	LatestRun     *issueWorkflowRun   `json:"latest_run,omitempty"`
	CodexThreadID string              `json:"codex_thread_id,omitempty"`
	CodexTurnID   string              `json:"codex_turn_id,omitempty"`
}

type issueWorkflowStep struct {
	ID              string `json:"id"`
	Label           string `json:"label"`
	Status          string `json:"status"`
	UpdatedAt       string `json:"updated_at"`
	EvidenceSummary string `json:"evidence_summary"`
	Actor           string `json:"actor"`
}

type issueWorkflowRun struct {
	Attempt           int    `json:"attempt"`
	Status            string `json:"status"`
	Provider          string `json:"provider"`
	ProviderSessionID string `json:"provider_session_id"`
	ProviderTurnID    string `json:"provider_turn_id"`
	CodexThreadID     string `json:"codex_thread_id"`
	CodexTurnID       string `json:"codex_turn_id"`
}

func initialWorkflowSnapshot(status, updatedAt string) string {
	snapshot := defaultWorkflowSnapshot(updatedAt)
	updateWorkflowSnapshot(&snapshot, status, "", "", "", updatedAt)
	return encodeWorkflowSnapshot(snapshot)
}

func nextWorkflowSnapshot(raw, status, evidence, actor, runtime string, updatedAt string) string {
	snapshot, ok := decodeWorkflowSnapshot(raw)
	if !ok {
		snapshot = defaultWorkflowSnapshot(updatedAt)
	}
	updateWorkflowSnapshot(&snapshot, status, evidence, actor, runtime, updatedAt)
	return encodeWorkflowSnapshot(snapshot)
}

func closeWorkflowSnapshotRun(raw, issueStatus, runStatus, exitReason, errText, updatedAt string) string {
	snapshot, ok := decodeWorkflowSnapshot(raw)
	if !ok {
		return raw
	}
	if snapshot.LatestRun != nil {
		snapshot.LatestRun.Status = runStatus
	}
	evidence := strings.TrimSpace(errText)
	if evidence == "" {
		evidence = strings.TrimSpace(exitReason)
	}
	updateWorkflowSnapshot(&snapshot, issueStatus, evidence, "runner", "", updatedAt)
	return encodeWorkflowSnapshot(snapshot)
}

func nextWorkflowSnapshotWithRuntime(
	raw string,
	status string,
	actor string,
	threadID string,
	turnID string,
	attempt int,
	updatedAt string,
) string {
	snapshot, ok := decodeWorkflowSnapshot(raw)
	if !ok {
		snapshot = defaultWorkflowSnapshot(updatedAt)
	}
	snapshot.CodexThreadID = strings.TrimSpace(threadID)
	snapshot.CodexTurnID = strings.TrimSpace(turnID)
	snapshot.LatestRun = workflowRun(status, snapshot.CodexThreadID, snapshot.CodexTurnID, attempt)
	evidence := "Session " + snapshot.CodexThreadID
	if snapshot.CodexTurnID != "" {
		evidence += " / Turn " + snapshot.CodexTurnID
	}
	updateWorkflowSnapshot(&snapshot, status, "", actor, evidence, updatedAt)
	return encodeWorkflowSnapshot(snapshot)
}

func workflowRun(status, threadID, turnID string, attempt int) *issueWorkflowRun {
	return &issueWorkflowRun{
		Attempt: attempt, Status: status, Provider: ProviderCodex,
		ProviderSessionID: threadID, ProviderTurnID: turnID,
		CodexThreadID: threadID, CodexTurnID: turnID,
	}
}

func defaultWorkflowSnapshot(updatedAt string) issueWorkflowSnapshot {
	steps := make([]issueWorkflowStep, 0, len(defaultWorkflowStepDefs))
	for _, def := range defaultWorkflowStepDefs {
		steps = append(steps, issueWorkflowStep{
			ID:        def.id,
			Label:     def.label,
			Status:    "pending",
			UpdatedAt: updatedAt,
			Actor:     "system",
		})
	}
	return issueWorkflowSnapshot{Version: workflowSnapshotVersion, Steps: steps}
}

func updateWorkflowSnapshot(
	snapshot *issueWorkflowSnapshot,
	status string,
	evidence string,
	actor string,
	runtime string,
	updatedAt string,
) {
	if snapshot.Version == "" {
		snapshot.Version = workflowSnapshotVersion
	}
	if actor == "" {
		actor = "system"
	}
	state := workflowStateForIssue(status)
	snapshot.CurrentStepID = state.current
	for idx := range snapshot.Steps {
		step := &snapshot.Steps[idx]
		stepStatus := workflowStepStatus(step.ID, state)
		stepEvidence := ""
		if stepStatus != "pending" {
			stepEvidence = workflowStepEvidence(step.ID, status, evidence, runtime)
		}
		setWorkflowStep(step, stepStatus, stepEvidence, actor, updatedAt)
	}
}

type workflowIssueState struct {
	current string
	done    map[string]bool
	active  map[string]bool
	blocked map[string]bool
}

func workflowStateForIssue(status string) workflowIssueState {
	state := workflowIssueState{
		current: "refine",
		done:    map[string]bool{"intake": true},
		active:  map[string]bool{"refine": true},
		blocked: map[string]bool{},
	}
	switch status {
	case StatusTriage:
		return state
	case StatusTodo:
		state.current = "implement"
		state.done["refine"], state.done["review"] = true, true
		state.active = map[string]bool{"implement": true}
	case StatusInProgress:
		state.current = "implement"
		state.done["refine"], state.done["review"] = true, true
		state.active = map[string]bool{"implement": true}
	case StatusPendingVerification:
		state.current = "verify"
		state.done["refine"], state.done["review"], state.done["implement"] = true, true, true
		state.active = map[string]bool{"verify": true}
	case StatusDone:
		state.current = "close"
		state.done = map[string]bool{
			"intake": true, "refine": true, "review": true,
			"implement": true, "verify": true, "close": true,
		}
		state.active = map[string]bool{}
	case StatusFailed:
		state.current = "verify"
		state.done["refine"], state.done["review"], state.done["implement"] = true, true, true
		state.active = map[string]bool{}
		state.blocked = map[string]bool{"verify": true, "close": true}
	case StatusCancelled:
		state.current = "close"
		state.done["refine"], state.done["review"] = true, true
		state.active = map[string]bool{}
		state.blocked = map[string]bool{"implement": true, "close": true}
	}
	return state
}

func workflowStepStatus(id string, state workflowIssueState) string {
	if state.blocked[id] {
		return "blocked"
	}
	if state.active[id] {
		return "active"
	}
	if state.done[id] {
		return "done"
	}
	return "pending"
}

func workflowStepEvidence(id, status, evidence, runtime string) string {
	evidence = strings.TrimSpace(evidence)
	runtime = strings.TrimSpace(runtime)
	switch id {
	case "intake":
		return "Issue created"
	case "refine":
		if status == StatusTriage {
			return "Triage intake ready for refinement"
		}
		return "Refinement accepted for execution"
	case "review":
		return "Ready gate entered"
	case "implement":
		if runtime != "" {
			return runtime
		}
		if status == StatusInProgress {
			return "Runner claimed issue"
		}
		return "Implementation step reached"
	case "verify":
		if evidence != "" {
			return evidence
		}
		if status == StatusPendingVerification {
			return "Awaiting verification review"
		}
		return "Verification step reached"
	case "close":
		if evidence != "" {
			return evidence
		}
		if status != "" {
			return "Issue status: " + status
		}
	}
	return evidence
}

func setWorkflowStep(step *issueWorkflowStep, status, evidence, actor, updatedAt string) {
	if step.Status == status && strings.TrimSpace(evidence) == "" {
		return
	}
	step.Status = status
	step.UpdatedAt = updatedAt
	step.Actor = actor
	if strings.TrimSpace(evidence) != "" {
		step.EvidenceSummary = strings.TrimSpace(evidence)
	} else if status == "pending" {
		step.EvidenceSummary = ""
	}
}

func decodeWorkflowSnapshot(raw string) (issueWorkflowSnapshot, bool) {
	var snapshot issueWorkflowSnapshot
	if strings.TrimSpace(raw) == "" {
		return snapshot, false
	}
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		return issueWorkflowSnapshot{}, false
	}
	return snapshot, len(snapshot.Steps) > 0
}

func encodeWorkflowSnapshot(snapshot issueWorkflowSnapshot) string {
	body, err := json.Marshal(snapshot)
	if err != nil {
		return ""
	}
	return string(body)
}
