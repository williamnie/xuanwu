package codexstate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const envStatePath = "CODEX_RUNNER_CODEX_STATE"

type Discovery struct {
	Source   string
	Projects []Project
	Skipped  []SkippedProject
}

type Project struct {
	CWD string `json:"cwd"`
}

type SkippedProject struct {
	CWD    string `json:"cwd"`
	Reason string `json:"reason"`
}

type globalState struct {
	SavedRoots     []string        `json:"electron-saved-workspace-roots"`
	ActiveRoots    []string        `json:"active-workspace-roots"`
	RemoteProjects []remoteProject `json:"remote-projects"`
}

type remoteProject struct {
	HostID     string `json:"hostId"`
	RemotePath string `json:"remotePath"`
}

func DefaultGlobalStatePath() string {
	if path := os.Getenv(envStatePath); path != "" {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".codex-global-state.json"
	}
	return filepath.Join(home, ".codex", ".codex-global-state.json")
}

func DiscoverProjects() (Discovery, error) {
	return DiscoverProjectsFromFile(DefaultGlobalStatePath())
}

func DiscoverProjectsFromFile(path string) (Discovery, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return Discovery{}, err
	}
	var state globalState
	if err := json.Unmarshal(body, &state); err != nil {
		return Discovery{}, err
	}
	return buildDiscovery(path, state), nil
}

func buildDiscovery(path string, state globalState) Discovery {
	discovery := Discovery{Source: path}
	seen := map[string]bool{}
	for _, root := range append(state.SavedRoots, state.ActiveRoots...) {
		addLocalRoot(&discovery, seen, root)
	}
	for _, project := range state.RemoteProjects {
		discovery.Skipped = append(discovery.Skipped, SkippedProject{
			CWD: remoteProjectLabel(project), Reason: "remote_project",
		})
	}
	return discovery
}

func addLocalRoot(discovery *Discovery, seen map[string]bool, raw string) {
	cwd := normalizePath(raw)
	if cwd == "" || seen[cwd] {
		return
	}
	seen[cwd] = true
	if reason := skipReason(cwd); reason != "" {
		discovery.Skipped = append(discovery.Skipped, SkippedProject{CWD: cwd, Reason: reason})
		return
	}
	discovery.Projects = append(discovery.Projects, Project{CWD: cwd})
}

func normalizePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
		}
	}
	return filepath.Clean(path)
}

func skipReason(cwd string) string {
	info, err := os.Stat(cwd)
	if err != nil {
		return "path_not_found"
	}
	if !info.IsDir() {
		return "not_directory"
	}
	if isCodexWorktree(cwd) {
		return "codex_worktree"
	}
	return ""
}

func isCodexWorktree(cwd string) bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(filepath.Join(home, ".codex", "worktrees"), cwd)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..")
}

func remoteProjectLabel(project remoteProject) string {
	if project.HostID == "" {
		return project.RemotePath
	}
	return project.HostID + ":" + project.RemotePath
}
