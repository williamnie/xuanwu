package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectIssueQueueLifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	project, err := st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	if project.ApprovalPolicy != "never" || project.Sandbox != "workspace-write" {
		t.Fatalf("defaults not applied: %+v", project)
	}
	low, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "low", Status: StatusTodo})
	high, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "high", Status: StatusTodo, Priority: 2})
	claimed, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	if claimed.ID != high.ID || claimed.AttemptCount != 1 || claimed.Status != StatusInProgress {
		t.Fatalf("unexpected claimed issue: %+v low=%d", claimed, low.ID)
	}
	updated, err := st.SetIssueStatus(ctx, claimed.ID, StatusDone, "")
	if err != nil || updated.Status != StatusDone {
		t.Fatalf("set done: issue=%+v err=%v", updated, err)
	}
}

func TestIssueRunHistoryLifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "task", Status: StatusTodo})

	claimed, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil {
		t.Fatalf("list runs after claim: %v", err)
	}
	if len(runs) != 1 || runs[0].IssueID != issue.ID || runs[0].Attempt != 1 ||
		runs[0].Status != StatusInProgress || runs[0].Provider != ProviderCodex ||
		runs[0].StartedAt == "" || runs[0].EndedAt != "" {
		t.Fatalf("unexpected first run after claim: %+v", runs)
	}

	if err := st.UpdateIssueRuntime(ctx, claimed.ID, "thread-1", "turn-1"); err != nil {
		t.Fatalf("update runtime: %v", err)
	}
	done := StatusDone
	if _, err := st.UpdateIssue(ctx, claimed.ID, IssuePatch{Status: &done}); err != nil {
		t.Fatalf("mark done: %v", err)
	}
	runs, err = st.ListIssueRuns(ctx, issue.ID)
	if err != nil {
		t.Fatalf("list runs after done: %v", err)
	}
	if len(runs) != 1 || runs[0].Status != StatusDone || runs[0].EndedAt == "" ||
		runs[0].Provider != ProviderCodex ||
		runs[0].ProviderSessionID != "thread-1" || runs[0].ProviderTurnID != "turn-1" ||
		runs[0].CodexThreadID != "thread-1" || runs[0].CodexTurnID != "turn-1" ||
		runs[0].ExitReason != "explicit_status_update" {
		t.Fatalf("first run not closed with runtime ids: %+v", runs)
	}

	todo := StatusTodo
	if _, err := st.UpdateIssue(ctx, claimed.ID, IssuePatch{Status: &todo}); err != nil {
		t.Fatalf("retry issue: %v", err)
	}
	second, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim second run: ok=%v err=%v", ok, err)
	}
	runs, err = st.ListIssueRuns(ctx, issue.ID)
	if err != nil {
		t.Fatalf("list second run: %v", err)
	}
	if len(runs) != 2 || runs[0].Attempt != 1 || runs[1].Attempt != 2 ||
		runs[0].ID == runs[1].ID || second.AttemptCount != 2 {
		t.Fatalf("retry should append second run without overwriting first: issue=%+v runs=%+v", second, runs)
	}
}

func TestFailStaleIssuesClosesOpenRuns(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "stale", Status: StatusTodo})
	claimed, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim stale issue: ok=%v err=%v", ok, err)
	}
	if err := st.UpdateIssueRuntime(ctx, claimed.ID, "thread-stale", "turn-stale"); err != nil {
		t.Fatalf("update stale runtime: %v", err)
	}

	if err := st.FailStaleIssues(ctx); err != nil {
		t.Fatalf("fail stale issues: %v", err)
	}
	runs, err := st.ListIssueRuns(ctx, issue.ID)
	if err != nil {
		t.Fatalf("list stale runs: %v", err)
	}
	if len(runs) != 1 || runs[0].Status != StatusFailed ||
		runs[0].ExitReason != "service_restarted" || runs[0].EndedAt == "" ||
		runs[0].Provider != ProviderCodex ||
		runs[0].ProviderSessionID != "thread-stale" || runs[0].ProviderTurnID != "turn-stale" ||
		runs[0].CodexThreadID != "thread-stale" || runs[0].CodexTurnID != "turn-stale" ||
		runs[0].Error == "" {
		t.Fatalf("stale run not closed correctly: %+v", runs)
	}
}

