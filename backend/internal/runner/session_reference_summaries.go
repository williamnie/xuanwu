package runner

import (
	"context"
	"fmt"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const maxReferenceSummaryText = 400

func latestIssueRun(ctx context.Context, st *store.Store, issueID int64) *store.IssueRun {
	runs, err := st.ListIssueRuns(ctx, issueID)
	if err != nil || len(runs) == 0 {
		return nil
	}
	latest := runs[len(runs)-1]
	return &latest
}

func issueReferenceSummary(issue store.Issue, latest *store.IssueRun) string {
	lines := []string{
		fmt.Sprintf("issue #%d [%s] %s (project: %s)", issue.ID, issue.Status, issue.Title, issue.ProjectID),
	}
	if text := trimReferenceText(issue.Description); text != "" {
		lines = append(lines, "description: "+text)
	}
	if latest != nil {
		lines = append(lines, issueRunSummary(*latest))
	}
	if text := trimReferenceText(issue.Error); text != "" {
		lines = append(lines, "error: "+text)
	}
	if issue.SourceSessionID != "" {
		lines = append(lines, "source session: "+issue.SourceSessionID+sourceTurnSuffix(issue.SourceTurnID))
	}
	return strings.Join(lines, "\n  ")
}

func issueReferenceMetadata(issue store.Issue) map[string]any {
	meta := map[string]any{"project_id": issue.ProjectID, "status": issue.Status}
	if issue.SourceSessionID != "" {
		meta["source_session_id"] = issue.SourceSessionID
	}
	if issue.SourceTurnID != "" {
		meta["source_turn_id"] = issue.SourceTurnID
	}
	return meta
}

func issueRunSummary(run store.IssueRun) string {
	parts := []string{"latest run: " + run.Status}
	if run.Attempt > 0 {
		parts = append(parts, fmt.Sprintf("attempt %d", run.Attempt))
	}
	if run.ExitReason != "" {
		parts = append(parts, "exit "+run.ExitReason)
	}
	if run.ProviderSessionID != "" {
		parts = append(parts, "session "+run.ProviderSessionID)
	}
	if run.Error != "" {
		parts = append(parts, "run error "+trimReferenceText(run.Error))
	}
	return strings.Join(parts, " · ")
}

func projectReferenceSummary(project store.Project) string {
	store.AttachProjectCapability(&project)
	name := firstNonEmpty(project.Name, project.ID)
	return fmt.Sprintf(
		"project %s %s (cwd: %s) · context only，仅引用项目上下文，不切换执行项目 · provider: %s · capabilities: %s",
		project.ID, name, project.CWD, project.Provider, strings.Join(project.ProviderCapabilities, ", "),
	)
}

func projectReferenceMetadata(project store.Project) map[string]any {
	store.AttachProjectCapability(&project)
	return map[string]any{
		"cwd": project.CWD, "provider": project.Provider,
		"capabilities": project.ProviderCapabilities, "context_only": true,
	}
}

func sourceTurnSuffix(turnID string) string {
	if strings.TrimSpace(turnID) == "" {
		return ""
	}
	return " / turn: " + turnID
}

func trimReferenceText(value string) string {
	text := strings.Join(strings.Fields(value), " ")
	if len(text) <= maxReferenceSummaryText {
		return text
	}
	return text[:maxReferenceSummaryText] + "..."
}
