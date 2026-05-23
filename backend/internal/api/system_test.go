package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSystemRestartAPI(t *testing.T) {
	srv := newTestServer(t)
	restarted := make(chan struct{}, 1)
	srv.SetRestartFunc(func() {
		restarted <- struct{}{}
	})

	req := httptest.NewRequest(http.MethodPost, "/api/system/restart", strings.NewReader("{}"))
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s, want %d", rr.Code, rr.Body.String(), http.StatusAccepted)
	}
	if !strings.Contains(rr.Body.String(), "restarting") {
		t.Fatalf("body=%s, want restarting status", rr.Body.String())
	}
	select {
	case <-restarted:
	case <-time.After(time.Second):
		t.Fatal("restart function was not called")
	}
}
