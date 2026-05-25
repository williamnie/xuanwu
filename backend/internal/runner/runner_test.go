package runner

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestRunnerFailsIssueWhenCodexDoesNotSetFinalStatus(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)
	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")
	got := waitIssueStatus(t, st, issue.ID, store.StatusFailed)
	if got.CodexThreadID != "thread-1" || got.CodexTurnID != "turn-1" {
		t.Fatalf("runtime ids not persisted: %+v", got)
	}
	if !strings.Contains(got.Error, "explicit issue status update") {
		t.Fatalf("error = %q, want explicit status update message", got.Error)
	}
	if fake.setName != "task" {
		t.Fatalf("thread name = %q, want issue title", fake.setName)
	}
	if len(fake.threadInputs) != 1 || fake.threadInputs[0].ThreadSource != agent.ThreadSourceSubagent {
		t.Fatalf("issue thread source = %+v, want subagent", fake.threadInputs)
	}
	events, _ := st.ListIssueEvents(ctx, issue.ID)
	if len(events) == 0 {
		t.Fatalf("expected issue log/status events")
	}
}

func TestRunnerFailsIssueForUnsupportedProjectProvider(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: "claude", AutoRun: 1,
	})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)
	if err := r.StartProject("demo"); err == nil || !strings.Contains(err.Error(), `provider "claude" 暂不支持`) {
		t.Fatalf("start project err = %v, want unsupported provider", err)
	}
	r.runIssue(issue)
	got, err := st.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	if got.Status != store.StatusFailed || !strings.Contains(got.Error, `provider "claude" 暂不支持`) {
		t.Fatalf("unsupported provider should fail clearly: %+v", got)
	}
	if len(fake.threadInputs) != 0 {
		t.Fatalf("unsupported provider must not start codex: %+v", fake.threadInputs)
	}
}

func TestRenderPromptUsesIssueTemplate(t *testing.T) {
	project := store.Project{ID: "demo", Name: "Demo", CWD: "/tmp/demo"}
	issue := store.Issue{
		ID:             42,
		Title:          "session详情的markdown渲染",
		Description:    "session详情中需要支持markdown渲染\n",
		Priority:       2,
		PromptTemplate: "cwd={{project.cwd}}\nid={{issue.id}}\ntitle={{issue.title}}\ndesc={{issue.description}}\npriority={{issue.priority}}",
	}
	got := renderPrompt(project, issue)
	want := "cwd=/tmp/demo\nid=42\ntitle=session详情的markdown渲染\ndesc=session详情中需要支持markdown渲染\npriority=2\n"
	if got != want {
		t.Fatalf("prompt mismatch\nwant:\n%q\ngot:\n%q", want, got)
	}
}

func TestRenderPromptDefaultStartsWithIssueContent(t *testing.T) {
	project := store.Project{ID: "demo", Name: "Demo", CWD: "/tmp/demo"}
	issue := store.Issue{ID: 7, Title: "自动派生标题", Description: "修复 session 列表标题重复"}
	got := renderPrompt(project, issue)
	wantPrefix := "修复 session 列表标题重复\n\n执行上下文："
	if len(got) < len(wantPrefix) || got[:len(wantPrefix)] != wantPrefix {
		t.Fatalf("default prompt should start with issue content:\n%s", got)
	}
	if !strings.Contains(got, "codex-issue-runner issue update --id 7 --status done --json") {
		t.Fatalf("default prompt should tell Codex to mark the issue done:\n%s", got)
	}
}

func TestCreateSessionPassesModelEffortAndPermissions(t *testing.T) {
	st := openRunnerStore(t)
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)
	_, err := r.CreateSession(context.Background(), SessionCreateInput{
		CWD: t.TempDir(), Prompt: "hello", Model: "gpt-5.5",
		ReasoningEffort: "xhigh", ApprovalPolicy: "danger-only", Sandbox: "read-only",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if len(fake.threadInputs) != 1 || fake.threadInputs[0].ReasoningEffort != "xhigh" {
		t.Fatalf("thread input = %+v", fake.threadInputs)
	}
	if len(fake.turnOptions) != 1 || fake.turnOptions[0].ReasoningEffort != "xhigh" ||
		fake.turnOptions[0].ApprovalPolicy != "danger-only" || fake.turnOptions[0].Sandbox != "read-only" {
		t.Fatalf("turn options = %+v", fake.turnOptions)
	}
}

func TestStartSessionTurnPassesMessageRuntimeOptions(t *testing.T) {
	st := openRunnerStore(t)
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)
	_, err := r.StartSessionTurn(context.Background(), "thread-1", SessionTurnInput{
		Prompt: "follow up", Model: "gpt-5.4",
		ReasoningEffort: "high", ApprovalPolicy: "always", Sandbox: "danger-full-access",
	})
	if err != nil {
		t.Fatalf("start session turn: %v", err)
	}
	if len(fake.turnOptions) != 1 || fake.turnOptions[0].Model != "gpt-5.4" ||
		fake.turnOptions[0].ReasoningEffort != "high" ||
		fake.turnOptions[0].ApprovalPolicy != "always" ||
		fake.turnOptions[0].Sandbox != "danger-full-access" {
		t.Fatalf("turn options = %+v", fake.turnOptions)
	}
}

