package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func TestCronTaskAPI(t *testing.T) {
	srv := newTestServer(t)
	nextRun := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	task := postJSON[store.CronTask](t, srv, "/api/cron-tasks", map[string]any{
		"name":        "12点运行 Triage",
		"project_id":  "demo",
		"mode":        store.CronModeOnce,
		"next_run_at": nextRun,
	})
	if task.ID == 0 || task.Action != store.CronActionTriageToTodo {
		t.Fatalf("unexpected task: %+v", task)
	}

	tasks := getJSON[[]store.CronTask](t, srv, "/api/cron-tasks")
	if len(tasks) != 1 || tasks[0].ID != task.ID {
		t.Fatalf("unexpected task list: %+v", tasks)
	}

	paused := patchJSON[store.CronTask](t, srv, "/api/cron-tasks/"+strconv.FormatInt(task.ID, 10), map[string]any{
		"status": store.CronStatusPaused,
	})
	if paused.Status != store.CronStatusPaused {
		t.Fatalf("pause failed: %+v", paused)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/cron-tasks/"+strconv.FormatInt(task.ID, 10), nil)
	rr := httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE status=%d body=%s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/cron-tasks/"+strconv.FormatInt(task.ID, 10), nil)
	rr = httptest.NewRecorder()
	srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound || !strings.Contains(rr.Body.String(), "资源不存在") {
		t.Fatalf("GET deleted status=%d body=%s", rr.Code, rr.Body.String())
	}
}
