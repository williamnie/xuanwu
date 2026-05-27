package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	agentclaude "github.com/xiaobei/codex-issue-runner/backend/internal/agent/providers/claude"
	agentcodex "github.com/xiaobei/codex-issue-runner/backend/internal/agent/providers/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/api"
	"github.com/xiaobei/codex-issue-runner/backend/internal/cli"
	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/config"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/scheduler"
	"github.com/xiaobei/codex-issue-runner/backend/internal/sessionwatch"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func main() {
	serve, args := commandMode(os.Args[1:])
	if !serve {
		os.Exit(cli.Run(context.Background(), args, os.Stdout, os.Stderr, cli.Options{}))
	}
	runServer(args)
}

func commandMode(args []string) (bool, []string) {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return true, args
	}
	if args[0] == "serve" {
		return true, args[1:]
	}
	return false, args
}

func runServer(args []string) {
	cfg, err := config.Parse(args)
	if err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()
	bus := events.NewBus()
	authToken, err := config.ResolveAuthToken(cfg)
	if err != nil {
		log.Fatal(err)
	}
	client := codex.NewAdapter(cfg.CodexCmd, cfg.CodexArgs)
	client.SetEnv(runnerCallbackEnv(cfg, authToken))
	provider := agentcodex.New(client)
	r := runner.New(st, bus, provider)
	r.RegisterProvider(agentclaude.New(agentclaude.Config{Command: cfg.ClaudeCmd, Env: runnerCallbackEnv(cfg, authToken)}))
	r.SetDirtyWorktreeCheckEnabled(!cfg.SkipDirtyCheck)
	if err := r.RecoverInProgressIssues(context.Background()); err != nil {
		log.Fatal(err)
	}
	if err := r.StartAutoProjects(context.Background()); err != nil {
		log.Fatal(err)
	}
	r.StartHoldChecks(context.Background())
	cronScheduler := scheduler.New(st, bus, r)
	cronScheduler.Start(context.Background())
	startSessionWatcher(context.Background(), cfg.CodexSessionsDir, bus)
	srv := api.NewServerWithWebDirAndSessionsDir(st, bus, r, cfg.WebDir, cfg.CodexSessionsDir)
	srv.SetAuthToken(authToken)
	srv.SetSystemConfig(api.SystemConfig{
		Addr: cfg.Addr, DBPath: cfg.DBPath, CodexCmd: cfg.CodexCmd,
		ClaudeCmd: cfg.ClaudeCmd, OpencodeCmd: cfg.OpencodeCmd,
		CodexSessionsDir: cfg.CodexSessionsDir, AuthEnabled: authToken != "",
		AllowedOrigins: cfg.AllowedOrigins,
		WebMode:        webMode(cfg.WebDir),
	})
	srv.SetRestartFunc(func() {
		log.Print("restart requested; exiting for supervisor restart")
		time.Sleep(300 * time.Millisecond)
		os.Exit(0)
	})
	go srv.WarmCodexUsageCache(context.Background())
	log.Printf("Codex Issue Runner API listening on http://%s", cfg.Addr)
	if err := http.ListenAndServe(cfg.Addr, srv); err != nil {
		log.Fatal(err)
	}
}

func runnerCallbackEnv(cfg config.Config, authToken string) []string {
	env := []string{
		"CODEX_RUNNER_ADDR=" + runnerCallbackAddr(cfg.Addr),
		"CODEX_INTERNAL_ORIGINATOR_OVERRIDE=" + codexOriginatorOverride(),
	}
	if strings.TrimSpace(cfg.AuthToken) != "" {
		return append(env, "CODEX_RUNNER_AUTH_TOKEN="+strings.TrimSpace(authToken))
	}
	if file := strings.TrimSpace(cfg.AuthTokenFile); file != "" {
		return append(env, "CODEX_RUNNER_AUTH_TOKEN_FILE="+file)
	}
	if token := strings.TrimSpace(authToken); token != "" {
		env = append(env, "CODEX_RUNNER_AUTH_TOKEN="+token)
	}
	return env
}

func codexOriginatorOverride() string {
	if value := strings.TrimSpace(os.Getenv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE")); value != "" {
		return value
	}
	return "Codex"
}

func runnerCallbackAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "127.0.0.1:3008"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		if strings.HasPrefix(addr, ":") {
			return "127.0.0.1" + addr
		}
		return addr
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		return net.JoinHostPort("127.0.0.1", port)
	}
	return addr
}

func webMode(webDir string) string {
	if strings.TrimSpace(webDir) != "" {
		return "external"
	}
	return "embedded"
}

func startSessionWatcher(ctx context.Context, root string, bus *events.Bus) {
	watcher := sessionwatch.New(root, bus)
	if err := watcher.Start(ctx); err != nil {
		log.Printf("codex session watcher disabled: %v", err)
	}
}
