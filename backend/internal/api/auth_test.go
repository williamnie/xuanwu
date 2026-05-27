package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTokenAuthProtectsAPIExceptHealth(t *testing.T) {
	srv := newTestServer(t)
	srv.SetAuthToken("secret-token")

	assertStatus(t, srv, http.MethodGet, "/health", "", http.StatusOK)
	assertStatus(t, srv, http.MethodGet, "/api/projects", "", http.StatusUnauthorized)
	assertStatus(t, srv, http.MethodGet, "/api/projects", "wrong-token", http.StatusUnauthorized)
	assertStatus(t, srv, http.MethodGet, "/api/projects", "secret-token", http.StatusOK)
	assertStatus(t, srv, http.MethodGet, "/api/system/status", "", http.StatusUnauthorized)
	assertStatus(t, srv, http.MethodGet, "/api/system/status", "wrong-token", http.StatusUnauthorized)
	assertStatus(t, srv, http.MethodGet, "/api/system/status", "secret-token", http.StatusOK)
	assertStatus(t, srv, http.MethodGet, "/api/events", "", http.StatusUnauthorized)
	assertStatus(t, srv, http.MethodGet, "/api/events", "wrong-token", http.StatusUnauthorized)
	assertCookieStatus(t, srv, "/api/projects", "secret-token", http.StatusOK)
}

func TestOriginPolicyProtectsSensitiveAPIAndSSE(t *testing.T) {
	srv := newTestServer(t)
	srv.SetAuthToken("secret-token")

	assertOriginStatus(t, srv, "/health", "https://evil.example", "secret-token", http.StatusOK)
	assertOriginStatus(t, srv, "/api/projects", "https://evil.example", "secret-token", http.StatusForbidden)
	assertOriginStatus(t, srv, "/api/events", "https://evil.example", "secret-token", http.StatusForbidden)
	assertOriginStatus(t, srv, "/api/projects", "http://localhost:5173", "secret-token", http.StatusOK)
}

func TestOriginPolicyAllowsConfiguredRemoteOrigin(t *testing.T) {
	srv := newTestServer(t)
	srv.SetAuthToken("secret-token")
	srv.SetSystemConfig(SystemConfig{AllowedOrigins: []string{"https://trusted.example"}})

	assertOriginStatus(t, srv, "/api/projects", "https://trusted.example", "secret-token", http.StatusOK)
	assertOriginStatus(t, srv, "/api/projects", "https://evil.example", "secret-token", http.StatusForbidden)
}

func assertStatus(t *testing.T, h http.Handler, method, path, token string, want int) {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != want {
		t.Fatalf("%s %s token=%q status=%d body=%s, want %d", method, path, token, rr.Code, rr.Body.String(), want)
	}
}

func assertCookieStatus(t *testing.T, h http.Handler, path, token string, want int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.AddCookie(&http.Cookie{Name: "codex_runner_token", Value: token})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != want {
		t.Fatalf("GET %s cookie token status=%d body=%s, want %d", path, rr.Code, rr.Body.String(), want)
	}
}

func assertOriginStatus(t *testing.T, h http.Handler, path, origin, token string, want int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Origin", origin)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != want {
		t.Fatalf("GET %s origin=%q status=%d body=%s, want %d", path, origin, rr.Code, rr.Body.String(), want)
	}
	if want == http.StatusOK && strings.HasPrefix(path, "/api/") && rr.Header().Get("Access-Control-Allow-Origin") != origin {
		t.Fatalf("GET %s origin=%q missing allow-origin header: %q", path, origin, rr.Header().Get("Access-Control-Allow-Origin"))
	}
}
