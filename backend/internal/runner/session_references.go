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
		return resolveInstalledReference(ref, findInstalledSkill, "skill")
	case "plugin":
		return resolveInstalledReference(ref, findInstalledPlugin, "plugin")
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
		Summary:  issueReferenceSummary(issue, latestIssueRun(ctx, r.store, issue.ID)),
		Metadata: issueReferenceMetadata(issue),
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
		Summary:  projectReferenceSummary(project),
		Metadata: projectReferenceMetadata(project),
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
		Summary:  pathReferenceSummary(root, target, rel, typ, info),
		Metadata: pathReferenceMetadata(root, rel, typ, info),
	}, nil
}

func pathReferenceMetadata(root, rel, typ string, info os.FileInfo) map[string]any {
	metadata := map[string]any{"cwd": root}
	if typ == "folder" {
		metadata["file_count"] = countFolderFiles(filepath.Join(root, rel), nil)
	} else {
		metadata["size_bytes"] = info.Size()
	}
	return metadata
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
	lookup func(string) (InstalledCapability, bool),
	typ string,
) (ResolvedSessionReference, error) {
	name := firstNonEmpty(ref.Name, ref.ID, ref.Path)
	if name == "" || strings.Contains(name, string(filepath.Separator)) || strings.Contains(name, "..") {
		return ResolvedSessionReference{}, fmt.Errorf("%s name 不合法: %q", typ, name)
	}
	item, ok := lookup(name)
	if !ok {
		return ResolvedSessionReference{}, fmt.Errorf("%s %q 未安装", typ, name)
	}
	return ResolvedSessionReference{
		Type: typ, Name: name, Label: firstNonEmpty(ref.Label, name),
		Summary:  installedReferenceSummary(typ, name, item.Summary, ref.Metadata),
		Metadata: map[string]any{"path": item.Path, "summary": item.Summary, "intent": referenceIntent(ref.Metadata)},
	}, nil
}

func installedReferenceSummary(typ, name, summary string, metadata map[string]any) string {
	intent := referenceIntent(metadata)
	prefix := fmt.Sprintf("%s %s", typ, name)
	if summary != "" {
		prefix += ": " + summary
	}
	if intent == "request" {
		return prefix + " · 请求使用；当前 runner 只传达能力意图，不强制启用系统级 tool。"
	}
	return prefix + " · 作为上下文引用；不强制启用系统级 tool。"
}

func referenceIntent(metadata map[string]any) string {
	if value, ok := metadata["intent"].(string); ok && strings.TrimSpace(value) == "request" {
		return "request"
	}
	return "context"
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
