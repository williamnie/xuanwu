package config

import (
	"flag"
	"os"
	"strings"
)

type Config struct {
	Addr             string
	DBPath           string
	CodexCmd         string
	CodexArgs        []string
	ClaudeCmd        string
	OpencodeCmd      string
	WebDir           string
	CodexSessionsDir string
	AuthToken        string
	AuthTokenFile    string
	AllowedOrigins   []string
	SkipDirtyCheck   bool
}

func Load() Config {
	cfg, err := Parse(os.Args[1:])
	if err != nil {
		panic(err)
	}
	return cfg
}

func Parse(args []string) (Config, error) {
	cfg := defaultConfig()
	fs := flag.NewFlagSet("codex-issue-runner serve", flag.ExitOnError)
	fs.StringVar(&cfg.Addr, "addr", cfg.Addr, "HTTP listen address")
	fs.StringVar(&cfg.DBPath, "db", cfg.DBPath, "SQLite database path")
	fs.StringVar(&cfg.CodexCmd, "codex-cmd", cfg.CodexCmd, "Codex command path")
	fs.StringVar(&cfg.ClaudeCmd, "claude-cmd", cfg.ClaudeCmd, "Claude Code command path")
	fs.StringVar(&cfg.OpencodeCmd, "opencode-cmd", cfg.OpencodeCmd, "opencode command path")
	fs.StringVar(&cfg.WebDir, "web-dir", cfg.WebDir, "static web UI directory")
	fs.StringVar(&cfg.CodexSessionsDir, "codex-sessions-dir", cfg.CodexSessionsDir, "Codex persisted sessions directory")
	fs.StringVar(&cfg.AuthToken, "auth-token", cfg.AuthToken, "Bearer token for protected API requests; prefer env or token file to avoid shell history")
	fs.StringVar(&cfg.AuthTokenFile, "auth-token-file", cfg.AuthTokenFile, "File path for generated or persisted API bearer token")
	origins := fs.String("allowed-origins", strings.Join(cfg.AllowedOrigins, ","), "Comma-separated allowed browser origins for API/SSE; empty allows local origins only")
	fs.BoolVar(&cfg.SkipDirtyCheck, "skip-dirty-worktree-check", cfg.SkipDirtyCheck, "Allow issue execution to start when the target git worktree is dirty")
	codexArgs := fs.String("codex-args", strings.Join(cfg.CodexArgs, " "), "Codex app-server args")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	cfg.CodexArgs = strings.Fields(*codexArgs)
	cfg.ClaudeCmd = strings.TrimSpace(cfg.ClaudeCmd)
	cfg.OpencodeCmd = strings.TrimSpace(cfg.OpencodeCmd)
	cfg.AuthToken = strings.TrimSpace(cfg.AuthToken)
	cfg.AuthTokenFile = strings.TrimSpace(cfg.AuthTokenFile)
	cfg.AllowedOrigins = splitList(*origins)
	applyAuthTokenEnv(&cfg)
	return cfg, nil
}

func applyAuthTokenEnv(cfg *Config) {
	if cfg.AuthToken == "" {
		cfg.AuthToken = strings.TrimSpace(os.Getenv("CODEX_RUNNER_AUTH_TOKEN"))
	}
	if cfg.AuthTokenFile == "" {
		cfg.AuthTokenFile = strings.TrimSpace(os.Getenv("CODEX_RUNNER_AUTH_TOKEN_FILE"))
	}
	if cfg.AuthTokenFile == "" {
		cfg.AuthTokenFile = defaultAuthTokenFile(cfg.DBPath)
	}
}

func defaultConfig() Config {
	return Config{
		Addr:             env("CODEX_RUNNER_ADDR", "0.0.0.0:3008"),
		DBPath:           env("CODEX_RUNNER_DB", "data/app.db"),
		CodexCmd:         env("CODEX_RUNNER_CODEX_CMD", "codex"),
		CodexArgs:        []string{"app-server", "--listen", "stdio://"},
		ClaudeCmd:        env("CODEX_RUNNER_CLAUDE_CMD", "claude"),
		OpencodeCmd:      env("CODEX_RUNNER_OPENCODE_CMD", "opencode"),
		WebDir:           env("CODEX_RUNNER_WEB_DIR", ""),
		CodexSessionsDir: env("CODEX_RUNNER_CODEX_SESSIONS_DIR", defaultCodexSessionsDir()),
		AllowedOrigins:   splitList(env("CODEX_RUNNER_ALLOWED_ORIGINS", "")),
		SkipDirtyCheck:   boolEnv("CODEX_RUNNER_SKIP_DIRTY_WORKTREE_CHECK"),
	}
}

func defaultCodexSessionsDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return home + "/.codex/sessions"
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func boolEnv(key string) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	return value == "1" || value == "true" || value == "yes"
}

func splitList(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
