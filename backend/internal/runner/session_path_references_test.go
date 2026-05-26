package runner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestFileAndFolderReferencesInjectContentSummaries(t *testing.T) {
	st := openRunnerStore(t)
	root := t.TempDir()
	writeRunnerProjectFile(t, root, "notes.md", "hello file reference\n")
	writeRunnerProjectFile(t, root, "docs/a.md", "a\n")
	writeRunnerProjectFile(t, root, "docs/b.md", "b\n")
	project, err := st.CreateProject(context.Background(), store.Project{ID: "demo", CWD: root})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	_, err = r.CreateSession(context.Background(), SessionCreateInput{
		ProjectID: project.ID,
		Prompt:    "解释上下文",
		References: []SessionReference{
			{Type: "file", Path: "notes.md"},
			{Type: "folder", Path: "docs"},
		},
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	prompt := stringFromUserInputs(fake.turnInputs)
	for _, want := range []string{
		"file notes.md",
		"content:",
		"hello file reference",
		"folder docs",
		"files: 2",
		"- a.md",
		"- b.md",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("path reference summary missing %q:\n%s", want, prompt)
		}
	}
}

func writeRunnerProjectFile(t *testing.T, root, rel, body string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", rel, err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}
