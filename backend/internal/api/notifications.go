package api

import (
	"net/http"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (s *Server) routeNotifications(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 2 && parts[1] == "settings" {
		s.handleNotificationSettings(w, r)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleNotificationSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.writeNotificationSettings(w, r)
	case http.MethodPatch:
		s.updateNotificationSettings(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) writeNotificationSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.NotificationSettings(r.Context())
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) updateNotificationSettings(w http.ResponseWriter, r *http.Request) {
	var settings notificationSettingsRequest
	if err := decodeJSON(r, &settings); err != nil {
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON")
		return
	}
	updated, err := s.store.SaveNotificationSettings(r.Context(), settings.toStore())
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

type notificationSettingsRequest struct {
	WebhookURL  string   `json:"webhook_url"`
	Events      []string `json:"events"`
	ActiveStart string   `json:"active_start"`
	ActiveEnd   string   `json:"active_end"`
}

func (r notificationSettingsRequest) toStore() store.NotificationSettings {
	return store.NotificationSettings{
		WebhookURL: r.WebhookURL, Events: r.Events,
		ActiveStart: r.ActiveStart, ActiveEnd: r.ActiveEnd,
	}
}
