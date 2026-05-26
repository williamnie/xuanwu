package api

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCapabilitiesAPIListsSkillsAndPlugins(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeTestSkill(t, home, "browser", "Browser automation")
	writeTestPlugin(t, home, "github", "GitHub connector")
	srv := newTestServer(t)

	got := getJSON[map[string][]map[string]any](t, srv, "/api/capabilities")

	if got["skills"][0]["name"] != "browser" || got["skills"][0]["summary"] != "Browser automation" {
		t.Fatalf("skills = %+v", got["skills"])
	}
	if got["plugins"][0]["name"] != "github" || got["plugins"][0]["summary"] != "GitHub connector" {
		t.Fatalf("plugins = %+v", got["plugins"])
	}
}

func writeTestSkill(t *testing.T, home, name, description string) {
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

func writeTestPlugin(t *testing.T, home, name, description string) {
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
