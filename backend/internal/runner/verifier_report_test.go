package runner

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestBuildIssueVerifierPromptIncludesReadOnlyGuardsAndEvidence(t *testing.T) {
	evidence, _ := json.Marshal(map[string]string{"text": "go test ./backend/internal/api passed"})
	input := IssueVerifierInput{
		Issue: store.Issue{
			ID: 109, Status: store.StatusPendingVerification, Title: "Verifier Agent v0",
			Description: verifierRefinementDescription(), Error: "npm build missing",
			CodexThreadID: "thread-impl", CodexTurnID: "turn-impl",
		},
		Project:    store.Project{ID: "demo", Provider: store.ProviderCodex},
		Refinement: ParseIssueRefinementFromDescription(verifierRefinementDescription()),
		Runs:       []store.IssueRun{{Attempt: 1, Status: store.StatusPendingVerification, Provider: store.ProviderCodex}},
		Events:     []store.IssueEvent{{Type: "issue.log", Payload: string(evidence)}},
		GitSummary: "last commit:\nabc123 feat(issue): demo",
	}

	prompt := BuildIssueVerifierPrompt(input)
	for _, want := range []string{
		"Read-only review only.",
		"Do not modify code or files.",
		"Do not execute shell, terminal, git, package, test, build, or smoke commands.",
		"Do not update issue status, final status",
		"Do not run codex-issue-runner issue update/accept/reject/request-changes.",
		"Recommendation must be exactly one of: accept, reject, retry.",
		"Acceptance criteria:\n- report visible",
		"go test ./backend/internal/api passed",
		"last commit:",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestGenerateIssueVerifierReportParsesAgentJSON(t *testing.T) {
	fake := &verifierCodex{fakeCodex: fakeCodex{events: make(chan agent.Event, 8)}}
	fake.onStartTurn = func(threadID, turnID string) {
		fake.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: turnID, Text: `{"summary":"s","acceptanceChecklist":"- ok",`}
		fake.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: turnID, Text: `"evidenceFound":"tests","evidenceMissing":"smoke",`}
		fake.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: turnID, Text: `"risk":"medium","recommendation":"retry"}`}
		fake.events <- agent.Event{Type: events.AgentTurnCompleted, Method: "turn/completed", ThreadID: threadID, TurnID: turnID, Status: "completed"}
	}
	r := New(nil, events.NewBus(), fake)

	result, err := r.GenerateIssueVerifierReport(context.Background(), IssueVerifierInput{
		Issue:   store.Issue{ID: 1, Status: store.StatusPendingVerification, Title: "t", Description: "d"},
		Project: store.Project{ID: "demo", CWD: t.TempDir(), Provider: store.ProviderCodex},
	})
	if err != nil {
		t.Fatalf("GenerateIssueVerifierReport error: %v", err)
	}
	if result.ThreadID != "thread-1" || result.TurnID != "turn-1" {
		t.Fatalf("unexpected runtime ids: %+v", result)
	}
	if result.Report.Recommendation != "retry" || result.Report.EvidenceMissing != "smoke" {
		t.Fatalf("unexpected report: %+v", result.Report)
	}
	if len(fake.threadInputs) != 1 || fake.threadInputs[0].Sandbox != "read-only" || fake.threadInputs[0].ApprovalPolicy != "always" {
		t.Fatalf("Verifier Agent must run read-only/always: %+v", fake.threadInputs)
	}
	if !strings.Contains(stringFromUserInputs(fake.turnInputs), "Do not execute shell") {
		t.Fatalf("turn prompt missing constraints: %+v", fake.turnInputs)
	}
}

func TestGenerateIssueVerifierReportRejectsProhibitedEvents(t *testing.T) {
	fake := &verifierCodex{fakeCodex: fakeCodex{events: make(chan agent.Event, 4), interrupts: make(chan [2]string, 1)}}
	fake.onStartTurn = func(threadID, turnID string) {
		fake.events <- agent.Event{Type: events.AgentFilePatch, Method: "item/fileChange/patchUpdated", ThreadID: threadID, TurnID: turnID, Path: "main.go"}
	}
	r := New(nil, events.NewBus(), fake)

	_, err := r.GenerateIssueVerifierReport(context.Background(), IssueVerifierInput{
		Issue:   store.Issue{ID: 1, Status: store.StatusPendingVerification, Title: "t", Description: "d"},
		Project: store.Project{ID: "demo", CWD: t.TempDir(), Provider: store.ProviderCodex},
	})
	if err == nil || !strings.Contains(err.Error(), "prohibited") {
		t.Fatalf("expected prohibited action error, got %v", err)
	}
	if got := <-fake.interrupts; got != [2]string{"thread-1", "turn-1"} {
		t.Fatalf("interrupt = %v", got)
	}
}

func verifierRefinementDescription() string {
	return `Body

<!-- codex-refinement:start -->
## Refinement

### Acceptance criteria
- report visible

### Verification plan
- go test ./backend/internal/api
<!-- codex-refinement:end -->`
}

type verifierCodex struct {
	fakeCodex
	onStartTurn func(threadID, turnID string)
}

func (f *verifierCodex) StartTurn(
	_ context.Context,
	threadID string,
	input []agent.UserInput,
	options agent.TurnOptions,
) (string, error) {
	f.turnInputs = input
	f.turnOptions = append(f.turnOptions, options)
	if f.turnErr != nil {
		return "", f.turnErr
	}
	turnID := "turn-1"
	if f.onStartTurn != nil {
		go f.onStartTurn(threadID, turnID)
	}
	return turnID, nil
}
