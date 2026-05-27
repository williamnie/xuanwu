package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestIssueVerifierReportAPICreatesAdvisoryEventWithoutStatusMutation(t *testing.T) {
	provider := &verifierAPICodex{events: make(chan agent.Event, 4)}
	srv := newTestServerWithCodex(t, provider)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Verify me", "description": verifierAPIDescription(),
		"status": store.StatusPendingVerification,
	})
	patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{
		"error": "go test passed; smoke missing",
	})
	postJSON[store.IssueEvent](t, srv, "/api/issues/1/comments", map[string]any{
		"body": "人工补充验收口径", "author": "user",
	})

	result := postJSON[issueVerifierReportResponse](t, srv, "/api/issues/1/verifier-report", map[string]any{})
	if result.Report.Recommendation != "retry" || result.Report.EvidenceMissing == "" {
		t.Fatalf("unexpected report: %+v", result.Report)
	}
	issue := getJSON[store.Issue](t, srv, "/api/issues/1")
	if issue.Status != store.StatusPendingVerification || issue.Error != "go test passed; smoke missing" {
		t.Fatalf("verifier report must not mutate issue status/error: %+v", issue)
	}
	events := getJSON[[]store.IssueEvent](t, srv, "/api/issues/1/events")
	last := events[len(events)-1]
	if last.Type != "issue.verification_report" {
		t.Fatalf("expected verification report event, got %+v", events)
	}
	if provider.threadInput.Sandbox != "read-only" || provider.threadInput.ApprovalPolicy != "always" {
		t.Fatalf("Verifier Agent must be read-only/always: %+v", provider.threadInput)
	}
	prompt := apiUserInputText(provider.turnInput)
	for _, want := range []string{
		"Do not modify code or files.",
		"Do not execute shell, terminal, git",
		"Do not update issue status, final status",
		"Acceptance criteria:\n- report visible",
		"go test passed; smoke missing",
		"人工补充验收口径",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestIssueVerifierReportAPIAllowsDoneWithEvidence(t *testing.T) {
	provider := &verifierAPICodex{events: make(chan agent.Event, 4)}
	srv := newTestServerWithCodex(t, provider)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Done weak evidence", "status": store.StatusDone,
	})
	patchJSON[store.Issue](t, srv, "/api/issues/1", map[string]any{
		"error": "done but no smoke evidence",
	})

	result := postJSON[issueVerifierReportResponse](t, srv, "/api/issues/1/verifier-report", map[string]any{})
	if result.Report.Recommendation != "retry" {
		t.Fatalf("unexpected report: %+v", result.Report)
	}
	issue := getJSON[store.Issue](t, srv, "/api/issues/1")
	if issue.Status != store.StatusDone || issue.Error != "done but no smoke evidence" {
		t.Fatalf("done verifier report must be advisory only: %+v", issue)
	}
}

func TestIssueVerifierReportAPIRejectsUnsupportedStatus(t *testing.T) {
	srv := newTestServer(t)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Todo", "status": store.StatusTodo,
	})
	body := postVerifierReportFailure(t, srv, "/api/issues/1/verifier-report")
	if !strings.Contains(body, "pending_verification") {
		t.Fatalf("unexpected failure: %s", body)
	}
}

func verifierAPIDescription() string {
	return `Body

<!-- codex-refinement:start -->
## Refinement

### Acceptance criteria
- report visible

### Verification plan
- go test ./backend/internal/api
<!-- codex-refinement:end -->`
}

type verifierAPICodex struct {
	events      chan agent.Event
	threadInput agent.ThreadInput
	turnInput   []agent.UserInput
}

func (f *verifierAPICodex) Name() string                { return "codex" }
func (f *verifierAPICodex) Start(context.Context) error { return nil }
func (f *verifierAPICodex) StartThread(_ context.Context, input agent.ThreadInput) (string, error) {
	f.threadInput = input
	return "thread-verifier", nil
}
func (f *verifierAPICodex) StartTurn(_ context.Context, threadID string, input []agent.UserInput, _ agent.TurnOptions) (string, error) {
	f.turnInput = input
	go func() {
		f.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: "turn-verifier", Text: `{"summary":"需要补 smoke",`}
		f.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: "turn-verifier", Text: `"acceptanceChecklist":"- [ ] report visible 缺少 smoke",`}
		f.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: "turn-verifier", Text: `"evidenceFound":"go test evidence","evidenceMissing":"manual smoke",`}
		f.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: "turn-verifier", Text: `"risk":"缺少 UI smoke","recommendation":"retry"}`}
		f.events <- agent.Event{Type: events.AgentTurnCompleted, Method: "turn/completed", ThreadID: threadID, TurnID: "turn-verifier", Status: "completed"}
	}()
	return "turn-verifier", nil
}
func (f *verifierAPICodex) Events() <-chan agent.Event { return f.events }

func postVerifierReportFailure(t *testing.T, h http.Handler, path string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{})
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rr.Code, rr.Body.String())
	}
	return rr.Body.String()
}
