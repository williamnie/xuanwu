package config

import "testing"

func TestParseUsesProvidedArgsWithoutGlobalFlagState(t *testing.T) {
	cfg, err := Parse([]string{
		"--addr", "127.0.0.1:3999",
		"--db", "/tmp/runner.db",
		"--codex-cmd", "/usr/local/bin/codex",
		"--codex-args", "app-server --listen stdio://",
		"--web-dir", "/tmp/web",
		"--codex-sessions-dir", "/tmp/sessions",
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Addr != "127.0.0.1:3999" || cfg.DBPath != "/tmp/runner.db" {
		t.Fatalf("unexpected cfg: %+v", cfg)
	}
	if cfg.CodexCmd != "/usr/local/bin/codex" {
		t.Fatalf("codex cmd mismatch: %+v", cfg)
	}
	if cfg.WebDir != "/tmp/web" {
		t.Fatalf("web dir mismatch: %+v", cfg)
	}
	if cfg.CodexSessionsDir != "/tmp/sessions" {
		t.Fatalf("codex sessions dir mismatch: %+v", cfg)
	}
	if got := cfg.CodexArgs; len(got) != 3 || got[0] != "app-server" || got[2] != "stdio://" {
		t.Fatalf("codex args mismatch: %#v", got)
	}
}
