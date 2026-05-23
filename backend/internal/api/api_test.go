package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type noopCodex struct{ ch chan codex.Event }

func (n noopCodex) Start(context.Context) error { return nil }
func (n noopCodex) Stop(context.Context) error  { return nil }
func (n noopCodex) ThreadStart(context.Context, codex.ThreadInput) (string, error) {
	return "thread-new", nil
}
func (n noopCodex) ModelList(context.Context, codex.ModelListInput) (codex.ModelListResult, error) {
	return codex.ModelListResult{Data: []codex.Model{{
		ID: "gpt-5.5", Model: "gpt-5.5", DisplayName: "GPT-5.5",
		DefaultReasoningEffort:    "xhigh",
		SupportedReasoningEfforts: []codex.ReasoningEffortOption{{ReasoningEffort: "xhigh", Description: "超高"}},
	}}}, nil
}
func (n noopCodex) ThreadList(context.Context, codex.SessionListInput) (codex.SessionListResult, error) {
	return codex.SessionListResult{Data: []codex.Session{{ID: "thread-1", CWD: "/tmp/demo", Preview: "hello"}}, NextCursor: "next"}, nil
}
func (n noopCodex) ThreadRead(context.Context, string) (codex.Session, error) {
	return codex.Session{ID: "thread-1", CWD: "/tmp/demo", Preview: "hello"}, nil
}
func (n noopCodex) ThreadResume(context.Context, string) (codex.Session, error) {
	return codex.Session{ID: "thread-1", CWD: "/tmp/demo"}, nil
}
func (n noopCodex) ThreadSetName(context.Context, string, string) error { return nil }
func (n noopCodex) TurnStart(context.Context, string, []codex.UserInput, codex.TurnOptions) (string, error) {
	return "turn-new", nil
}
func (n noopCodex) InterruptTurn(context.Context, string, string) error { return nil }
func (n noopCodex) ResolveApproval(context.Context, string, codex.ApprovalDecision) error {
	return nil
}
func (n noopCodex) Events() <-chan codex.Event { return n.ch }

func TestProjectAndIssueAPI(t *testing.T) {
	srv := newTestServer(t)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	if project.ID != "demo" || project.LoopStatus != "stopped" {
		t.Fatalf("unexpected project: %+v", project)
	}
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "description": "Fix bug from content", "status": "triage",
	})
	if issue.ID == 0 || issue.Status != "triage" {
		t.Fatalf("unexpected issue: %+v", issue)
	}
	if issue.Title != "Fix bug from content" {
		t.Fatalf("expected derived title, got %+v", issue)
	}
	enqueued := postJSON[store.Issue](t, srv, "/api/issues/1/enqueue", map[string]any{})
	if enqueued.Status != store.StatusTodo {
		t.Fatalf("enqueue status: %+v", enqueued)
	}
	events := getJSON[[]store.IssueEvent](t, srv, "/api/issues/1/events")
	if len(events) < 2 {
		t.Fatalf("expected created/status events: %+v", events)
	}
}

func TestProjectOrderAPI(t *testing.T) {
	srv := newTestServer(t)
	for _, id := range []string{"alpha", "beta", "gamma"} {
		postJSON[store.Project](t, srv, "/api/projects", map[string]any{
			"id": id, "name": id, "cwd": filepath.Join(t.TempDir(), id),
		})
	}

	ordered := patchJSON[[]store.Project](t, srv, "/api/projects", map[string]any{
		"project_ids": []string{"gamma", "alpha", "beta"},
	})
	assertAPIProjectOrder(t, ordered, []string{"gamma", "alpha", "beta"})

	listed := getJSON[[]store.Project](t, srv, "/api/projects")
	assertAPIProjectOrder(t, listed, []string{"gamma", "alpha", "beta"})
}

func TestIssueTemplateAPIAndIssueSelection(t *testing.T) {
	srv := newTestServer(t)
	templates := getJSON[[]store.IssueTemplate](t, srv, "/api/issue-templates")
	if len(templates) != 1 || templates[0].ID != store.DefaultIssueTemplateID || templates[0].IsDefault != 1 {
		t.Fatalf("unexpected seeded templates: %+v", templates)
	}
	custom := postJSON[store.IssueTemplate](t, srv, "/api/issue-templates", map[string]any{
		"name":    "最小修复",
		"content": "路径={{project.cwd}}\n任务={{issue.title}}\n",
	})
	if custom.ID == "" || custom.Content == "" {
		t.Fatalf("unexpected custom template: %+v", custom)
	}
	patched := patchJSON[store.IssueTemplate](t, srv, "/api/issue-templates/"+custom.ID, map[string]any{
		"is_default": 1,
	})
	if patched.IsDefault != 1 {
		t.Fatalf("default flag not updated: %+v", patched)
	}
	_ = postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "name": "Demo", "cwd": t.TempDir(), "auto_run": 0,
	})
	issue := postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "demo", "title": "Fix bug", "status": "triage", "template_id": custom.ID,
	})
	if issue.TemplateID != custom.ID || issue.PromptTemplate != custom.Content {
		t.Fatalf("issue did not use selected template: %+v template=%+v", issue, custom)
	}
}

