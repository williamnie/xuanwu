package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type Server struct {
	store  *store.Store
	bus    *events.Bus
	runner *runner.Runner
	web    http.Handler
}

func NewServer(st *store.Store, bus *events.Bus, runner *runner.Runner) *Server {
	return NewServerWithWebDir(st, bus, runner, "")
}

func NewServerWithWebDir(st *store.Store, bus *events.Bus, runner *runner.Runner, webDir string) *Server {
	s := &Server{store: st, bus: bus, runner: runner}
	if webDir != "" {
		s.web = spaHandler{root: webDir}
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	withCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.route(w, r)
		return
	}
	if s.web != nil {
		s.web.ServeHTTP(w, r)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	parts := pathParts(r.URL.Path)
	if len(parts) == 1 && parts[0] == "events" {
		s.handleEvents(w, r)
		return
	}
	if len(parts) > 0 && parts[0] == "projects" {
		s.routeProjects(w, r, parts)
		return
	}
	if len(parts) > 0 && parts[0] == "issues" {
		s.routeIssues(w, r, parts)
		return
	}
	if len(parts) > 0 && parts[0] == "issue-templates" {
		s.routeIssueTemplates(w, r, parts)
		return
	}
	if len(parts) > 0 && parts[0] == "cron-tasks" {
		s.routeCronTasks(w, r, parts)
		return
	}
	if len(parts) > 0 && parts[0] == "uploads" {
		s.routeUploads(w, r, parts)
		return
	}
	if len(parts) > 0 && parts[0] == "sessions" {
		s.routeSessions(w, r, parts)
		return
	}
	if len(parts) > 0 && parts[0] == "codex" {
		s.routeCodex(w, r, parts)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func pathParts(path string) []string {
	trimmed := strings.Trim(strings.TrimPrefix(path, "/api"), "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

type spaHandler struct {
	root string
}

func (h spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cleaned := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/")
	target := filepath.Join(h.root, filepath.FromSlash(cleaned))
	if cleaned == "." || !isRegularFile(target) {
		target = filepath.Join(h.root, "index.html")
	}
	http.ServeFile(w, r, target)
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
