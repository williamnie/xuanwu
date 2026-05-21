package api

import (
	"context"
	"crypto/sha1"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codexstate"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type projectSyncSummary struct {
	Discovered int `json:"discovered"`
	Created    int `json:"created"`
	Existing   int `json:"existing"`
	Skipped    int `json:"skipped"`
}

type projectSyncResponse struct {
	Source   string                      `json:"source"`
	Summary  projectSyncSummary          `json:"summary"`
	Created  []store.Project             `json:"created"`
	Existing []store.Project             `json:"existing"`
	Skipped  []codexstate.SkippedProject `json:"skipped"`
}

func (s *Server) syncCodexProjects(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	discovery, err := codexstate.DiscoverProjects()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := s.createMissingCodexProjects(r.Context(), discovery)
	if err != nil {
		handleErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) createMissingCodexProjects(
	ctx context.Context,
	discovery codexstate.Discovery,
) (projectSyncResponse, error) {
	result := projectSyncResponse{Source: discovery.Source, Skipped: discovery.Skipped}
	existing, err := s.store.ListProjects(ctx)
	if err != nil {
		return result, err
	}
	byCWD, usedIDs := indexProjects(existing)
	for _, candidate := range discovery.Projects {
		if project, ok := byCWD[candidate.CWD]; ok {
			result.Existing = append(result.Existing, project)
			continue
		}
		project, err := s.store.CreateProject(ctx, defaultSyncedProject(candidate.CWD, usedIDs))
		if err != nil {
			return result, err
		}
		byCWD[project.CWD] = project
		usedIDs[project.ID] = true
		result.Created = append(result.Created, project)
	}
	result.Summary = syncSummary(discovery, result)
	return result, nil
}

func indexProjects(projects []store.Project) (map[string]store.Project, map[string]bool) {
	byCWD := map[string]store.Project{}
	usedIDs := map[string]bool{}
	for _, project := range projects {
		byCWD[project.CWD] = project
		usedIDs[project.ID] = true
	}
	return byCWD, usedIDs
}

func defaultSyncedProject(cwd string, usedIDs map[string]bool) store.Project {
	name := filepath.Base(cwd)
	return store.Project{
		ID: nextProjectID(name, cwd, usedIDs), Name: name, CWD: cwd,
		AutoRun: 0, Model: "codex-default", ApprovalPolicy: "never",
		Sandbox: "workspace-write",
	}
}

var nonProjectIDChar = regexp.MustCompile(`[^a-z0-9]+`)

func nextProjectID(name, cwd string, used map[string]bool) string {
	base := strings.Trim(nonProjectIDChar.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if base == "" {
		base = "project"
	}
	if !used[base] {
		return base
	}
	withHash := fmt.Sprintf("%s-%x", base, sha1.Sum([]byte(cwd)))[:len(base)+9]
	for i, id := 2, withHash; ; i++ {
		if !used[id] {
			return id
		}
		id = fmt.Sprintf("%s-%d", withHash, i)
	}
}

func syncSummary(discovery codexstate.Discovery, result projectSyncResponse) projectSyncSummary {
	return projectSyncSummary{
		Discovered: len(discovery.Projects) + len(discovery.Skipped),
		Created:    len(result.Created),
		Existing:   len(result.Existing),
		Skipped:    len(result.Skipped),
	}
}
