package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const verifierGitSummaryTimeout = 2 * time.Second

type issueVerifierReportResponse struct {
	Report   runner.IssueVerificationReport `json:"report"`
	ThreadID string                         `json:"thread_id"`
	TurnID   string                         `json:"turn_id"`
	Event    store.IssueEvent               `json:"event"`
}

func (s *Server) createIssueVerifierReport(w http.ResponseWriter, r *http.Request, id int64) {
	if s.runner == nil {
		writeError(w, http.StatusServiceUnavailable, "runner unavailable")
		return
	}
	input, err := s.issueVerifierInput(r, id)
	if err != nil {
		handleErr(w, err)
		return
	}
	if !issueVerifierAllowed(input.Issue) {
		writeError(w, http.StatusBadRequest, "只有 pending_verification 或带有弱证据的 done issue 可以生成 verifier report")
		return
	}
	result, err := s.runner.GenerateIssueVerifierReport(r.Context(), input)
	if err != nil {
		handleErr(w, err)
		return
	}
	event, err := s.recordIssueEvent(r, id, "issue.verification_report", verifierReportPayload(result))
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, issueVerifierReportResponse{
		Report: result.Report, ThreadID: result.ThreadID, TurnID: result.TurnID, Event: event,
	})
}

func (s *Server) issueVerifierInput(r *http.Request, id int64) (runner.IssueVerifierInput, error) {
	issue, err := s.store.GetIssue(r.Context(), id)
	if err != nil {
		return runner.IssueVerifierInput{}, err
	}
	project, err := s.store.GetProject(r.Context(), issue.ProjectID)
	if err != nil {
		return runner.IssueVerifierInput{}, err
	}
	if firstNonEmptyProvider(project.Provider) != store.ProviderCodex {
		return runner.IssueVerifierInput{}, errUnsupportedVerifierProvider(project)
	}
	runs, err := s.store.ListIssueRuns(r.Context(), id)
	if err != nil {
		return runner.IssueVerifierInput{}, err
	}
	events, err := s.store.ListIssueEvents(r.Context(), id)
	if err != nil {
		return runner.IssueVerifierInput{}, err
	}
	return runner.IssueVerifierInput{
		Issue: issue, Project: project, Runs: runs, Events: events,
		Refinement: runner.ParseIssueRefinementFromDescription(issue.Description),
		GitSummary: verifierGitSummary(r.Context(), project.CWD),
	}, nil
}

func issueVerifierAllowed(issue store.Issue) bool {
	if issue.Status == store.StatusPendingVerification {
		return true
	}
	return issue.Status == store.StatusDone && strings.TrimSpace(issue.Error) != ""
}

func verifierGitSummary(ctx context.Context, cwd string) string {
	ctx, cancel := context.WithTimeout(ctx, verifierGitSummaryTimeout)
	defer cancel()
	return runner.BuildVerifierGitSummary(ctx, cwd)
}

func verifierReportPayload(result runner.IssueVerifierResult) map[string]string {
	return map[string]string{
		"summary":              result.Report.Summary,
		"acceptance_checklist": result.Report.AcceptanceChecklist,
		"evidence_found":       result.Report.EvidenceFound,
		"evidence_missing":     result.Report.EvidenceMissing,
		"risk":                 result.Report.Risk,
		"recommendation":       result.Report.Recommendation,
		"thread_id":            result.ThreadID,
		"turn_id":              result.TurnID,
	}
}

type unsupportedVerifierProviderError struct{ message string }

func (e unsupportedVerifierProviderError) Error() string { return e.message }

func errUnsupportedVerifierProvider(project store.Project) error {
	return unsupportedVerifierProviderError{message: "project " + project.ID + " provider \"" + project.Provider + "\" 暂不支持 verifier，当前只支持 codex"}
}

func firstNonEmptyProvider(provider string) string {
	if strings.TrimSpace(provider) == "" {
		return store.ProviderCodex
	}
	return strings.TrimSpace(provider)
}
