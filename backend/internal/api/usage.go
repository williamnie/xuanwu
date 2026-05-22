package api

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	codexusage "github.com/xiaobei/codex-issue-runner/backend/internal/usage"
)

const codexUsageCacheTTL = 60 * time.Second

type codexUsageCache struct {
	mu        sync.Mutex
	report    codexusage.CodexUsageReport
	expiresAt time.Time
	ready     bool
}

func (s *Server) WarmCodexUsageCache(ctx context.Context) {
	_, _ = s.cachedCodexUsage(ctx, true)
}

func (s *Server) routeUsage(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) != 2 || parts[1] != "codex" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	report, err := s.cachedCodexUsage(r.Context(), false)
	if err != nil {
		handleUsageErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) cachedCodexUsage(
	ctx context.Context,
	force bool,
) (codexusage.CodexUsageReport, error) {
	now := time.Now()
	s.usageCache.mu.Lock()
	defer s.usageCache.mu.Unlock()
	if s.usageCache.ready && !force && now.Before(s.usageCache.expiresAt) {
		return s.usageCache.report, nil
	}
	report, err := codexusage.ReadCodexUsage(ctx, s.codexSessionsDir, now)
	if err != nil && s.usageCache.ready {
		return s.usageCache.report, nil
	}
	if err != nil {
		return codexusage.CodexUsageReport{}, err
	}
	s.usageCache.report = report
	s.usageCache.expiresAt = now.Add(codexUsageCacheTTL)
	s.usageCache.ready = true
	return report, nil
}

func handleUsageErr(w http.ResponseWriter, err error) {
	if errors.Is(err, codexusage.ErrNoCodexSessionsDir) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}
