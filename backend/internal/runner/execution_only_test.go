package runner

import (
	"context"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type fakeExecutionOnlyProvider struct {
	name   string
	runs   int
	input  agent.IssueRunInput
	result agent.IssueRunResult
	hook   func(agent.IssueRunInput)
}

func (f *fakeExecutionOnlyProvider) Name() string {
	return firstNonEmpty(f.name, agent.ProviderFakeExecutionOnly)
}
func (f *fakeExecutionOnlyProvider) Start(context.Context) error { return nil }
func (f *fakeExecutionOnlyProvider) Capabilities() agent.Capabilities {
	return agent.CapabilitiesForProviderID(f.Name())
}
func (f *fakeExecutionOnlyProvider) RunIssue(ctx context.Context, input agent.IssueRunInput) (agent.IssueRunResult, error) {
	f.runs++
	f.input = input
	input.Log(agent.Event{Text: "fake provider log", Method: "run/log"})
	if f.hook != nil {
		f.hook(input)
	}
	return f.result, nil
}

func TestRunnerUsesExecutionOnlyProviderCapability(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: agent.ProviderFakeExecutionOnly,
	})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	fake := &fakeExecutionOnlyProvider{}
	r := New(st, events.NewBus(), fake)

	r.runIssue(issue)

	if fake.runs != 1 {
		t.Fatalf("fake execution-only RunIssue calls = %d, want 1", fake.runs)
	}
	if fake.input.ProjectID != "demo" || fake.input.IssueID != issue.ID || fake.input.CWD == "" {
		t.Fatalf("unexpected issue run input: %+v", fake.input)
	}
	got, err := st.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	if got.Status != store.StatusFailed || !strings.Contains(got.Error, "explicit issue status update") {
		t.Fatalf("issue should still require explicit terminal update: %+v", got)
	}
	events, _ := st.ListIssueEvents(ctx, issue.ID)
	if !hasEventPayload(events, "fake provider log") {
		t.Fatalf("expected fake provider log event, got %+v", events)
	}
}

func hasEventPayload(events []store.IssueEvent, want string) bool {
	for _, event := range events {
		if strings.Contains(event.Payload, want) {
			return true
		}
	}
	return false
}

func TestRunnerInjectsAgentProfileForExecutionOnlyProvider(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateAgentProfile(ctx, store.AgentProfile{
		ID: "nightly", Name: "Nightly", Provider: agent.ProviderFakeExecutionOnly,
		DefaultInstructions: "profile instructions",
		SkillIntents:        "[\"codex-issue-runner\"]",
	})
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(),
		Provider: agent.ProviderFakeExecutionOnly, DefaultAgentProfileID: "nightly",
	})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	fake := &fakeExecutionOnlyProvider{}
	r := New(st, events.NewBus(), fake)

	r.runIssue(issue)

	if !strings.Contains(fake.input.Prompt, "Agent Profile v0") ||
		!strings.Contains(fake.input.Prompt, "profile instructions") ||
		!strings.Contains(fake.input.Prompt, "codex-issue-runner") {
		t.Fatalf("profile summary missing from provider prompt:\n%s", fake.input.Prompt)
	}
	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil || len(runs) != 1 || runs[0].AgentProfileID != "nightly" {
		t.Fatalf("run profile not recorded: runs=%+v err=%v", runs, err)
	}
}

func TestRunnerRejectsSessionsForExecutionOnlyProvider(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: agent.ProviderFakeExecutionOnly,
	})
	r := New(st, events.NewBus(), &fakeExecutionOnlyProvider{})

	_, err := r.CreateSession(ctx, SessionCreateInput{ProjectID: "demo", Prompt: "hello"})
	if err == nil || !strings.Contains(err.Error(), `provider "fake-execution-only" 不支持 capability "sessions"`) {
		t.Fatalf("create session err = %v, want sessions capability error", err)
	}
}

func TestRunnerRecordsExecutionOnlyProviderRuntimeWithoutCodexIdentity(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: agent.ProviderClaudeCode,
	})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	fake := &fakeExecutionOnlyProvider{name: agent.ProviderClaudeCode, result: agent.IssueRunResult{
		ProviderRunID: "cli:claude:1", ProviderSessionID: "claude-session", ProviderTurnID: "claude-turn",
	}}
	r := New(st, events.NewBus(), fake)

	r.runIssue(issue)

	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}
	if runs[0].Provider != agent.ProviderClaudeCode || runs[0].ProviderSessionID != "claude-session" ||
		runs[0].ProviderTurnID != "claude-turn" || runs[0].CodexThreadID != "" || runs[0].CodexTurnID != "" {
		t.Fatalf("execution-only runtime should not be rewritten as codex: %+v", runs[0])
	}
	got, _ := st.GetIssue(ctx, issue.ID)
	if got.CodexThreadID != "" || got.CodexTurnID != "" {
		t.Fatalf("issue codex identity should stay empty for Claude execution-only: %+v", got)
	}
}

