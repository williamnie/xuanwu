package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type SessionReference struct {
	Type     string         `json:"type"`
	ID       string         `json:"id,omitempty"`
	Path     string         `json:"path,omitempty"`
	Name     string         `json:"name,omitempty"`
	Label    string         `json:"label,omitempty"`
	Source   string         `json:"source,omitempty"`
	Required bool           `json:"required,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type ResolvedSessionReference struct {
	Type     string         `json:"type"`
	ID       string         `json:"id,omitempty"`
	Path     string         `json:"path,omitempty"`
	Name     string         `json:"name,omitempty"`
	Label    string         `json:"label,omitempty"`
	Summary  string         `json:"summary"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

func (r *Runner) resolveSessionReferences(
	ctx context.Context,
	cwd string,
	refs []SessionReference,
) ([]ResolvedSessionReference, error) {
	resolved := []ResolvedSessionReference{}
	for index, ref := range refs {
		item, err := r.resolveSessionReference(ctx, cwd, ref)
		if err != nil {
			return nil, fmt.Errorf("reference[%d] %w", index, err)
		}
		resolved = append(resolved, item)
	}
	return resolved, nil
}

func (r *Runner) resolveSessionReference(
	ctx context.Context,
	cwd string,
	ref SessionReference,
) (ResolvedSessionReference, error) {
	switch strings.TrimSpace(ref.Type) {
	case "issue":
		return r.resolveIssueReference(ctx, ref)
	case "project":
		return r.resolveProjectReference(ctx, ref)
	case "file":
		return resolvePathReference(cwd, ref, false)
	case "folder":
		return resolvePathReference(cwd, ref, true)
	case "skill":
		return resolveInstalledReference(ref, installedSkillPath, "skill")
	case "plugin":
		return resolveInstalledReference(ref, installedPluginPath, "plugin")
	default:
		return ResolvedSessionReference{}, fmt.Errorf("type %q 不支持", ref.Type)
	}
}

func (r *Runner) resolveIssueReference(ctx context.Context, ref SessionReference) (ResolvedSessionReference, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(ref.ID), 10, 64)
	if err != nil || id <= 0 {
		return ResolvedSessionReference{}, fmt.Errorf("issue id 不合法: %q", ref.ID)
	}
	issue, err := r.store.GetIssue(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return ResolvedSessionReference{}, fmt.Errorf("issue %d 不存在", id)
	}
	if err != nil {
		return ResolvedSessionReference{}, err
	}
	return ResolvedSessionReference{
		Type: "issue", ID: fmt.Sprint(issue.ID), Label: issue.Title,
		Summary:  fmt.Sprintf("issue #%d [%s] %s (project: %s)", issue.ID, issue.Status, issue.Title, issue.ProjectID),
		Metadata: map[string]any{"project_id": issue.ProjectID, "status": issue.Status},
	}, nil
}

func (r *Runner) resolveProjectReference(ctx context.Context, ref SessionReference) (ResolvedSessionReference, error) {
	id := strings.TrimSpace(ref.ID)
	if id == "" {
		return ResolvedSessionReference{}, fmt.Errorf("project id 不能为空")
	}
	project, err := r.store.GetProject(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return ResolvedSessionReference{}, fmt.Errorf("project %q 不存在", id)
	}
	if err != nil {
		return ResolvedSessionReference{}, err
	}
	return ResolvedSessionReference{
		Type: "project", ID: project.ID, Label: project.Name,
		Summary:  fmt.Sprintf("project %s (%s)", project.ID, project.CWD),
		Metadata: map[string]any{"cwd": project.CWD, "provider": project.Provider},
	}, nil
}