func TestClaimNextIssueSkipsAutoRetryUntilDue(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "retry later", Status: StatusTodo})
	if _, ok, err := st.ClaimNextIssue(ctx, "demo"); err != nil || !ok {
		t.Fatalf("claim before future schedule: ok=%v err=%v", ok, err)
	}

	future := "2999-01-01T00:00:00Z"
	waiting, err := st.ScheduleIssueAutoRetry(ctx, issue.ID, "Transport error: network error", future)
	if err != nil {
		t.Fatalf("schedule auto retry: %v", err)
	}
	if waiting.Status != StatusTodo || waiting.AutoRetryNextAt != future ||
		waiting.AutoRetryReason != "Transport error: network error" {
		t.Fatalf("unexpected waiting issue: %+v", waiting)
	}
	if claimed, ok, err := st.ClaimNextIssue(ctx, "demo"); err != nil || ok {
		t.Fatalf("future auto retry should not be claimed: ok=%v issue=%+v err=%v", ok, claimed, err)
	}

	due, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "retry due", Status: StatusTodo})
	if _, ok, err := st.ClaimNextIssue(ctx, "demo"); err != nil || !ok {
		t.Fatalf("claim before due schedule: ok=%v err=%v", ok, err)
	}
	past := "2000-01-01T00:00:00Z"
	if _, err = st.ScheduleIssueAutoRetry(ctx, due.ID, "Transport error: network error", past); err != nil {
		t.Fatalf("reschedule auto retry: %v", err)
	}
	claimed, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("due auto retry should be claimed: ok=%v err=%v", ok, err)
	}
	if claimed.ID != due.ID || claimed.Status != StatusInProgress || claimed.AttemptCount != 2 ||
		claimed.AutoRetryNextAt != "" || claimed.AutoRetryReason != "" || claimed.Error != "" {
		t.Fatalf("claimed issue should clear auto retry state: %+v", claimed)
	}
}

func TestProjectNameAndModelDefaults(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	initialCWD := filepath.Join(t.TempDir(), "mindnote")
	project, err := st.CreateProject(ctx, Project{
		ID: "mindnote", CWD: initialCWD, Model: "gemini-2.5-pro",
	})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	if project.Name != "mindnote" || project.Model != "codex-default" {
		t.Fatalf("defaults not applied: %+v", project)
	}
	nextCWD := filepath.Join(t.TempDir(), "movo-web")
	updated, err := st.UpdateProject(ctx, "mindnote", ProjectPatch{CWD: &nextCWD})
	if err != nil {
		t.Fatalf("update project: %v", err)
	}
	if updated.Name != "movo-web" || updated.CWD != nextCWD {
		t.Fatalf("path-derived name not updated: %+v", updated)
	}
}

