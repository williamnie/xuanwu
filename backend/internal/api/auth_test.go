package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTokenAuthProtectsAPIExceptHealth(t *testing.T) {
	srv := newTestServer(t)
	srv.SetAuthToken("secret-token")

	assertStatus(t, srv, http.MethodGet, "/health", "", http.StatusOK)
	assertStatus(t, srv, http.MethodGet, "/api/projects", "", http.StatusUnauthorized)
	assertStatus(t, srv, http.MethodGet, "/api/projects", "wrong-token", http.StatusUnauthorized)
	assertStatus(t, srv, http.MethodGet, "/api/projects", "secret-token", http.StatusOK)
	assertCookieStatus(t, srv, "/api/projects", "secret-token", http.StatusOK)
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
