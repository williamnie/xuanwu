package runner

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type fakeCodex struct {
	events     chan codex.Event
	setName    string
	turnInputs []codex.UserInput
}

func (f *fakeCodex) Start(context.Context) error { return nil }
func (f *fakeCodex) Stop(context.Context) error  { return nil }
func (f *fakeCodex) ThreadStart(context.Context, codex.ThreadInput) (string, error) {
	return "thread-1", nil
}
func (f *fakeCodex) ThreadList(context.Context, codex.SessionListInput) (codex.SessionListResult, error) {
	return codex.SessionListResult{}, nil
}
func (f *fakeCodex) ThreadRead(context.Context, string) (codex.Session, error) {
	return codex.Session{}, nil
}
func (f *fakeCodex) ThreadResume(context.Context, string) (codex.Session, error) {
	return codex.Session{}, nil
}
func (f *fakeCodex) ThreadSetName(_ context.Context, _ string, name string) error {
	f.setName = name
	return nil
}
func (f *fakeCodex) TurnStart(_ context.Context, _ string, input []codex.UserInput) (string, error) {
	f.turnInputs = input
	go func() {
		f.events <- codex.Event{Method: "item/agentMessage/delta", ThreadID: "thread-1", TurnID: "turn-1", Text: "working"}
		f.events <- codex.Event{Method: "turn/completed", ThreadID: "thread-1", TurnID: "turn-1", Status: "completed"}
	}()
	return "turn-1", nil
}
func (f *fakeCodex) InterruptTurn(context.Context, string, string) error { return nil }
func (f *fakeCodex) Events() <-chan codex.Event                          { return f.events }

func TestRunnerCompletesTodoIssue(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir(), AutoRun: 1})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan codex.Event, 4)}
	r := New(st, events.NewBus(), fake)
	if err := r.StartProject("demo"); err != nil {
		t.Fatalf("start project: %v", err)
	}
	defer r.StopProject("demo")
	got := waitIssueStatus(t, st, issue.ID, store.StatusDone)
	if got.CodexThreadID != "thread-1" || got.CodexTurnID != "turn-1" {
		t.Fatalf("runtime ids not persisted: %+v", got)
	}
	if fake.setName != "task" {
		t.Fatalf("thread name = %q, want issue title", fake.setName)
	}
	events, _ := st.ListIssueEvents(ctx, issue.ID)
	if len(events) == 0 {
		t.Fatalf("expected issue log/status events")
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