func TestRunnerPersistsExecutionOnlyRuntimeFromStreamedEvents(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: agent.ProviderClaudeCode,
	})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	fake := &fakeExecutionOnlyProvider{name: agent.ProviderClaudeCode}
	fake.hook = func(input agent.IssueRunInput) {
		input.Log(agent.Event{ThreadID: "claude-session", TurnID: "claude-turn", Text: "streamed"})
		runs, err := st.ListIssueRuns(ctx, input.IssueID)
		if err != nil || len(runs) != 1 {
			t.Fatalf("runs during stream=%+v err=%v", runs, err)
		}
		if runs[0].ProviderSessionID != "claude-session" || runs[0].ProviderTurnID != "claude-turn" {
			t.Fatalf("runtime not persisted while provider is still running: %+v", runs[0])
		}
		if _, err := st.SetIssueStatus(ctx, input.IssueID, store.StatusDone, ""); err != nil {
			t.Fatalf("explicit status update: %v", err)
		}
	}
	r := New(st, events.NewBus(), fake)

	r.runIssue(issue)

	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}
	if runs[0].ProviderSessionID != "claude-session" || runs[0].ProviderTurnID != "claude-turn" ||
		runs[0].Status != store.StatusDone {
		t.Fatalf("streamed provider runtime should survive explicit close: %+v", runs[0])
	}
}

func TestRunnerFailsClaudeRunWithoutExplicitStatusUsingProviderName(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: agent.ProviderClaudeCode,
	})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	r := New(st, events.NewBus(), &fakeExecutionOnlyProvider{name: agent.ProviderClaudeCode})

	r.runIssue(issue)

	got, err := st.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	if got.Status != store.StatusFailed || !strings.Contains(got.Error, "claude run completed without explicit issue status update") {
		t.Fatalf("issue should fail with provider-specific explicit status error: %+v", got)
	}
}

func TestRunnerDispatchesClaudeProfileToRegisteredExecutionProvider(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateAgentProfile(ctx, store.AgentProfile{
		ID: "claude-exec", Name: "Claude Exec", Provider: agent.ProviderClaudeCode, Model: "sonnet",
	})
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: store.ProviderCodex,
		DefaultAgentProfileID: "claude-exec",
	})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	codex := &fakeCodex{events: make(chan agent.Event, 4)}
	claude := &fakeExecutionOnlyProvider{name: agent.ProviderClaudeCode, result: agent.IssueRunResult{
		ProviderRunID: "cli:claude:1", ProviderSessionID: "claude-session", ProviderTurnID: "claude-turn",
	}}
	r := New(st, events.NewBus(), codex)
	r.RegisterProvider(claude)

	r.runIssue(issue)

	if claude.runs != 1 {
		t.Fatalf("claude runs = %d, want 1", claude.runs)
	}
	if len(codex.threadInputs) != 0 {
		t.Fatalf("codex should not run claude-profile issue: %+v", codex.threadInputs)
	}
	if claude.input.Model != "sonnet" || !strings.Contains(claude.input.Prompt, "Claude Exec") {
		t.Fatalf("claude input missing profile preset: %+v", claude.input)
	}
}

func TestRunnerAcceptsClaudeExplicitStatusUpdate(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: agent.ProviderClaudeCode,
	})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	claude := &fakeExecutionOnlyProvider{name: agent.ProviderClaudeCode, result: agent.IssueRunResult{
		ProviderRunID: "cli:claude:1", ProviderSessionID: "claude-session", ProviderTurnID: "claude-turn",
	}}
	claude.hook = func(input agent.IssueRunInput) {
		if _, err := st.SetIssueStatus(ctx, input.IssueID, store.StatusDone, ""); err != nil {
			t.Fatalf("explicit status update: %v", err)
		}
	}
	r := New(st, events.NewBus(), claude)

	r.runIssue(issue)

	got, err := st.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	if got.Status != store.StatusDone || got.Error != "" {
		t.Fatalf("claude explicit update should keep issue done: %+v", got)
	}
	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}
	if runs[0].Provider != agent.ProviderClaudeCode || runs[0].ExitReason != "explicit_status_update" {
		t.Fatalf("claude explicit update run mismatch: %+v", runs[0])
	}
}
