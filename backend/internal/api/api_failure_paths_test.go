package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type apiFailureCase struct {
	name        string
	newServer   func(*testing.T) *Server
	method      string
	path        string
	body        string
	contentType string
	wantStatus  int
	wantBody    string
}

func TestProjectAPIFailurePaths(t *testing.T) {
	runAPIFailureCases(t, []apiFailureCase{
		{
			name: "rejects invalid reorder payload", method: http.MethodPatch,
			path: "/api/projects", body: `{"project_ids":[]}`,
			contentType: "application/json", wantStatus: http.StatusBadRequest,
			wantBody: "project order 不能为空",
		},
		{
			name: "returns not found for missing project", method: http.MethodGet,
			path: "/api/projects/missing", wantStatus: http.StatusNotFound,
			wantBody: "资源不存在",
		},
		{
			name: "rejects unsupported collection method", method: http.MethodPut,
			path: "/api/projects", wantStatus: http.StatusMethodNotAllowed,
			wantBody: "method not allowed",
		},
		{
			name:   "rejects enabling auto-run for unsupported provider",
			method: http.MethodPatch, path: "/api/projects/unsupported",
			body: `{"auto_run":1}`, contentType: "application/json",
			newServer:  newUnsupportedProviderProjectServer,
			wantStatus: http.StatusBadRequest, wantBody: `provider \"claude\" 暂不支持`,
		},
	})
}

func TestIssueAPIFailurePaths(t *testing.T) {
	runAPIFailureCases(t, []apiFailureCase{
		{
			name: "rejects invalid issue id", method: http.MethodGet,
			path: "/api/issues/not-a-number", wantStatus: http.StatusBadRequest,
			wantBody: "issue id 不合法",
		},
		{
			name: "returns not found for missing issue", method: http.MethodGet,
			path: "/api/issues/404", wantStatus: http.StatusNotFound,
			wantBody: "资源不存在",
		},
		{
			name: "rejects unsupported collection method", method: http.MethodDelete,
			path: "/api/issues", wantStatus: http.StatusMethodNotAllowed,
			wantBody: "method not allowed",
		},
		{
			name:   "rejects todo create for unsupported project provider",
			method: http.MethodPost, path: "/api/issues",
			body:        `{"project_id":"unsupported","title":"blocked","status":"todo"}`,
			contentType: "application/json", newServer: newUnsupportedProviderProjectServer,
			wantStatus: http.StatusBadRequest, wantBody: `provider \"claude\" 暂不支持`,
		},
		{
			name:   "rejects enqueue for unsupported project provider",
			method: http.MethodPost, path: "/api/issues/1/enqueue",
			body: `{}`, contentType: "application/json",
			newServer:  newUnsupportedProviderIssueServer,
			wantStatus: http.StatusBadRequest, wantBody: `provider \"claude\" 暂不支持`,
		},
	})
}

func TestSessionAPIFailurePaths(t *testing.T) {
	runAPIFailureCases(t, []apiFailureCase{
		{
			name: "rejects create without cwd", method: http.MethodPost,
			path: "/api/sessions", body: `{}`, contentType: "application/json",
			wantStatus: http.StatusBadRequest, wantBody: "cwd 不能为空",
		},
		{
			name: "returns not found for missing session", method: http.MethodGet,
			path: "/api/sessions/missing", newServer: newSessionNotFoundTestServer,
			wantStatus: http.StatusNotFound, wantBody: "资源不存在",
		},
		{
			name: "rejects unsupported collection method", method: http.MethodDelete,
			path: "/api/sessions", wantStatus: http.StatusMethodNotAllowed,
			wantBody: "method not allowed",
		},
		{
			name:   "rejects unsupported project provider for session create",
			method: http.MethodPost, path: "/api/sessions",
			body:        `{"project_id":"unsupported","prompt":"hello"}`,
			contentType: "application/json", newServer: newUnsupportedProviderProjectServer,
			wantStatus: http.StatusBadRequest, wantBody: `provider \"claude\" 暂不支持`,
		},
	})
}