func TestSessionAPI(t *testing.T) {
	srv := newTestServer(t)
	models := getJSON[codex.ModelListResult](t, srv, "/api/codex/models")
	if len(models.Data) != 1 || models.Data[0].ID != "gpt-5.5" {
		t.Fatalf("unexpected models: %+v", models)
	}
	list := getJSON[codex.SessionListResult](t, srv, "/api/sessions?limit=20")
	if len(list.Data) != 1 || list.Data[0].ID != "thread-1" || list.NextCursor != "next" {
		t.Fatalf("unexpected sessions: %+v", list)
	}
	created := postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"cwd": t.TempDir(), "prompt": "hello",
	})
	if created.ThreadID != "thread-new" || created.TurnID != "turn-new" {
		t.Fatalf("unexpected created session: %+v", created)
	}
}

func TestSessionAPIRemembersLastProject(t *testing.T) {
	srv := newTestServer(t)
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": t.TempDir(),
	})
	initial := getJSON[store.SessionPreferences](t, srv, "/api/sessions/preferences")
	if initial.LastProjectID != "" {
		t.Fatalf("initial preferences = %+v", initial)
	}
	_ = postJSON[runner.SessionCreateResult](t, srv, "/api/sessions", map[string]any{
		"project_id": project.ID, "prompt": "hello",
	})
	got := getJSON[store.SessionPreferences](t, srv, "/api/sessions/preferences")
	if got.LastProjectID != "demo" {
		t.Fatalf("preferences = %+v, want demo", got)
	}
}

func TestImageUploadAPIStoresAndServesImage(t *testing.T) {
	srv := newTestServer(t)
	body, contentType := multipartBody(t, "file", "screenshot.png", "image/png",
		[]byte("\x89PNG\r\n\x1a\nfake image bytes"))
	req := httptest.NewRequest(http.MethodPost, "/api/uploads/images", body)
	req.Header.Set("Content-Type", contentType)
	upload := decodeResponse[store.Upload](t, srv, req, http.StatusCreated)
	if upload.ID == "" || upload.OriginalName != "screenshot.png" ||
		upload.MimeType != "image/png" || upload.SizeBytes == 0 {
		t.Fatalf("unexpected upload response: %+v", upload)
	}
	if !strings.HasPrefix(upload.URL, "/api/uploads/") {
		t.Fatalf("upload url should point to api content endpoint: %+v", upload)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/uploads/"+upload.ID+"/content", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, getReq)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET upload status=%d body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content-type = %q", got)
	}
	if !bytes.Contains(rr.Body.Bytes(), []byte("fake image bytes")) {
		t.Fatalf("served body mismatch: %q", rr.Body.String())
	}
}

