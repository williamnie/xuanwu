package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseUsesProvidedArgsWithoutGlobalFlagState(t *testing.T) {
	t.Setenv("CODEX_RUNNER_AUTH_TOKEN", "")
	t.Setenv("CODEX_RUNNER_AUTH_TOKEN_FILE", "")
	cfg, err := Parse([]string{
		"--addr", "127.0.0.1:3999",
		"--db", "/tmp/runner.db",
		"--codex-cmd", "/usr/local/bin/codex",
		"--codex-args", "app-server --listen stdio://",
		"--web-dir", "/tmp/web",
		"--codex-sessions-dir", "/tmp/sessions",
		"--auth-token", "custom-token",
		"--auth-token-file", "/tmp/token",
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
	if cfg.AuthToken != "custom-token" {
		t.Fatalf("auth token mismatch: %+v", cfg)
	}
	if cfg.AuthTokenFile != "/tmp/token" {
		t.Fatalf("auth token file mismatch: %+v", cfg)
	}
	if got := cfg.CodexArgs; len(got) != 3 || got[0] != "app-server" || got[2] != "stdio://" {
		t.Fatalf("codex args mismatch: %#v", got)
	}
}

func TestParseDefaultsAuthTokenFileFromDBPath(t *testing.T) {
	t.Setenv("CODEX_RUNNER_AUTH_TOKEN_FILE", "")
	cfg, err := Parse([]string{"--db", filepath.Join(t.TempDir(), "runner.db")})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.AuthTokenFile != filepath.Join(filepath.Dir(cfg.DBPath), "auth_token") {
		t.Fatalf("auth token file = %q", cfg.AuthTokenFile)
	}
}

func TestParseDefaultAddrAllowsLANAccess(t *testing.T) {
	t.Setenv("CODEX_RUNNER_ADDR", "")
	cfg, err := Parse(nil)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Addr != "0.0.0.0:3008" {
		t.Fatalf("default addr = %q, want LAN listener", cfg.Addr)
	}
}

func TestParseProviderCommandSettings(t *testing.T) {
	t.Setenv("CODEX_RUNNER_CLAUDE_CMD", "")
	t.Setenv("CODEX_RUNNER_OPENCODE_CMD", "")
	cfg, err := Parse([]string{"--claude-cmd", "/opt/bin/claude", "--opencode-cmd", "/opt/bin/opencode"})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.ClaudeCmd != "/opt/bin/claude" || cfg.OpencodeCmd != "/opt/bin/opencode" {
		t.Fatalf("provider commands mismatch: %+v", cfg)
	}
}

func TestParseDirtyWorktreeCheckSkipFlagAndEnv(t *testing.T) {
	t.Setenv("CODEX_RUNNER_SKIP_DIRTY_WORKTREE_CHECK", "")
	defaultCfg, err := Parse(nil)
	if err != nil {
		t.Fatalf("parse default: %v", err)
	}
	if defaultCfg.SkipDirtyCheck {
		t.Fatalf("dirty worktree check should be enabled by default")
	}

	flagCfg, err := Parse([]string{"--skip-dirty-worktree-check"})
	if err != nil {
		t.Fatalf("parse flag: %v", err)
	}
	if !flagCfg.SkipDirtyCheck {
		t.Fatalf("skip flag should disable dirty worktree protection")
	}

	t.Setenv("CODEX_RUNNER_SKIP_DIRTY_WORKTREE_CHECK", "true")
	envCfg, err := Parse(nil)
	if err != nil {
		t.Fatalf("parse env: %v", err)
	}
	if !envCfg.SkipDirtyCheck {
		t.Fatalf("env should disable dirty worktree protection")
	}
}

func TestProviderStatusesExposeOnlySecretPresence(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-secret-value")
	statuses := ProviderStatuses(ProviderSettingsConfig{ClaudeCmd: "missing-claude-for-test"})
	claude := providerStatusForTest(statuses, "claude")
	if !claude.Secrets["api_key"].Configured {
		t.Fatalf("claude api key should be configured: %+v", claude.Secrets)
	}
}

func providerStatusForTest(statuses []ProviderStatus, id string) ProviderStatus {
	for _, status := range statuses {
		if status.ID == id {
			return status
		}
	}
	return ProviderStatus{}
}

func TestResolveAuthTokenUsesProvidedTokenOrGeneratedFile(t *testing.T) {
	if got, err := ResolveAuthToken(Config{AuthToken: " custom-token "}); err != nil || got != "custom-token" {
		t.Fatalf("provided token = %q err=%v", got, err)
	}

	tokenFile := filepath.Join(t.TempDir(), "auth_token")
	cfg := Config{AuthTokenFile: tokenFile}
	first, err := ResolveAuthToken(cfg)
	if err != nil {
		t.Fatalf("resolve generated token: %v", err)
	}
	if len(first) < 32 {
		t.Fatalf("generated token too short: %q", first)
	}
	second, err := ResolveAuthToken(cfg)
	if err != nil {
		t.Fatalf("resolve persisted token: %v", err)
	}
	if second != first {
		t.Fatalf("generated token was not persisted: first=%q second=%q", first, second)
	}
	info, err := os.Stat(tokenFile)
	if err != nil {
		t.Fatalf("stat token file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode = %v", info.Mode().Perm())
	}
}
