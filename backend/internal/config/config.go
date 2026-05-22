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
	WebDir           string
	CodexSessionsDir string
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
	fs.StringVar(&cfg.WebDir, "web-dir", cfg.WebDir, "static web UI directory")
	fs.StringVar(&cfg.CodexSessionsDir, "codex-sessions-dir", cfg.CodexSessionsDir, "Codex persisted sessions directory")
	codexArgs := fs.String("codex-args", strings.Join(cfg.CodexArgs, " "), "Codex app-server args")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	cfg.CodexArgs = strings.Fields(*codexArgs)
	return cfg, nil
}

func defaultConfig() Config {
	return Config{
		Addr:             env("CODEX_RUNNER_ADDR", "127.0.0.1:3008"),
		DBPath:           env("CODEX_RUNNER_DB", "data/app.db"),
		CodexCmd:         env("CODEX_RUNNER_CODEX_CMD", "codex"),
		CodexArgs:        []string{"app-server", "--listen", "stdio://"},
		WebDir:           env("CODEX_RUNNER_WEB_DIR", ""),
		CodexSessionsDir: env("CODEX_RUNNER_CODEX_SESSIONS_DIR", defaultCodexSessionsDir()),
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
