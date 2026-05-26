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

func TestSkillPluginReferencesAddRequestOnlyCapabilitySummary(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeRunnerTestSkill(t, home, "browser", "Browser automation")
	writeRunnerTestPlugin(t, home, "github", "GitHub connector")
	st := openRunnerStore(t)
	project, err := st.CreateProject(context.Background(), store.Project{ID: "demo", CWD: t.TempDir()})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	fake := &fakeCodex{events: make(chan agent.Event, 4)}
	r := New(st, events.NewBus(), fake)

	_, err = r.CreateSession(context.Background(), SessionCreateInput{
		ProjectID: project.ID,
		Prompt:    "使用能力辅助",
		References: []SessionReference{
			{Type: "skill", Name: "browser", Metadata: map[string]any{"intent": "request"}},
			{Type: "plugin", Name: "github", Metadata: map[string]any{"intent": "request"}},
		},
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	prompt := stringFromUserInputs(fake.turnInputs)
	for _, want := range []string{"skill browser", "Browser automation", "plugin github", "GitHub connector", "请求使用", "不强制启用"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("capability summary missing %q:\n%s", want, prompt)
		}
	}
}

func writeRunnerTestSkill(t *testing.T, home, name, description string) {
	t.Helper()
	path := filepath.Join(home, ".codex", "skills", name, "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir skill: %v", err)
	}
	body := "---\nname: " + name + "\ndescription: " + description + "\n---\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write skill: %v", err)
	}
}

func writeRunnerTestPlugin(t *testing.T, home, name, description string) {
	t.Helper()
	path := filepath.Join(home, ".codex", "plugins", "cache", "openai", name, "1.0", ".codex-plugin", "plugin.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir plugin: %v", err)
	}
	body := `{"name":"` + name + `","description":"` + description + `","interface":{"displayName":"GitHub"}}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write plugin: %v", err)
	}
}