func TestProjectSortOrderDefaultsAndReorder(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	for _, id := range []string{"alpha", "beta", "gamma"} {
		if _, err := st.CreateProject(ctx, Project{ID: id, Name: id, CWD: filepath.Join(t.TempDir(), id)}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}

	projects, err := st.ListProjects(ctx)
	if err != nil {
		t.Fatalf("list projects: %v", err)
	}
	assertProjectOrder(t, projects, []string{"alpha", "beta", "gamma"})
	if projects[0].SortOrder != 1 || projects[2].SortOrder != 3 {
		t.Fatalf("unexpected default sort order: %+v", projects)
	}

	projects, err = st.ReorderProjects(ctx, []string{"gamma", "alpha", "beta"})
	if err != nil {
		t.Fatalf("reorder projects: %v", err)
	}
	assertProjectOrder(t, projects, []string{"gamma", "alpha", "beta"})

	projects, err = st.ListProjects(ctx)
	if err != nil {
		t.Fatalf("list reordered projects: %v", err)
	}
	assertProjectOrder(t, projects, []string{"gamma", "alpha", "beta"})

	created, err := st.CreateProject(ctx, Project{ID: "delta", Name: "delta", CWD: filepath.Join(t.TempDir(), "delta")})
	if err != nil {
		t.Fatalf("create delta: %v", err)
	}
	if created.SortOrder != 4 {
		t.Fatalf("new project should append at tail: %+v", created)
	}
	projects, _ = st.ListProjects(ctx)
	assertProjectOrder(t, projects, []string{"gamma", "alpha", "beta", "delta"})
}

func TestProjectHoldStatusPersistsAndCanClear(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	held, err := st.SetProjectHold(ctx, "demo", ProjectHold{
		Reason:         "usage_limit",
		Message:        "Runner paused: usage limit reached",
		NextCheckAt:    "2026-05-23T12:00:00Z",
		LastCheckAt:    "2026-05-23T11:00:00Z",
		LastCheckError: "still limited",
	})
	if err != nil {
		t.Fatalf("set hold: %v", err)
	}
	if held.Hold == nil || held.Hold.Reason != "usage_limit" || held.Hold.NextCheckAt == "" {
		t.Fatalf("hold not stored on project: %+v", held)
	}
	if closeErr := st.Close(); closeErr != nil {
		t.Fatalf("close store: %v", closeErr)
	}

	st, err = Open(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	reopened, err := st.GetProject(ctx, "demo")
	if err != nil {
		t.Fatalf("get reopened project: %v", err)
	}
	if reopened.Hold == nil || reopened.Hold.Message != "Runner paused: usage limit reached" {
		t.Fatalf("hold should persist across reopen: %+v", reopened)
	}
	if _, err = st.ClearProjectHold(ctx, "demo"); err != nil {
		t.Fatalf("clear hold: %v", err)
	}
	cleared, _ := st.GetProject(ctx, "demo")
	if cleared.Hold != nil {
		t.Fatalf("hold should be cleared: %+v", cleared)
	}
}

func TestResetIssueForRunnerHoldMovesInProgressBackToTodo(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "task", Status: StatusTodo})
	claimed, ok, err := st.ClaimNextIssue(ctx, "demo")
	if err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	reset, err := st.ResetIssueForRunnerHold(ctx, claimed.ID, "Runner paused: authentication failed")
	if err != nil {
		t.Fatalf("reset for hold: %v", err)
	}
	if reset.Status != StatusTodo || reset.Error != "Runner paused: authentication failed" {
		t.Fatalf("reset issue = %+v", reset)
	}
	if reset.AttemptCount != 1 {
		t.Fatalf("attempt count should not increase on hold reset: %+v", reset)
	}
	if reset.ID != issue.ID {
		t.Fatalf("reset wrong issue: %+v", reset)
	}
}

func TestProjectHoldPreventsClaimAndTriagePromotion(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	todo, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "todo", Status: StatusTodo})
	triage, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "triage", Status: StatusTriage})
	_, _ = st.SetProjectHold(ctx, "demo", ProjectHold{
		Reason:  "usage_limit",
		Message: "Runner paused: usage limit reached",
	})

	if claimed, ok, err := st.ClaimNextIssue(ctx, "demo"); err != nil || ok {
		t.Fatalf("held project should not claim issues: ok=%v issue=%+v err=%v", ok, claimed, err)
	}
	promoted, err := st.PromoteTriageToTodo(ctx, "demo")
	if err != nil {
		t.Fatalf("promote triage: %v", err)
	}
	if len(promoted) != 0 {
		t.Fatalf("held project should not promote triage: %+v", promoted)
	}
	gotTodo, _ := st.GetIssue(ctx, todo.ID)
	gotTriage, _ := st.GetIssue(ctx, triage.ID)
	if gotTodo.Status != StatusTodo || gotTriage.Status != StatusTriage {
		t.Fatalf("held project statuses changed: todo=%+v triage=%+v", gotTodo, gotTriage)
	}
}

func TestIssueEventsRoundTrip(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, _ := st.CreateIssue(ctx, Issue{ProjectID: "demo", Title: "task", Status: StatusTriage})
	event, err := st.AddIssueEvent(ctx, issue.ID, "issue.log", `{"text":"hello"}`)
	if err != nil {
		t.Fatalf("add event: %v", err)
	}
	events, err := st.ListIssueEvents(ctx, issue.ID)
	if err != nil || len(events) != 1 {
		t.Fatalf("list events: len=%d err=%v", len(events), err)
	}
	if events[0].ID != event.ID || events[0].Payload != `{"text":"hello"}` {
		t.Fatalf("unexpected event: %+v", events[0])
	}
}

