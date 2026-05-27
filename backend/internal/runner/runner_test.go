package runner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type fakeNoIssueExecutionProvider struct {
	name   string
	starts int
}

func (f *fakeNoIssueExecutionProvider) Name() string { return f.name }

func (f *fakeNoIssueExecutionProvider) Start(context.Context) error {
	f.starts++
	return nil
}

func (f *fakeNoIssueExecutionProvider) Capabilities() agent.Capabilities {
	return agent.Capabilities{agent.CapabilitySessions}
}

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
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Provider: "unknown-provider", AutoRun: 1,
	})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)
	if err := r.StartProject("demo"); err == nil || !strings.Contains(err.Error(), `provider "unknown-provider" 暂不支持`) {
		t.Fatalf("start project err = %v, want unsupported provider", err)
	}
	r.runIssue(issue)
	got, err := st.GetIssue(ctx, issue.ID)
	if err != nil {
		t.Fatalf("get issue: %v", err)
	}
	if got.Status != store.StatusFailed || !strings.Contains(got.Error, `provider "unknown-provider" 暂不支持`) {
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

func TestCodexIssueRunUsesAgentProfileModelEffortAndPrompt(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateAgentProfile(ctx, store.AgentProfile{
		ID: "nightly", Name: "Nightly", Provider: "codex",
		Model: "gpt-5.5", ReasoningEffort: "high",
		ApprovalPolicy: "never", Sandbox: "workspace-write",
		DefaultInstructions: "profile instructions",
		SkillIntents:        "[\"codex-issue-runner\"]",
	})
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), DefaultAgentProfileID: "nightly",
	})
	issue, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim issue ok=%v err=%v", ok, err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	r.runIssue(issue)

	if len(fake.threadInputs) != 1 || fake.threadInputs[0].Model != "gpt-5.5" ||
		fake.threadInputs[0].ReasoningEffort != "high" {
		t.Fatalf("thread input did not use profile model/effort: %+v", fake.threadInputs)
	}
	if len(fake.turnInputs) == 0 || !strings.Contains(fake.turnInputs[0].Text, "profile instructions") {
		t.Fatalf("turn prompt missing profile instructions: %+v", fake.turnInputs)
	}
	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil || len(runs) != 1 || runs[0].AgentProfileID != "nightly" {
		t.Fatalf("run profile not recorded: runs=%+v err=%v", runs, err)
	}
	if runs[0].Provider != store.ProviderCodex ||
		!strings.Contains(runs[0].CapabilitySummary, string(agent.CapabilityIssueExecution)) ||
		runs[0].SelectionReason != "project_default" {
		t.Fatalf("run dispatcher metadata missing: %+v", runs[0])
	}
}

func TestIssueOverrideProfileWinsOverProjectDefault(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateAgentProfile(ctx, store.AgentProfile{
		ID: "project-default", Name: "Project Default", Provider: "codex", Model: "gpt-5.2",
		ReasoningEffort: "medium",
	})
	_, _ = st.CreateAgentProfile(ctx, store.AgentProfile{
		ID: "issue-override", Name: "Issue Override", Provider: "codex", Model: "gpt-5.5",
		ReasoningEffort: "xhigh",
	})
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), DefaultAgentProfileID: "project-default",
	})
	created, _ := st.CreateIssue(ctx, store.Issue{
		ProjectID: "demo", Title: "task", Status: store.StatusTodo,
		AgentProfileID: "issue-override",
	})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	r.runIssue(issue)

	if len(fake.threadInputs) != 1 || fake.threadInputs[0].Model != "gpt-5.5" ||
		fake.threadInputs[0].ReasoningEffort != "xhigh" {
		t.Fatalf("issue override profile not used: %+v", fake.threadInputs)
	}
	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}
	if runs[0].AgentProfileID != "issue-override" || runs[0].SelectionReason != "issue_override" ||
		!strings.Contains(runs[0].CapabilitySummary, string(agent.CapabilityIssueExecution)) {
		t.Fatalf("override dispatcher metadata missing: %+v", runs[0])
	}
	issueEvents, _ := st.ListIssueEvents(ctx, issue.ID)
	if !hasIssueEventType(issueEvents, "issue.run_selected") {
		t.Fatalf("missing run selection event: %+v", issueEvents)
	}
}

func TestDispatcherFallsBackToProviderDefaultWhenNoProfileConfigured(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{
		ID: "demo", Name: "Demo", CWD: t.TempDir(), Model: "codex-default",
	})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	r.runIssue(issue)

	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}
	if runs[0].AgentProfileID != "" || runs[0].Provider != store.ProviderCodex ||
		runs[0].SelectionReason != "provider_default" {
		t.Fatalf("provider default dispatcher metadata missing: %+v", runs[0])
	}
}

