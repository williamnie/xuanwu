package runner

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type ProjectReferenceSearchFilter struct {
	Type  string
	Query string
	Limit int
}

type ProjectReferenceSearchResult struct {
	Files   []ProjectPathReference `json:"files"`
	Folders []ProjectPathReference `json:"folders"`
}

type ProjectPathReference struct {
	Type      string `json:"type"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
	FileCount int    `json:"file_count,omitempty"`
}

func SearchProjectReferences(cwd string, filter ProjectReferenceSearchFilter) (ProjectReferenceSearchResult, error) {
	root, err := filepath.Abs(strings.TrimSpace(cwd))
	if err != nil || root == "" {
		return ProjectReferenceSearchResult{}, err
	}
	limit := referenceSearchLimit(filter.Limit)
	state := projectReferenceSearchState{root: root, filter: normalizeReferenceSearchFilter(filter), limit: limit}
	state.ignored = loadProjectIgnorePatterns(root)
	if err := filepath.WalkDir(root, state.visit); err != nil {
		return ProjectReferenceSearchResult{}, err
	}
	sortProjectReferences(state.result.Files)
	sortProjectReferences(state.result.Folders)
	return state.result, nil
}

type projectReferenceSearchState struct {
	root    string
	filter  ProjectReferenceSearchFilter
	limit   int
	ignored []string
	result  ProjectReferenceSearchResult
}

func (s *projectReferenceSearchState) visit(path string, d os.DirEntry, err error) error {
	if err != nil || path == s.root {
		return nil
	}
	rel, relErr := filepath.Rel(s.root, path)
	if relErr != nil {
		return nil
	}
	rel = filepath.ToSlash(rel)
	if shouldSkipProjectReference(rel, d, s.ignored) {
		if d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	}
	if !projectReferenceMatches(rel, s.filter.Query) {
		return nil
	}
	return s.add(path, rel, d)
}

func (s *projectReferenceSearchState) add(path, rel string, d os.DirEntry) error {
	if d.IsDir() && wantReferenceType(s.filter.Type, "folder") && len(s.result.Folders) < s.limit {
		s.result.Folders = append(s.result.Folders, ProjectPathReference{Type: "folder", Path: rel, FileCount: countFolderFiles(path, s.ignored)})
	}
	if !d.IsDir() && wantReferenceType(s.filter.Type, "file") && len(s.result.Files) < s.limit {
		info, err := d.Info()
		if err != nil {
			return nil
		}
		s.result.Files = append(s.result.Files, ProjectPathReference{Type: "file", Path: rel, SizeBytes: info.Size()})
	}
	return nil
}

func referenceSearchLimit(limit int) int {
	if limit <= 0 {
		return 40
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func normalizeReferenceSearchFilter(filter ProjectReferenceSearchFilter) ProjectReferenceSearchFilter {
	filter.Type = strings.ToLower(strings.TrimSpace(filter.Type))
	filter.Query = strings.ToLower(strings.TrimSpace(filter.Query))
	return filter
}

func wantReferenceType(current, want string) bool {
	return current == "" || current == "all" || current == want
}

func projectReferenceMatches(rel, query string) bool {
	return query == "" || strings.Contains(strings.ToLower(rel), query)
}

func shouldSkipProjectReference(rel string, d os.DirEntry, ignored []string) bool {
	name := d.Name()
	if commonExcludedPathName(name) || strings.HasPrefix(name, ".") {
		return true
	}
	return isIgnoredProjectPath(rel, ignored)
}

func commonExcludedPathName(name string) bool {
	switch name {
	case ".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo":
		return true
	}
	return false
}

func loadProjectIgnorePatterns(root string) []string {
	data, err := os.ReadFile(filepath.Join(root, ".gitignore"))
	if err != nil {
		return nil
	}
	patterns := []string{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "!") {
			continue
		}
		patterns = append(patterns, strings.Trim(line, "/"))
	}
	return patterns
}

func isIgnoredProjectPath(rel string, patterns []string) bool {
	for _, pattern := range patterns {
		if rel == pattern || strings.HasPrefix(rel, pattern+"/") || filepath.Base(rel) == pattern {
			return true
		}
	}
	return false
}

func countFolderFiles(root string, ignored []string) int {
	count := 0
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == root || d.IsDir() {
			return nil
		}
		if shouldSkipProjectReference(filepath.ToSlash(d.Name()), d, ignored) {
			return nil
		}
		count++
		return nil
	})
	return count
}

func sortProjectReferences(items []ProjectPathReference) {
	sort.Slice(items, func(i, j int) bool { return items[i].Path < items[j].Path })
}
