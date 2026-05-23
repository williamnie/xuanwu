package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"

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
	if err := st.FailStaleIssues(context.Background()); err != nil {
		log.Fatal(err)
	}
	bus := events.NewBus()
	client := codex.NewAdapter(cfg.CodexCmd, cfg.CodexArgs)
	r := runner.New(st, bus, client)
	if err := r.StartAutoProjects(context.Background()); err != nil {
		log.Fatal(err)
	}
	r.StartHoldChecks(context.Background())
	cronScheduler := scheduler.New(st, bus, r)
	cronScheduler.Start(context.Background())
	startSessionWatcher(context.Background(), cfg.CodexSessionsDir, bus)
	srv := api.NewServerWithWebDirAndSessionsDir(st, bus, r, cfg.WebDir, cfg.CodexSessionsDir)
	authToken, err := config.ResolveAuthToken(cfg)
	if err != nil {
		log.Fatal(err)
	}
	srv.SetAuthToken(authToken)
	go srv.WarmCodexUsageCache(context.Background())
	log.Printf("Codex Issue Runner API listening on http://%s", cfg.Addr)
	if err := http.ListenAndServe(cfg.Addr, srv); err != nil {
		log.Fatal(err)
	}
}

func startSessionWatcher(ctx context.Context, root string, bus *events.Bus) {
	watcher := sessionwatch.New(root, bus)
	if err := watcher.Start(ctx); err != nil {
		log.Printf("codex session watcher disabled: %v", err)
	}
}