func TestDispatcherBlocksProviderWithoutIssueExecutionCapability(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, store.Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	created, _ := st.CreateIssue(ctx, store.Issue{ProjectID: "demo", Title: "task", Status: store.StatusTodo})
	issue, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok || issue.ID != created.ID {
		t.Fatalf("claim issue ok=%v issue=%+v err=%v", ok, issue, err)
	}
	provider := &fakeNoIssueExecutionProvider{name: store.ProviderCodex}
	r := New(st, events.NewBus(), provider)

	r.runIssue(issue)

	got, _ := st.GetIssue(ctx, issue.ID)
	if got.Status != store.StatusFailed ||
		!strings.Contains(got.Error, string(agent.CapabilityIssueExecution)) {
		t.Fatalf("capability mismatch should fail clearly: %+v", got)
	}
	if provider.starts != 0 {
		t.Fatalf("provider must not start when capability is missing: %d", provider.starts)
	}
}

func hasIssueEventType(events []store.IssueEvent, typ string) bool {
	for _, event := range events {
		if event.Type == typ {
			return true
		}
	}
	return false
}

func TestRenderPromptIncludesAgentProfileSummary(t *testing.T) {
	project := store.Project{
		ID: "demo", Name: "Demo", CWD: "/tmp/demo", Provider: "codex",
		Model: "gpt-5.5", ApprovalPolicy: "never", Sandbox: "workspace-write",
		DefaultAgentProfileID: "nightly",
		DefaultAgentProfile: &store.AgentProfile{
			ID: "nightly", Name: "Nightly Codex", Provider: "codex",
			Model: "gpt-5.5", ReasoningEffort: "high",
			ApprovalPolicy: "never", Sandbox: "workspace-write",
			DefaultInstructions: "夜间执行：先验证再收尾。",
			SkillIntents:        "[\"codex-issue-runner\"]",
			PluginIntents:       "[\"browser\"]",
		},
	}
	issue := store.Issue{ID: 7, Title: "任务", Description: "实现 profile 注入"}
	got := renderPrompt(project, issue)
	for _, want := range []string{
		"Agent Profile v0（项目默认执行画像）",
		"Profile: nightly · Nightly Codex",
		"Model: gpt-5.5 · Effort: high · Approval: never · Sandbox: workspace-write",
		"夜间执行：先验证再收尾。",
		"Skills requested as context/intents only: codex-issue-runner",
		"Plugins requested as context/intents only: browser",
		"这些 skill/plugin intents 只是请求使用/上下文，不会安装插件、授权工具或绕过当前 provider 权限策略。",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("prompt missing %q:\n%s", want, got)
		}
	}
}

