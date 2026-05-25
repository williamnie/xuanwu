package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
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
	options, err := s.codexUsageOptions(ctx, 0)
	if err != nil {
		return
	}
	_, _ = s.cachedCodexUsage(ctx, true, options)
}

func (s *Server) routeUsage(w http.ResponseWriter, r *http.Request, parts []string) {
	if len(parts) != 2 || parts[1] != "codex" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	limit, ok := parseUsageLimit(w, r)
	if !ok {
		return
	}
	report, err := s.codexUsageReport(r.Context(), limit)
	if err != nil {
		handleUsageErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) codexUsageReport(ctx context.Context, limit int) (codexusage.CodexUsageReport, error) {
	options, err := s.codexUsageOptions(ctx, limit)
	if err != nil {
		return codexusage.CodexUsageReport{}, err
	}
	if limit > 0 {
		return codexusage.ReadCodexUsageWithOptions(ctx, codexusage.CodexUsageReadRequest{
			Root: s.codexSessionsDir, Now: time.Now(), Options: options,
		})
	}
	return s.cachedCodexUsage(ctx, false, options)
}

func (s *Server) cachedCodexUsage(
	ctx context.Context,
	force bool,
	options codexusage.CodexUsageOptions,
) (codexusage.CodexUsageReport, error) {
	now := time.Now()
	s.usageCache.mu.Lock()
	defer s.usageCache.mu.Unlock()
	if s.usageCache.ready && !force && now.Before(s.usageCache.expiresAt) {
		return s.usageCache.report, nil
	}
	report, err := codexusage.ReadCodexUsageWithOptions(ctx, codexusage.CodexUsageReadRequest{
		Root: s.codexSessionsDir, Now: now, Options: options,
	})
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

func (s *Server) codexUsageOptions(ctx context.Context, limit int) (codexusage.CodexUsageOptions, error) {
	projects, err := s.store.ListProjects(ctx)
	if err != nil {
		return codexusage.CodexUsageOptions{}, err
	}
	issues, err := s.store.ListIssues(ctx, store.IssueFilter{})
	if err != nil {
		return codexusage.CodexUsageOptions{}, err
	}
	return codexusage.CodexUsageOptions{
		Limit:    limit,
		Projects: usageProjectRefs(projects),
		Issues:   usageIssueRefs(issues),
	}, nil
}

func usageProjectRefs(projects []store.Project) []codexusage.UsageProjectRef {
	refs := make([]codexusage.UsageProjectRef, 0, len(projects))
	for _, project := range projects {
		refs = append(refs, codexusage.UsageProjectRef{
			ID: project.ID, Name: project.Name, CWD: project.CWD,
		})
	}
	return refs
}

func usageIssueRefs(issues []store.Issue) []codexusage.UsageIssueRef {
	refs := make([]codexusage.UsageIssueRef, 0, len(issues))
	for _, issue := range issues {
		if sessionID := issueUsageSessionID(issue); sessionID != "" {
			refs = append(refs, codexusage.UsageIssueRef{
				ID: issue.ID, ProjectID: issue.ProjectID, SessionID: sessionID,
				Title: issue.Title, Status: issue.Status,
			})
		}
	}
	return refs
}

func issueUsageSessionID(issue store.Issue) string {
	if issue.CodexThreadID != "" {
		return issue.CodexThreadID
	}
	if issue.LatestRun == nil {
		return ""
	}
	if issue.LatestRun.ProviderSessionID != "" {
		return issue.LatestRun.ProviderSessionID
	}
	return issue.LatestRun.CodexThreadID
}

func parseUsageLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return 0, true
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 0 {
		writeError(w, http.StatusBadRequest, "limit 必须是非负整数")
		return 0, false
	}
	return limit, true
}

func handleUsageErr(w http.ResponseWriter, err error) {
	if errors.Is(err, codexusage.ErrNoCodexSessionsDir) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeError(w, http.StatusBadRequest, err.Error())
}