func TestCronTaskAPIFailurePaths(t *testing.T) {
	runAPIFailureCases(t, []apiFailureCase{
		{
			name: "rejects invalid cron task id", method: http.MethodGet,
			path: "/api/cron-tasks/not-a-number", wantStatus: http.StatusBadRequest,
			wantBody: "cron task id 不合法",
		},
		{
			name: "returns not found for missing cron task", method: http.MethodGet,
			path: "/api/cron-tasks/404", wantStatus: http.StatusNotFound,
			wantBody: "资源不存在",
		},
		{
			name: "rejects unsupported collection method", method: http.MethodPut,
			path: "/api/cron-tasks", wantStatus: http.StatusMethodNotAllowed,
			wantBody: "method not allowed",
		},
	})
}

func TestUploadAPIFailurePaths(t *testing.T) {
	runAPIFailureCases(t, []apiFailureCase{
		{
			name: "rejects non multipart image upload", method: http.MethodPost,
			path: "/api/uploads/images", body: `{}`, contentType: "application/json",
			wantStatus: http.StatusBadRequest, wantBody: "图片上传请求不合法",
		},
		{
			name: "returns not found for missing upload", method: http.MethodGet,
			path: "/api/uploads/missing/content", wantStatus: http.StatusNotFound,
			wantBody: "资源不存在",
		},
		{
			name: "rejects unsupported upload method", method: http.MethodGet,
			path: "/api/uploads/images", wantStatus: http.StatusMethodNotAllowed,
			wantBody: "method not allowed",
		},
	})
}

func runAPIFailureCases(t *testing.T, cases []apiFailureCase) {
	t.Helper()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := testServerForFailureCase(t, tc)
			req := newFailureRequest(t, tc)
			rr := httptest.NewRecorder()
			srv.ServeHTTP(rr, req)
			if rr.Code != tc.wantStatus {
				t.Fatalf("status=%d body=%s, want %d", rr.Code, rr.Body.String(), tc.wantStatus)
			}
			if !strings.Contains(rr.Body.String(), tc.wantBody) {
				t.Fatalf("body=%s, want substring %q", rr.Body.String(), tc.wantBody)
			}
		})
	}
}

func testServerForFailureCase(t *testing.T, tc apiFailureCase) *Server {
	t.Helper()
	if tc.newServer != nil {
		return tc.newServer(t)
	}
	return newTestServer(t)
}

func newFailureRequest(t *testing.T, tc apiFailureCase) *http.Request {
	t.Helper()
	req := httptest.NewRequest(tc.method, tc.path, bytes.NewBufferString(tc.body))
	if tc.contentType != "" {
		req.Header.Set("Content-Type", tc.contentType)
	}
	return req
}

type sessionNotFoundCodex struct {
	noopCodex
}

func newSessionNotFoundTestServer(t *testing.T) *Server {
	t.Helper()
	client := sessionNotFoundCodex{noopCodex{ch: make(chan codex.Event)}}
	return newTestServerWithCodex(t, client)
}

func (c sessionNotFoundCodex) ThreadResume(context.Context, string) (codex.Session, error) {
	return codex.Session{}, store.ErrNotFound
}

func newUnsupportedProviderProjectServer(t *testing.T) *Server {
	t.Helper()
	srv := newTestServerWithCodex(t, noopCodex{ch: make(chan codex.Event)})
	project := postJSON[store.Project](t, srv, "/api/projects", map[string]any{
		"id": "unsupported", "cwd": t.TempDir(),
	})
	provider := "claude"
	if _, err := srv.store.UpdateProject(
		context.Background(), project.ID, store.ProjectPatch{Provider: &provider},
	); err != nil {
		t.Fatalf("seed unsupported provider: %v", err)
	}
	return srv
}

func newUnsupportedProviderIssueServer(t *testing.T) *Server {
	t.Helper()
	srv := newUnsupportedProviderProjectServer(t)
	postJSON[store.Issue](t, srv, "/api/issues", map[string]any{
		"project_id": "unsupported", "title": "blocked", "status": store.StatusTriage,
	})
	return srv
}