func TestSessionTurnPublishesTerminalEventAfterWatcherStarts(t *testing.T) {
	st := openRunnerStore(t)
	fake := &fakeCodex{events: make(chan agent.Event, 8), manualEvents: true}
	bus := events.NewBus()
	ch, unsubscribe := bus.Subscribe()
	defer unsubscribe()
	r := New(st, bus, fake)

	turnID, err := r.StartSessionTurn(context.Background(), "thread-1", SessionTurnInput{Prompt: "follow up"})
	if err != nil {
		t.Fatalf("start session turn: %v", err)
	}
	if turnID != "turn-1" {
		t.Fatalf("turn id = %q", turnID)
	}
	fake.events <- agent.Event{
		Type: events.AgentTurnCompleted, Method: "turn/completed",
		ThreadID: "thread-1", TurnID: "turn-1", Status: "completed",
	}

	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-ch:
			if event.ThreadID == "thread-1" && event.AgentEventType == events.AgentTurnCompleted {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for session terminal SSE event")
		}
	}
}

func TestListSessionsMarksManualSessionRunning(t *testing.T) {
	st := openRunnerStore(t)
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)
	r.setSessionRunning("thread-1", "turn-1")

	list, err := r.ListSessions(context.Background(), agent.SessionListInput{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(list.Data) != 1 || !list.Data[0].IsRunning {
		t.Fatalf("session should be running: %+v", list)
	}
	if list.Data[0].ID != "codex:thread-1" || list.Data[0].Provider != store.ProviderCodex ||
		list.Data[0].ProviderSessionID != "thread-1" {
		t.Fatalf("session identity = %+v, want codex namespaced id", list.Data[0])
	}
	if list.Data[0].Origin != agent.SessionOriginRunner {
		t.Fatalf("session origin = %q, want runner", list.Data[0].Origin)
	}
}

func TestListSessionsIncludesPendingApprovals(t *testing.T) {
	st := openRunnerStore(t)
	fake := &fakeCodex{
		events: make(chan agent.Event, 4),
		pendingApprovals: []agent.PendingApproval{{
			ID: "approval-1", Method: "item/commandExecution/requestApproval",
			ThreadID: "thread-1", TurnID: "turn-1", Params: map[string]any{"command": "go test ./..."},
		}},
	}
	r := New(st, events.NewBus(), fake)

	list, err := r.ListSessions(context.Background(), agent.SessionListInput{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(list.Data) != 1 || len(list.Data[0].PendingApprovals) != 1 ||
		list.Data[0].PendingApprovals[0].ID != "approval-1" || !list.Data[0].IsRunning {
		t.Fatalf("session pending approvals = %+v", list.Data)
	}
}

func TestListSessionsMarksIssueRunnerThreadRunning(t *testing.T) {
	st := openRunnerStore(t)
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)
	r.setRunning(7, &runState{threadID: "thread-1", turnID: "turn-1"})

	list, err := r.ListSessions(context.Background(), agent.SessionListInput{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(list.Data) != 1 || !list.Data[0].IsRunning {
		t.Fatalf("issue runner session should be running: %+v", list)
	}
	if list.Data[0].Origin != agent.SessionOriginRunner {
		t.Fatalf("session origin = %q, want runner", list.Data[0].Origin)
	}
}

func TestListSessionsMarksCodexAppOriginByDefault(t *testing.T) {
	st := openRunnerStore(t)
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	list, err := r.ListSessions(context.Background(), agent.SessionListInput{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(list.Data) != 1 || list.Data[0].Origin != agent.SessionOriginCodexApp {
		t.Fatalf("session should be codex app origin: %+v", list)
	}
}

func TestListSessionsMarksPersistedIssueThreadAsRunnerOrigin(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	if err := st.UpdateIssueRuntime(ctx, issue.ID, "thread-1", "turn-1"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	list, err := r.ListSessions(ctx, agent.SessionListInput{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(list.Data) != 1 || list.Data[0].Origin != agent.SessionOriginRunner {
		t.Fatalf("session should be persisted runner origin: %+v", list)
	}
}

func TestBuildTurnInputResolvesAttachmentMarkdown(t *testing.T) {
	st := openRunnerStore(t)
	path := filepath.Join(t.TempDir(), "screenshot.png")
	upload, err := st.CreateUpload(context.Background(), store.Upload{
		ID:           "upload_img",
		OriginalName: "screenshot.png",
		MimeType:     "image/png",
		SizeBytes:    10,
		SHA256:       "abc",
		StoragePath:  path,
	})
	if err != nil {
		t.Fatalf("create upload: %v", err)
	}

	input, err := buildTurnInput(context.Background(), st,
		"复现截图：\n\n![screenshot.png](attachment://upload_img)\n\n请修复")
	if err != nil {
		t.Fatalf("build turn input: %v", err)
	}
	if len(input) != 3 {
		t.Fatalf("input length = %d, want 3: %+v", len(input), input)
	}
	if input[0].Type != "text" || input[1].Type != "localImage" ||
		input[1].Path != upload.StoragePath || input[2].Type != "text" {
		t.Fatalf("unexpected input sequence: %+v", input)
	}
}

func waitIssueStatus(t *testing.T, st *store.Store, id int64, want string) store.Issue {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		issue, _ := st.GetIssue(context.Background(), id)
		if issue.Status == want {
			return issue
		}
		time.Sleep(20 * time.Millisecond)
	}
	issue, _ := st.GetIssue(context.Background(), id)
	t.Fatalf("issue status = %s, want %s", issue.Status, want)
	return issue
}

func openRunnerStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
