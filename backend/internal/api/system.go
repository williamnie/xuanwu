package api

import "net/http"

func (s *Server) routeSystem(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) == 2 && parts[1] == "restart" {
		s.handleRestart(w, r)
		return
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if s.restart == nil {
		writeError(w, http.StatusServiceUnavailable, "restart unavailable")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{
		"status":  "restarting",
		"message": "重启请求已提交",
	})
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	go s.restart()
}