func TestRenderPromptSkipsAgentProfileWhenUnset(t *testing.T) {
	project := store.Project{ID: "demo", Name: "Demo", CWD: "/tmp/demo"}
	issue := store.Issue{ID: 7, Title: "任务", Description: "无 profile"}
	got := renderPrompt(project, issue)
	if strings.Contains(got, "Agent Profile v0") {
		t.Fatalf("unset profile should not inject summary:\n%s", got)
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

func TestCreateSessionIncludesReferenceSummaryAndPersistsMetadata(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	projectRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(projectRoot, "notes.md"), []byte("context"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	project, err := st.CreateProject(ctx, store.Project{ID: "demo", CWD: projectRoot})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	issue, err := st.CreateIssue(ctx, store.Issue{
		ProjectID: project.ID, Title: "Fix composer refs", Status: store.StatusTodo,
		Description:     "让 @issue 注入真实 issue 描述",
		SourceSessionID: "codex:thread-source", SourceTurnID: "turn-source",
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	claimed, ok, err := st.ClaimNextIssue(ctx, project.ID)
	if err != nil || !ok || claimed.ID != issue.ID {
		t.Fatalf("claim issue: issue=%+v ok=%v err=%v", claimed, ok, err)
	}
	if err := st.UpdateIssueRuntime(ctx, issue.ID, "thread-ref", "turn-ref"); err != nil {
		t.Fatalf("update issue runtime: %v", err)
	}
	if _, err := st.SetIssueStatus(ctx, issue.ID, store.StatusFailed, "runner boom"); err != nil {
		t.Fatalf("set issue failed: %v", err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	_, err = r.CreateSession(ctx, SessionCreateInput{
		ProjectID: project.ID,
		Prompt:    "继续处理",
		References: []SessionReference{
			{Type: "issue", ID: fmt.Sprint(issue.ID)},
			{Type: "file", Path: "notes.md"},
		},
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	prompt := stringFromUserInputs(fake.turnInputs)
	for _, want := range []string{
		"附加上下文引用",
		"issue #" + fmt.Sprint(issue.ID),
		"Fix composer refs",
		"让 @issue 注入真实 issue 描述",
		"latest run: failed",
		"error: runner boom",
		"source session: thread-source",
		"file notes.md",
		"用户输入：\n继续处理",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("reference summary missing %q:\n%s", want, prompt)
		}
	}
	records, err := st.ListSessionTurnReferences(context.Background(), "thread-1", "turn-1")
	if err != nil {
		t.Fatalf("list references: %v", err)
	}
	if len(records) != 1 || !strings.Contains(records[0].ReferencesJSON, "Fix composer refs") {
		t.Fatalf("reference metadata not persisted: %+v", records)
	}
}

func TestProjectReferenceAddsContextWithoutSwitchingExecutionProject(t *testing.T) {
	st := openRunnerStore(t)
	ctx := context.Background()
	execRoot := t.TempDir()
	contextRoot := t.TempDir()
	execProject, err := st.CreateProject(ctx, store.Project{ID: "runner", CWD: execRoot})
	if err != nil {
		t.Fatalf("create exec project: %v", err)
	}
	contextProject, err := st.CreateProject(ctx, store.Project{ID: "movo", Name: "Movo Web", CWD: contextRoot})
	if err != nil {
		t.Fatalf("create context project: %v", err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	_, err = r.CreateSession(ctx, SessionCreateInput{
		ProjectID: execProject.ID,
		Prompt:    "对比项目上下文",
		References: []SessionReference{
			{Type: "project", ID: contextProject.ID},
		},
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if len(fake.threadInputs) != 1 || fake.threadInputs[0].CWD != execRoot {
		t.Fatalf("@project reference must not switch execution cwd: %+v", fake.threadInputs)
	}
	prompt := stringFromUserInputs(fake.turnInputs)
	for _, want := range []string{
		"project movo",
		"Movo Web",
		"context only",
		"不切换执行项目",
		"provider: codex",
		"capabilities:",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("project reference summary missing %q:\n%s", want, prompt)
		}
	}
}

func TestStartSessionTurnIncludesReferenceSummaryAndPersistsMetadata(t *testing.T) {
	st := openRunnerStore(t)
	projectRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(projectRoot, "notes.md"), []byte("context"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	project, err := st.CreateProject(context.Background(), store.Project{ID: "demo", CWD: projectRoot})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	issue, err := st.CreateIssue(context.Background(), store.Issue{
		ProjectID: project.ID, Title: "Message refs", Status: store.StatusTodo,
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	fake := &fakeCodex{
		events:        make(chan agent.Event, 4),
		resumeSession: agent.Session{ID: "thread-1", CWD: projectRoot},
	}
	r := New(st, events.NewBus(), fake)

	_, err = r.StartSessionTurn(context.Background(), "thread-1", SessionTurnInput{
		Prompt: "继续消息",
		References: []SessionReference{
			{Type: "issue", ID: fmt.Sprint(issue.ID)},
			{Type: "file", Path: "notes.md"},
		},
	})
	if err != nil {
		t.Fatalf("start session turn: %v", err)
	}
	prompt := stringFromUserInputs(fake.turnInputs)
	for _, want := range []string{"附加上下文引用", "Message refs", "file notes.md", "用户输入：\n继续消息"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("reference summary missing %q:\n%s", want, prompt)
		}
	}
	records, err := st.ListSessionTurnReferences(context.Background(), "thread-1", "turn-1")
	if err != nil {
		t.Fatalf("list references: %v", err)
	}
	if len(records) != 1 || !strings.Contains(records[0].ReferencesJSON, "Message refs") {
		t.Fatalf("reference metadata not persisted: %+v", records)
	}
}

func TestSessionReferenceValidationFailures(t *testing.T) {
	t.Run("rejects invalid path traversal", func(t *testing.T) {
		st := openRunnerStore(t)
		project, err := st.CreateProject(context.Background(), store.Project{ID: "demo", CWD: t.TempDir()})
		if err != nil {
			t.Fatalf("create project: %v", err)
		}
		fake := &fakeCodex{events: make(chan agent.Event, 4)}
		r := New(st, events.NewBus(), fake)

		_, err = r.CreateSession(context.Background(), SessionCreateInput{
			ProjectID: project.ID,
			Prompt:    "hello",
			References: []SessionReference{
				{Type: "file", Path: "../secret.txt"},
			},
		})
		if err == nil || !strings.Contains(err.Error(), "不在当前项目 cwd 内") {
			t.Fatalf("err = %v, want cwd boundary error", err)
		}
		if len(fake.threadInputs) != 0 || len(fake.turnInputs) != 0 {
			t.Fatalf("invalid references must block before codex: threads=%+v turns=%+v", fake.threadInputs, fake.turnInputs)
		}
	})

	t.Run("rejects unknown type", func(t *testing.T) {
		st := openRunnerStore(t)
		fake := &fakeCodex{events: make(chan agent.Event, 4)}
		r := New(st, events.NewBus(), fake)

		_, err := r.CreateSession(context.Background(), SessionCreateInput{
			CWD:    t.TempDir(),
			Prompt: "hello",
			References: []SessionReference{
				{Type: "unknown", ID: "x"},
			},
		})
		if err == nil || !strings.Contains(err.Error(), "type \"unknown\" 不支持") {
			t.Fatalf("err = %v, want unknown type error", err)
		}
	})

	t.Run("rejects missing issue", func(t *testing.T) {
		st := openRunnerStore(t)
		fake := &fakeCodex{events: make(chan agent.Event, 4)}
		r := New(st, events.NewBus(), fake)

		_, err := r.CreateSession(context.Background(), SessionCreateInput{
			CWD:    t.TempDir(),
			Prompt: "hello",
			References: []SessionReference{
				{Type: "issue", ID: "404"},
			},
		})
		if err == nil || !strings.Contains(err.Error(), "issue 404 不存在") {
			t.Fatalf("err = %v, want missing issue error", err)
		}
	})
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
