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
	runs  int
	input agent.IssueRunInput
}

func (f *fakeExecutionOnlyProvider) Name() string                { return agent.ProviderFakeExecutionOnly }
func (f *fakeExecutionOnlyProvider) Start(context.Context) error { return nil }
func (f *fakeExecutionOnlyProvider) Capabilities() agent.Capabilities {
	return agent.CapabilitiesForProviderID(agent.ProviderFakeExecutionOnly)
}
func (f *fakeExecutionOnlyProvider) RunIssue(ctx context.Context, input agent.IssueRunInput) (agent.IssueRunResult, error) {
	f.runs++
	f.input = input
	input.Log(agent.Event{Text: "fake provider log", Method: "run/log"})
	return agent.IssueRunResult{}, nil
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
	if len(events) == 0 || !strings.Contains(events[0].Payload, "fake provider log") {
		t.Fatalf("expected fake provider log event, got %+v", events)
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
