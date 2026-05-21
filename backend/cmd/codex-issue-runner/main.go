package main

import (
	"context"
	"log"
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/api"
	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/config"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func main() {
	cfg := config.Load()
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
	srv := api.NewServer(st, bus, r)
	log.Printf("Codex Issue Runner API listening on http://%s", cfg.Addr)
	if err := http.ListenAndServe(cfg.Addr, srv); err != nil {
		log.Fatal(err)
	}
}
