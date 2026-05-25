package api

import (
	"context"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestIssueRefinementDraftAPIKeepsIssueInTriageAndDoesNotOverwriteDescription(t *testing.T) {
	provider := &refinementDraftAPICodex{events: make(chan agent.Event, 4)}
	srv := newTestServerWithCodex(t, provider)
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Draft me", "description": "原始描述", "status": "triage",
	})
	postJSON[store.IssueEvent](t, srv, "/api/issues/1/comments", map[string]any{
		"body": "需要验收标准和验证计划", "author": "user",
	})

	result := postJSON[runner.IssueRefinementDraftResult](t, srv, "/api/issues/1/refinement-draft", map[string]any{})
	if result.Draft.AcceptanceCriteria == "" || result.Draft.VerificationPlan == "" {
		t.Fatalf("draft missing ready fields: %+v", result.Draft)
	}
	issue := getJSON[store.Issue](t, srv, "/api/issues/1")
	if issue.Status != store.StatusTriage || issue.Description != "原始描述" {
		t.Fatalf("draft API must not mutate issue: %+v", issue)
	}
	if provider.threadInput.Sandbox != "read-only" || provider.threadInput.ApprovalPolicy != "always" {
		t.Fatalf("PI Agent must be read-only/always: %+v", provider.threadInput)
	}
	prompt := apiUserInputText(provider.turnInput)
	for _, want := range []string{"Do not update issue status", "Do not execute shell commands", "需要验收标准和验证计划"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

type refinementDraftAPICodex struct {
	events      chan agent.Event
	threadInput agent.ThreadInput
	turnInput   []agent.UserInput
}

func (f *refinementDraftAPICodex) Name() string                { return "codex" }
func (f *refinementDraftAPICodex) Start(context.Context) error { return nil }
func (f *refinementDraftAPICodex) StartThread(_ context.Context, input agent.ThreadInput) (string, error) {
	f.threadInput = input
	return "thread-draft", nil
}
func (f *refinementDraftAPICodex) StartTurn(_ context.Context, threadID string, input []agent.UserInput, _ agent.TurnOptions) (string, error) {
	f.turnInput = input
	go func() {
		f.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: "turn-draft", Text: `{"problem":"整理需求","context":"frontend/src/pages/IssueDetail.jsx",`}
		f.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: "turn-draft", Text: `"acceptanceCriteria":"- 入口可见","verificationPlan":"- npm --prefix frontend run build","nonGoals":"不自动 todo","risks":"无"}`}
		f.events <- agent.Event{Type: events.AgentTurnCompleted, Method: "turn/completed", ThreadID: threadID, TurnID: "turn-draft", Status: "completed"}
	}()
	return "turn-draft", nil
}
func (f *refinementDraftAPICodex) Events() <-chan agent.Event { return f.events }

func apiUserInputText(inputs []agent.UserInput) string {
	parts := []string{}
	for _, input := range inputs {
		if input.Text != "" {
			parts = append(parts, input.Text)
		}
	}
	return strings.Join(parts, "\n")
}
