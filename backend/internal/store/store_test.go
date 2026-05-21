package store

import (
	"context"
	"path/filepath"
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

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}
