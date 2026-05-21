package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) routeCronTasks(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 1 {
		s.handleCronTasks(w, r)
		return
	}
	id, err := parseIssueID(parts[1])
	if err != nil {
		writeError(w, http.StatusBadRequest, "cron task id 不合法")
		return
	}
	if len(parts) == 2 {
		s.handleCronTask(w, r, id)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleCronTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		tasks, err := s.store.ListCronTasks(r.Context())
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, tasks)
	case http.MethodPost:
		s.createCronTask(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleCronTask(w http.ResponseWriter, r *http.Request, id int64) {
	switch r.Method {
	case http.MethodGet:
		task, err := s.store.GetCronTask(r.Context(), id)
		if err != nil {
			handleErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, task)
	case http.MethodPatch:
		s.patchCronTask(w, r, id)
	case http.MethodDelete:
		if err := s.store.DeleteCronTask(r.Context(), id); err != nil {
			handleErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) createCronTask(w http.ResponseWriter, r *http.Request) {
	var task store.CronTask
	if err := decodeJSON(r, &task); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	created, err := s.store.CreateCronTask(r.Context(), task)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) patchCronTask(w http.ResponseWriter, r *http.Request, id int64) {
	var patch store.CronTaskPatch
	if err := decodeJSON(r, &patch); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	updated, err := s.store.UpdateCronTask(r.Context(), id, patch)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}