func resolvePathReference(cwd string, ref SessionReference, wantDir bool) (ResolvedSessionReference, error) {
	root, target, rel, err := safeProjectPath(cwd, ref.Path)
	if err != nil {
		return ResolvedSessionReference{}, err
	}
	info, err := os.Stat(target)
	if os.IsNotExist(err) {
		return ResolvedSessionReference{}, fmt.Errorf("%s %q 不存在", ref.Type, ref.Path)
	}
	if err != nil {
		return ResolvedSessionReference{}, err
	}
	if wantDir != info.IsDir() {
		return ResolvedSessionReference{}, fmt.Errorf("%s %q 类型不匹配", ref.Type, ref.Path)
	}
	typ := "file"
	if wantDir {
		typ = "folder"
	}
	return ResolvedSessionReference{
		Type: typ, Path: filepath.ToSlash(rel), Label: filepath.ToSlash(rel),
		Summary:  fmt.Sprintf("%s %s (cwd: %s)", typ, filepath.ToSlash(rel), root),
		Metadata: map[string]any{"cwd": root},
	}, nil
}

func safeProjectPath(cwd, rawPath string) (string, string, string, error) {
	root, err := filepath.Abs(strings.TrimSpace(cwd))
	if err != nil || strings.TrimSpace(cwd) == "" {
		return "", "", "", fmt.Errorf("cwd 不能为空")
	}
	raw := strings.TrimSpace(rawPath)
	if raw == "" {
		return "", "", "", fmt.Errorf("path 不能为空")
	}
	target := raw
	if !filepath.IsAbs(target) {
		target = filepath.Join(root, target)
	}
	target, err = filepath.Abs(filepath.Clean(target))
	if err != nil {
		return "", "", "", err
	}
	if !pathWithin(root, target) {
		return "", "", "", fmt.Errorf("path %q 不在当前项目 cwd 内", rawPath)
	}
	rel, _ := filepath.Rel(root, target)
	return root, target, rel, nil
}

func pathWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func resolveInstalledReference(
	ref SessionReference,
	lookup func(string) (string, bool),
	typ string,
) (ResolvedSessionReference, error) {
	name := firstNonEmpty(ref.Name, ref.ID, ref.Path)
	if name == "" || strings.Contains(name, string(filepath.Separator)) || strings.Contains(name, "..") {
		return ResolvedSessionReference{}, fmt.Errorf("%s name 不合法: %q", typ, name)
	}
	path, ok := lookup(name)
	if !ok {
		return ResolvedSessionReference{}, fmt.Errorf("%s %q 未安装", typ, name)
	}
	return ResolvedSessionReference{
		Type: typ, Name: name, Label: firstNonEmpty(ref.Label, name),
		Summary:  fmt.Sprintf("%s %s (%s)", typ, name, path),
		Metadata: map[string]any{"path": path},
	}, nil
}

func installedSkillPath(name string) (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	for _, dir := range []string{"skills", "skills/.system", "superpowers/skills"} {
		path := filepath.Join(home, ".codex", dir, name, "SKILL.md")
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path, true
		}
	}
	return "", false
}

func installedPluginPath(name string) (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	root := filepath.Join(home, ".codex", "plugins", "cache")
	want := strings.ToLower(strings.TrimSpace(name))
	found := ""
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() || strings.ToLower(d.Name()) != want {
			return nil
		}
		found = path
		return filepath.SkipAll
	})
	return found, found != ""
}

func assembleSessionPrompt(prompt string, refs []ResolvedSessionReference) string {
	body := strings.TrimSpace(prompt)
	if len(refs) == 0 {
		return body
	}
	lines := []string{"附加上下文引用（已由 Codex Issue Runner 校验）："}
	for _, ref := range refs {
		lines = append(lines, "- "+ref.Summary)
	}
	if body != "" {
		lines = append(lines, "", "用户输入：", body)
	}
	return strings.Join(lines, "\n")
}

func (r *Runner) saveSessionTurnReferences(ctx context.Context, threadID, turnID string, refs []ResolvedSessionReference) {
	if len(refs) == 0 {
		return
	}
	payload, err := json.Marshal(refs)
	if err != nil {
		return
	}
	_ = r.store.SaveSessionTurnReferences(ctx, store.SessionTurnReferenceRecord{
		Provider: store.ProviderCodex, ProviderSessionID: threadID,
		ProviderTurnID: turnID, ReferencesJSON: string(payload),
	})
}
