package config

import (
	"flag"
	"os"
	"strings"
)

type Config struct {
	Addr      string
	DBPath    string
	CodexCmd  string
	CodexArgs []string
}

func Load() Config {
	cfg := Config{
		Addr:      env("CODEX_RUNNER_ADDR", "127.0.0.1:3008"),
		DBPath:    env("CODEX_RUNNER_DB", "data/app.db"),
		CodexCmd:  env("CODEX_RUNNER_CODEX_CMD", "codex"),
		CodexArgs: []string{"app-server", "--listen", "stdio://"},
	}
	flag.StringVar(&cfg.Addr, "addr", cfg.Addr, "HTTP listen address")
	flag.StringVar(&cfg.DBPath, "db", cfg.DBPath, "SQLite database path")
	flag.StringVar(&cfg.CodexCmd, "codex-cmd", cfg.CodexCmd, "Codex command path")
	args := flag.String("codex-args", strings.Join(cfg.CodexArgs, " "), "Codex app-server args")
	flag.Parse()
	cfg.CodexArgs = strings.Fields(*args)
	return cfg
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