func TestWebDirServesSPAWithoutShadowingAPI(t *testing.T) {
	webDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte("<main>runner ui</main>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	assetsDir := filepath.Join(webDir, "assets")
	if err := os.Mkdir(assetsDir, 0o755); err != nil {
		t.Fatalf("mkdir assets: %v", err)
	}
	if err := os.WriteFile(filepath.Join(assetsDir, "app.js"), []byte("console.log('ok')"), 0o644); err != nil {
		t.Fatalf("write asset: %v", err)
	}

	srv := newTestServerWithWeb(t, webDir)
	assertBodyContains(t, srv, "/", "runner ui")
	assertBodyContains(t, srv, "/assets/app.js", "console.log")
	assertBodyContains(t, srv, "/issues/42", "runner ui")

	req := httptest.NewRequest(http.MethodGet, "/api/nope", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound || strings.Contains(rr.Body.String(), "runner ui") {
		t.Fatalf("API should keep JSON 404, status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestEmbeddedSPAFSServesFallback(t *testing.T) {
	webFS := fstest.MapFS{
		"index.html":    {Data: []byte("<main>embedded ui</main>")},
		"assets/app.js": {Data: []byte("console.log('embedded')")},
	}
	srv := newTestServerWithWebHandler(t, newFSSPAHandler(webFS))

	assertBodyContains(t, srv, "/", "embedded ui")
	assertBodyContains(t, srv, "/assets/app.js", "embedded")
	assertBodyContains(t, srv, "/sessions/thread-1", "embedded ui")

	req := httptest.NewRequest(http.MethodGet, "/api/nope", nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound || strings.Contains(rr.Body.String(), "embedded ui") {
		t.Fatalf("API should keep JSON 404, status=%d body=%s", rr.Code, rr.Body.String())
	}
}

type projectSyncTestResponse struct {
	Source  string `json:"source"`
	Summary struct {
		Discovered int `json:"discovered"`
		Created    int `json:"created"`
		Existing   int `json:"existing"`
		Skipped    int `json:"skipped"`
	} `json:"summary"`
	Created  []store.Project `json:"created"`
	Existing []store.Project `json:"existing"`
	Skipped  []struct {
		CWD    string `json:"cwd"`
		Reason string `json:"reason"`
	} `json:"skipped"`
}

func TestSyncCodexProjectsCreatesMissingWorkspaceRoots(t *testing.T) {
	srv := newTestServer(t)
	root := t.TempDir()
	existingPath := filepath.Join(root, "movo-web")
	newPath := filepath.Join(root, "mindnote")
	missingPath := filepath.Join(root, "missing")
	if err := os.Mkdir(existingPath, 0o755); err != nil {
		t.Fatalf("mkdir existing: %v", err)
	}
	if err := os.Mkdir(newPath, 0o755); err != nil {
		t.Fatalf("mkdir new: %v", err)
	}
	postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "movo-web", "name": "movo-web", "cwd": existingPath, "auto_run": 1,
	})
	statePath := filepath.Join(root, "codex-state.json")
	writeCodexState(t, statePath, existingPath, newPath, missingPath)
	t.Setenv("CODEX_RUNNER_CODEX_STATE", statePath)

	result := postJSON[projectSyncTestResponse](t, srv, "/api/projects/sync/codex", map[string]any{})
	if result.Source != statePath {
		t.Fatalf("source mismatch: %+v", result)
	}
	if result.Summary.Discovered != 4 || result.Summary.Created != 1 ||
		result.Summary.Existing != 1 || result.Summary.Skipped != 2 {
		t.Fatalf("unexpected summary: %+v", result.Summary)
	}
	if len(result.Created) != 1 || result.Created[0].CWD != newPath ||
		result.Created[0].AutoRun != 0 || result.Created[0].Model != "codex-default" {
		t.Fatalf("unexpected created project: %+v", result.Created)
	}

	again := postJSON[projectSyncTestResponse](t, srv, "/api/projects/sync/codex", map[string]any{})
	if again.Summary.Created != 0 || again.Summary.Existing != 2 || again.Summary.Skipped != 2 {
		t.Fatalf("sync should be idempotent: %+v", again.Summary)
	}
}

func writeCodexState(t *testing.T, path, existingPath, newPath, missingPath string) {
	t.Helper()
	state := map[string]any{
		"electron-saved-workspace-roots": []string{existingPath, newPath, missingPath},
		"remote-projects": []map[string]string{
			{"hostId": "remote-ssh-discovered:claw", "remotePath": "/home/xiaobei/project"},
		},
	}
	body, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write state: %v", err)
	}
}

func assertAPIProjectOrder(t *testing.T, projects []store.Project, want []string) {
	t.Helper()
	if len(projects) != len(want) {
		t.Fatalf("project count = %d, want %d: %+v", len(projects), len(want), projects)
	}
	for index, project := range projects {
		if project.ID != want[index] {
			t.Fatalf("project order = %+v, want %v", apiProjectIDs(projects), want)
		}
	}
}

func apiProjectIDs(projects []store.Project) []string {
	ids := make([]string, 0, len(projects))
	for _, project := range projects {
		ids = append(ids, project.ID)
	}
	return ids
}

func newTestServer(t *testing.T) *Server {
	return newTestServerWithWeb(t, "")
}

func newTestServerWithWeb(t *testing.T, webDir string) *Server {
	t.Helper()
	return newTestServerWithWebHandler(t, newWebHandler(webDir))
}

func newTestServerWithWebHandler(t *testing.T, web http.Handler) *Server {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	bus := events.NewBus()
	r := runner.New(st, bus, noopCodex{ch: make(chan codex.Event)})
	srv := NewServerWithWebDir(st, bus, r, "")
	srv.web = web
	return srv
}

func assertBodyContains(t *testing.T, h http.Handler, path, want string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), want) {
		t.Fatalf("GET %s status=%d body=%s want=%q", path, rr.Code, rr.Body.String(), want)
	}
}

func postJSON[T any](t *testing.T, h http.Handler, path string, body any) T {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	return decodeResponse[T](t, h, req, http.StatusCreated, http.StatusOK)
}

func getJSON[T any](t *testing.T, h http.Handler, path string) T {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	return decodeResponse[T](t, h, req, http.StatusOK)
}

func patchJSON[T any](t *testing.T, h http.Handler, path string, body any) T {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPatch, path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	return decodeResponse[T](t, h, req, http.StatusOK)
}

func decodeResponse[T any](t *testing.T, h http.Handler, req *http.Request, ok ...int) T {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if !statusOK(rr.Code, ok) {
		t.Fatalf("%s %s status=%d body=%s", req.Method, req.URL.Path, rr.Code, rr.Body.String())
	}
	var out T
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v body=%s", err, rr.Body.String())
	}
	return out
}

func statusOK(code int, allowed []int) bool {
	for _, value := range allowed {
		if code == value {
			return true
		}
	}
	return false
}

func multipartBody(t *testing.T, field, filename, contentType string, data []byte) (io.Reader, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreatePart(textprotoMIMEHeader(field, filename, contentType))
	if err != nil {
		t.Fatalf("create multipart part: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write multipart part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &body, writer.FormDataContentType()
}

func textprotoMIMEHeader(field, filename, contentType string) textproto.MIMEHeader {
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="`+field+`"; filename="`+filename+`"`)
	header.Set("Content-Type", contentType)
	return header
}
