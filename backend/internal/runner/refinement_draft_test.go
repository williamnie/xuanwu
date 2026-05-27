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

func TestBuildIssueRefinementDraftPromptIncludesSafetyConstraintsAndDiscussion(t *testing.T) {
	payload, _ := json.Marshal(map[string]string{"author": "user", "body": "需要保留 triage 状态"})
	prompt := BuildIssueRefinementDraftPrompt(
		store.Issue{ID: 86, Status: store.StatusTriage, Title: "PI Agent refinement draft", Description: "原始描述"},
		store.Project{ID: "demo", Provider: store.ProviderCodex, DefaultAgentProfileID: "codex-dev"},
		[]store.AgentProfile{{ID: "codex-dev", Name: "Codex Dev", Provider: store.ProviderCodex}},
		[]store.IssueEvent{{Type: "issue.comment", Payload: string(payload)}},
	)

	for _, want := range []string{
		"Do not modify code.",
		"Do not execute shell commands or terminal commands.",
		"Do not update issue status.",
		"Return only one JSON object",
		"acceptanceCriteria",
		"verificationPlan",
		"recommendedProfile",
		"Recommended provider/profile are advisory only",
		"codex-dev · Codex Dev",
		"需要保留 triage 状态",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestGenerateIssueRefinementDraftParsesAgentJSON(t *testing.T) {
	fake := &refinementDraftCodex{fakeCodex: fakeCodex{events: make(chan agent.Event, 4)}}
	fake.onStartTurn = func(threadID, turnID string) {
		fake.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: turnID, Text: `{"problem":"p","context":"c",`}
		fake.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: turnID, Text: `"acceptanceCriteria":"- a","verificationPlan":"- v","nonGoals":"n","risks":"r",`}
		fake.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: turnID, Text: `"recommendedProfile":"codex-dev","recommendedProvider":"codex","riskLevel":"Medium",`}
		fake.events <- agent.Event{Type: events.AgentMessageDelta, Method: "item/agentMessage/delta", ThreadID: threadID, TurnID: turnID, Text: `"recommendationReasoning":"fits","needsHumanConfirmation":true}`}
		fake.events <- agent.Event{Type: events.AgentTurnCompleted, Method: "turn/completed", ThreadID: threadID, TurnID: turnID, Status: "completed"}
	}
	r := New(nil, events.NewBus(), fake)

	result, err := r.GenerateIssueRefinementDraft(context.Background(), IssueRefinementDraftInput{
		Issue:   store.Issue{ID: 1, Status: store.StatusTriage, Title: "t", Description: "d"},
		Project: store.Project{ID: "demo", CWD: t.TempDir(), Provider: store.ProviderCodex},
	})
	if err != nil {
		t.Fatalf("GenerateIssueRefinementDraft error: %v", err)
	}
	if result.ThreadID != "thread-1" || result.TurnID != "turn-1" {
		t.Fatalf("unexpected runtime ids: %+v", result)
	}
	if result.Draft.AcceptanceCriteria != "- a" || result.Draft.VerificationPlan != "- v" {
		t.Fatalf("unexpected draft: %+v", result.Draft)
	}
	if result.Draft.RecommendedProfile != "codex-dev" ||
		result.Draft.NeedsHumanConfirmation != "Yes" {
		t.Fatalf("unexpected recommendation fields: %+v", result.Draft)
	}
	if len(fake.threadInputs) != 1 || fake.threadInputs[0].Sandbox != "read-only" || fake.threadInputs[0].ApprovalPolicy != "always" {
		t.Fatalf("PI Agent must run read-only/always: %+v", fake.threadInputs)
	}
	if !strings.Contains(stringFromUserInputs(fake.turnInputs), "Do not execute shell commands") {
		t.Fatalf("turn prompt missing constraints: %+v", fake.turnInputs)
	}
}

func TestGenerateIssueRefinementDraftRejectsCommandEvents(t *testing.T) {
	fake := &refinementDraftCodex{fakeCodex: fakeCodex{events: make(chan agent.Event, 4), interrupts: make(chan [2]string, 1)}}
	fake.onStartTurn = func(threadID, turnID string) {
		fake.events <- agent.Event{Type: events.AgentCommandStarted, Method: "item/started", ThreadID: threadID, TurnID: turnID, Command: "git status"}
	}
	r := New(nil, events.NewBus(), fake)

	_, err := r.GenerateIssueRefinementDraft(context.Background(), IssueRefinementDraftInput{
		Issue:   store.Issue{ID: 1, Status: store.StatusTriage, Title: "t", Description: "d"},
		Project: store.Project{ID: "demo", CWD: t.TempDir(), Provider: store.ProviderCodex},
	})
	if err == nil || !strings.Contains(err.Error(), "prohibited") {
		t.Fatalf("expected prohibited action error, got %v", err)
	}
	if got := <-fake.interrupts; got != [2]string{"thread-1", "turn-1"} {
		t.Fatalf("interrupt = %v", got)
	}
}

type refinementDraftCodex struct {
	fakeCodex
	onStartTurn func(threadID, turnID string)
}

func (f *refinementDraftCodex) StartTurn(
	ctx context.Context,
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
