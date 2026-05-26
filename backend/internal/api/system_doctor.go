package api

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type runtimeDoctor struct {
	GeneratedAt  string              `json:"generated_at"`
	Service      systemServiceStatus `json:"service"`
	Listen       doctorListenStatus  `json:"listen"`
	Auth         doctorAuthStatus    `json:"auth"`
	DB           doctorDBStatus      `json:"db"`
	Runner       systemRunnerStatus  `json:"runner"`
	Projects     []doctorProject     `json:"projects"`
	Providers    []doctorProvider    `json:"providers"`
	RecentErrors doctorRecentErrors  `json:"recent_errors"`
}

type doctorListenStatus struct {
	Addr string `json:"addr"`
}

type doctorAuthStatus struct {
	Enabled                  bool `json:"enabled"`
	CurrentRequestAuthorized bool `json:"current_request_authorized"`
}

type doctorDBStatus struct {
	OK          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
	Path        string `json:"path"`
	PathVisible bool   `json:"path_visible"`
}

type doctorProject struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Provider             string   `json:"provider"`
	ProviderCapabilities []string `json:"provider_capabilities,omitempty"`
	AutoRun              int      `json:"auto_run"`
	LoopStatus           string   `json:"loop_status"`
	Held                 bool     `json:"held"`
}

type doctorProvider struct {
	ID           string   `json:"id"`
	Label        string   `json:"label"`
	Status       string   `json:"status"`
	Available    bool     `json:"available"`
	Enabled      bool     `json:"enabled"`
	Capabilities []string `json:"capabilities,omitempty"`
}

type doctorRecentErrors struct {
	Count    int                 `json:"count"`
	LatestAt string              `json:"latest_at,omitempty"`
	Sources  []doctorErrorSource `json:"sources,omitempty"`
}

type doctorErrorSource struct {
	Source   string `json:"source"`
	Count    int    `json:"count"`
	LatestAt string `json:"latest_at,omitempty"`
}

func (s *Server) handleSystemDoctor(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, s.buildRuntimeDoctor(r.Context()))
}

func (s *Server) buildRuntimeDoctor(ctx context.Context) runtimeDoctor {
	status := s.buildSystemStatus(ctx)
	projects, _ := s.store.ListProjects(ctx)
	s.attachLoopStatus(projects)
	store.AttachProjectCapabilities(projects)
	return runtimeDoctor{
		GeneratedAt:  time.Now().UTC().Format(time.RFC3339),
		Service:      status.Service,
		Listen:       doctorListenStatus{Addr: status.Config.Addr},
		Auth:         doctorAuthStatus{Enabled: status.Config.AuthEnabled, CurrentRequestAuthorized: true},
		DB:           doctorDB(status),
		Runner:       status.Runner,
		Projects:     doctorProjects(projects),
		Providers:    doctorProviders(status.Providers),
		RecentErrors: s.recentErrors(ctx, projects),
	}
}

func doctorDB(status systemStatus) doctorDBStatus {
	return doctorDBStatus{
		OK: status.DB.OK, Error: status.DB.Error,
		Path: status.Config.DBPath, PathVisible: pathVisible(status.Config.DBPath),
	}
}

func pathVisible(path string) bool {
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func doctorProjects(projects []store.Project) []doctorProject {
	out := make([]doctorProject, 0, len(projects))
	for _, project := range projects {
		out = append(out, doctorProject{
			ID: project.ID, Name: project.Name, Provider: project.Provider,
			ProviderCapabilities: project.ProviderCapabilities, AutoRun: project.AutoRun,
			LoopStatus: project.LoopStatus, Held: project.Hold != nil,
		})
	}
	return out
}

func doctorProviders(providers []providerStatus) []doctorProvider {
	out := make([]doctorProvider, 0, len(providers))
	for _, provider := range providers {
		out = append(out, doctorProvider{
			ID: provider.ID, Label: provider.Label, Status: provider.Status,
			Available: provider.Available, Enabled: provider.Enabled,
			Capabilities: store.ProjectProviderCapabilities(provider.ID),
		})
	}
	return out
}

func (s *Server) recentErrors(ctx context.Context, projects []store.Project) doctorRecentErrors {
	sources := []doctorErrorSource{}
	sources = appendSource(sources, issueErrorSource(ctx, s.store))
	sources = appendSource(sources, cronErrorSource(ctx, s.store))
	sources = appendSource(sources, holdErrorSource(projects))
	return combineErrorSources(sources)
}

func appendSource(sources []doctorErrorSource, source doctorErrorSource) []doctorErrorSource {
	if source.Count == 0 {
		return sources
	}
	return append(sources, source)
}

func issueErrorSource(ctx context.Context, st *store.Store) doctorErrorSource {
	issues, err := st.ListIssues(ctx, store.IssueFilter{})
	if err != nil {
		return doctorErrorSource{}
	}
	source := doctorErrorSource{Source: "issues"}
	for _, issue := range issues {
		if strings.TrimSpace(issue.Error) == "" {
			continue
		}
		source.Count++
		source.LatestAt = latestTime(source.LatestAt, issue.UpdatedAt)
	}
	return source
}

func cronErrorSource(ctx context.Context, st *store.Store) doctorErrorSource {
	tasks, err := st.ListCronTasks(ctx)
	if err != nil {
		return doctorErrorSource{}
	}
	source := doctorErrorSource{Source: "cron_tasks"}
	for _, task := range tasks {
		if strings.TrimSpace(task.Error) == "" {
			continue
		}
		source.Count++
		source.LatestAt = latestTime(source.LatestAt, task.UpdatedAt)
	}
	return source
}

func holdErrorSource(projects []store.Project) doctorErrorSource {
	source := doctorErrorSource{Source: "project_holds"}
	for _, project := range projects {
		if project.Hold == nil || strings.TrimSpace(project.Hold.LastCheckError) == "" {
			continue
		}
		source.Count++
		source.LatestAt = latestTime(source.LatestAt, project.Hold.LastCheckAt)
	}
	return source
}

func combineErrorSources(sources []doctorErrorSource) doctorRecentErrors {
	result := doctorRecentErrors{Sources: sources}
	for _, source := range sources {
		result.Count += source.Count
		result.LatestAt = latestTime(result.LatestAt, source.LatestAt)
	}
	return result
}

func latestTime(current string, candidate string) string {
	if strings.TrimSpace(candidate) == "" || candidate <= current {
		return current
	}
	return candidate
}