func TestCreateIssueDerivesTitleFromDescription(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, err := st.CreateIssue(ctx, Issue{
		ProjectID:   "demo",
		Description: "  修复 Codex session 标题固定前缀\n\n补充上下文  ",
		Status:      StatusTodo,
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	if issue.Title != "修复 Codex session 标题固定前缀" {
		t.Fatalf("derived title = %q", issue.Title)
	}
	if issue.Description != "修复 Codex session 标题固定前缀\n\n补充上下文" {
		t.Fatalf("description not trimmed: %q", issue.Description)
	}
}

func TestIssueTemplateSelectionSnapshotsPromptTemplate(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	templates, err := st.ListIssueTemplates(ctx)
	if err != nil {
		t.Fatalf("list default templates: %v", err)
	}
	if len(templates) != 1 || templates[0].ID != DefaultIssueTemplateID || templates[0].IsDefault != 1 {
		t.Fatalf("default template not seeded: %+v", templates)
	}
	custom, err := st.CreateIssueTemplate(ctx, IssueTemplate{
		Name:    "Markdown 修复",
		Content: "项目={{project.cwd}}\n标题={{issue.title}}\n描述={{issue.description}}\n",
	})
	if err != nil {
		t.Fatalf("create template: %v", err)
	}
	issue, err := st.CreateIssue(ctx, Issue{
		ProjectID:   "demo",
		Title:       "渲染 markdown",
		Description: "支持 **粗体**",
		Status:      StatusTodo,
		TemplateID:  custom.ID,
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	if issue.TemplateID != custom.ID || issue.PromptTemplate != custom.Content {
		t.Fatalf("issue did not snapshot selected template: %+v template=%+v", issue, custom)
	}
	one := 1
	updated, err := st.UpdateIssueTemplate(ctx, custom.ID, IssueTemplatePatch{IsDefault: &one})
	if err != nil {
		t.Fatalf("set default template: %v", err)
	}
	if updated.IsDefault != 1 {
		t.Fatalf("template not default: %+v", updated)
	}
	zero := 0
	if _, err = st.UpdateIssueTemplate(ctx, custom.ID, IssueTemplatePatch{IsDefault: &zero}); err != nil {
		t.Fatalf("unset default template: %v", err)
	}
	templates, _ = st.ListIssueTemplates(ctx)
	defaultCount := 0
	for _, tmpl := range templates {
		defaultCount += tmpl.IsDefault
	}
	if defaultCount != 1 {
		t.Fatalf("expected exactly one default template: %+v", templates)
	}
}

func TestDefaultIssueTemplateSnapshotsProviderNeutralContract(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	_, _ = st.CreateProject(ctx, Project{ID: "demo", Name: "Demo", CWD: t.TempDir()})
	issue, err := st.CreateIssue(ctx, Issue{
		ProjectID: "demo",
		Title:     "验证默认模板",
		Status:    StatusTodo,
	})
	if err != nil {
		t.Fatalf("create issue: %v", err)
	}
	for _, want := range []string{
		"适用于所有 agent/provider",
		"CODEX_RUNNER_AUTH_TOKEN",
		"--token \"$(cat <token-file>)\"",
		"codex-issue-runner issue update --id {{issue.id}} --status done --json",
		"Runner HTTP API 做等价更新",
	} {
		if !strings.Contains(issue.PromptTemplate, want) {
			t.Fatalf("prompt template missing %q:\n%s", want, issue.PromptTemplate)
		}
	}
}

func TestCreateAndReadUpload(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	upload, err := st.CreateUpload(ctx, Upload{
		ID:           "upload_test",
		OriginalName: "screenshot.png",
		MimeType:     "image/png",
		SizeBytes:    24,
		SHA256:       "abc123",
		StoragePath:  filepath.Join(t.TempDir(), "screenshot.png"),
	})
	if err != nil {
		t.Fatalf("create upload: %v", err)
	}
	if upload.URL != "/api/uploads/upload_test/content" {
		t.Fatalf("unexpected upload URL: %+v", upload)
	}
	got, err := st.GetUpload(ctx, "upload_test")
	if err != nil {
		t.Fatalf("get upload: %v", err)
	}
	if got.OriginalName != "screenshot.png" || got.MimeType != "image/png" ||
		got.StoragePath != upload.StoragePath {
		t.Fatalf("unexpected upload: %+v", got)
	}
}

func TestLastSessionProjectPreferenceRoundTrip(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if _, err := st.LastSessionProject(ctx); err != ErrNotFound {
		t.Fatalf("empty preference err = %v, want ErrNotFound", err)
	}
	if err := st.SetLastSessionProject(ctx, "demo"); err != nil {
		t.Fatalf("set preference: %v", err)
	}
	if err := st.SetLastSessionProject(ctx, "movo-web"); err != nil {
		t.Fatalf("update preference: %v", err)
	}
	got, err := st.LastSessionProject(ctx)
	if err != nil || got != "movo-web" {
		t.Fatalf("preference = %q err=%v", got, err)
	}
}

func TestOpenMigratesExistingIssuesWithTemplates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open old db: %v", err)
	}
	_, err = db.Exec(`create table projects (
		id text primary key, name text not null, cwd text not null unique,
		auto_run integer not null default 0, model text not null default '',
		approval_policy text not null default 'never',
		sandbox text not null default 'workspace-write',
		created_at text not null, updated_at text not null
	);
	create table issues (
		id integer primary key autoincrement, project_id text not null,
		title text not null, description text not null default '',
		status text not null, priority integer not null default 0,
		codex_thread_id text not null default '', codex_turn_id text not null default '',
		attempt_count integer not null default 0, error text not null default '',
		created_at text not null, updated_at text not null
	);
	insert into projects (id, name, cwd, created_at, updated_at)
		values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
	insert into issues (project_id, title, description, status, created_at, updated_at)
		values ('demo', 'old issue', 'legacy', 'todo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`)
	if closeErr := db.Close(); err != nil || closeErr != nil {
		t.Fatalf("seed old db: exec=%v close=%v", err, closeErr)
	}

	st, err := Open(path)
	if err != nil {
		t.Fatalf("open migrated store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	issue, err := st.GetIssue(context.Background(), 1)
	if err != nil {
		t.Fatalf("get migrated issue: %v", err)
	}
	if issue.TemplateID != "" || issue.PromptTemplate != "" {
		t.Fatalf("legacy issue should keep empty snapshot: %+v", issue)
	}
	templates, err := st.ListIssueTemplates(context.Background())
	if err != nil || len(templates) != 1 || templates[0].IsDefault != 1 {
		t.Fatalf("default template not seeded after migration: %+v err=%v", templates, err)
	}
}

func TestOpenMigratesLegacyDefaultIssueTemplate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	_, err = st.db.Exec(`update issue_templates set content=? where id=?`,
		legacyDefaultIssuePromptTemplate, DefaultIssueTemplateID)
	if closeErr := st.Close(); err != nil || closeErr != nil {
		t.Fatalf("seed legacy template: exec=%v close=%v", err, closeErr)
	}

	st, err = Open(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tmpl, err := st.GetIssueTemplate(context.Background(), DefaultIssueTemplateID)
	if err != nil {
		t.Fatalf("get template: %v", err)
	}
	if tmpl.Content != DefaultIssuePromptTemplate {
		t.Fatalf("legacy default template was not migrated:\n%s", tmpl.Content)
	}
}

func TestOpenMigratesPreviousDefaultIssueTemplate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	_, err = st.db.Exec(`update issue_templates set content=? where id=?`,
		previousDefaultIssuePromptTemplate, DefaultIssueTemplateID)
	if closeErr := st.Close(); err != nil || closeErr != nil {
		t.Fatalf("seed previous template: exec=%v close=%v", err, closeErr)
	}

	st, err = Open(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tmpl, err := st.GetIssueTemplate(context.Background(), DefaultIssueTemplateID)
	if err != nil {
		t.Fatalf("get template: %v", err)
	}
	if tmpl.Content != DefaultIssuePromptTemplate {
		t.Fatalf("previous default template was not migrated:\n%s", tmpl.Content)
	}
}

func TestOpenMigratesIssueRunnerCommitDefaultIssueTemplate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	_, err = st.db.Exec(`update issue_templates set content=? where id=?`,
		issueRunnerCommitDefaultIssuePromptTemplate, DefaultIssueTemplateID)
	if closeErr := st.Close(); err != nil || closeErr != nil {
		t.Fatalf("seed commit template: exec=%v close=%v", err, closeErr)
	}

	st, err = Open(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tmpl, err := st.GetIssueTemplate(context.Background(), DefaultIssueTemplateID)
	if err != nil {
		t.Fatalf("get template: %v", err)
	}
	if tmpl.Content != DefaultIssuePromptTemplate {
		t.Fatalf("commit default template was not migrated:\n%s", tmpl.Content)
	}
}

func assertProjectOrder(t *testing.T, projects []Project, want []string) {
	t.Helper()
	if len(projects) != len(want) {
		t.Fatalf("project count = %d, want %d: %+v", len(projects), len(want), projects)
	}
	for index, project := range projects {
		if project.ID != want[index] {
			t.Fatalf("project order = %+v, want %v", projectIDs(projects), want)
		}
	}
}

func projectIDs(projects []Project) []string {
	ids := make([]string, 0, len(projects))
	for _, project := range projects {
		ids = append(ids, project.ID)
	}
	return ids
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
