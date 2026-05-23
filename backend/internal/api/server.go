package api

import (
	"bytes"
	"crypto/subtle"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/notifications"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
	webassets "github.com/xiaobei/codex-issue-runner/backend/internal/web"
)

type Server struct {
	store            *store.Store
	bus              *events.Bus
	runner           *runner.Runner
	web              http.Handler
	codexSessionsDir string
	authToken        string
	startedAt        time.Time
	systemConfig     SystemConfig
	usageCache       codexUsageCache
	restart          func()
	notifier         *notifications.Notifier
}

func NewServer(st *store.Store, bus *events.Bus, runner *runner.Runner) *Server {
	return NewServerWithWebDir(st, bus, runner, "")
}

func NewServerWithWebDir(st *store.Store, bus *events.Bus, runner *runner.Runner, webDir string) *Server {
	return NewServerWithWebDirAndSessionsDir(st, bus, runner, webDir, "")
}

func NewServerWithWebDirAndSessionsDir(
	st *store.Store,
	bus *events.Bus,
	runner *runner.Runner,
	webDir string,
	codexSessionsDir string,
) *Server {
	s := &Server{
		store: st, bus: bus, runner: runner, codexSessionsDir: codexSessionsDir,
		startedAt: time.Now().UTC(),
	}
	s.web = newWebHandler(webDir)
	s.notifier = notifications.New(st, bus, nil)
	if runner != nil {
		runner.SetIssueNotifier(s.notifier)
	}
	return s
}

func (s *Server) SetAuthToken(token string) {
	s.authToken = strings.TrimSpace(token)
}

func (s *Server) SetRestartFunc(restart func()) {
	s.restart = restart
}

func newWebHandler(webDir string) http.Handler {
	if webDir != "" {
		return spaHandler{root: webDir}
	}
	if embedded, ok := webassets.EmbeddedFS(); ok {
		return newFSSPAHandler(embedded)
	}
	return nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	withCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.URL.Path == "/health" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if !s.requireAuth(w, r) {
			return
		}
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
	if len(parts) > 0 && parts[0] == "usage" {
		s.routeUsage(w, r, parts)
		return
	}
	if len(parts) > 0 && parts[0] == "notifications" {
		s.routeNotifications(w, r, parts)
		return
	}
	if len(parts) > 0 && parts[0] == "system" {
		s.routeSystem(w, r, parts)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if s.authToken == "" {
		return true
	}
	token := requestToken(r)
	if token != "" && constantTimeEqual(token, s.authToken) {
		return true
	}
	writeError(w, http.StatusUnauthorized, "unauthorized")
	return false
}

func requestToken(r *http.Request) string {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if token, ok := bearerToken(header); ok {
		return token
	}
	if cookie, err := r.Cookie("codex_runner_token"); err == nil {
		return strings.TrimSpace(cookie.Value)
	}
	return ""
}

func bearerToken(header string) (string, bool) {
	if len(header) < len("Bearer ") || !strings.EqualFold(header[:len("Bearer ")], "Bearer ") {
		return "", false
	}
	return strings.TrimSpace(header[len("Bearer "):]), true
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
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
	cleaned := cleanSPAPath(r.URL.Path)
	target := filepath.Join(h.root, filepath.FromSlash(cleaned))
	if cleaned == "." || !isRegularFile(target) {
		target = filepath.Join(h.root, "index.html")
	}
	http.ServeFile(w, r, target)
}

type fsSPAHandler struct {
	fsys fs.FS
}

func newFSSPAHandler(fsys fs.FS) http.Handler {
	return fsSPAHandler{fsys: fsys}
}

func (h fsSPAHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cleaned := cleanSPAPath(r.URL.Path)
	if cleaned == "." || !isFSRegularFile(h.fsys, cleaned) {
		cleaned = "index.html"
	}
	serveFSFile(w, r, h.fsys, cleaned)
}

func cleanSPAPath(value string) string {
	cleaned := strings.TrimPrefix(path.Clean("/"+value), "/")
	if cleaned == "" {
		return "."
	}
	return cleaned
}

func serveFSFile(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) {
	body, err := fs.ReadFile(fsys, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	info, _ := fs.Stat(fsys, name)
	modTime := info.ModTime()
	http.ServeContent(w, r, name, modTime, bytes.NewReader(body))
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func isFSRegularFile(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && !info.IsDir()
}
