package runner

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

const maxDirtyWorktreeEntries = 12

func (r *Runner) ensureCleanWorktree(ctx context.Context, cwd string) error {
	if !r.dirtyWorktreeCheck {
		return nil
	}
	if !isGitWorktree(ctx, cwd) {
		return nil
	}
	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "status",
		"--porcelain=v1", "--untracked-files=normal").Output()
	if err != nil {
		return fmt.Errorf("Runner 无法检查目标工作区 git status: %w", err)
	}
	lines := statusLines(string(out))
	if len(lines) == 0 {
		return nil
	}
	return dirtyWorktreeError{entries: lines}
}

func isGitWorktree(ctx context.Context, cwd string) bool {
	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse",
		"--is-inside-work-tree").Output()
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

func statusLines(output string) []string {
	raw := strings.Split(strings.TrimSpace(output), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

type dirtyWorktreeError struct {
	entries []string
}

func (e dirtyWorktreeError) Error() string {
	shown := e.entries
	if len(shown) > maxDirtyWorktreeEntries {
		shown = shown[:maxDirtyWorktreeEntries]
	}
	var b strings.Builder
	b.WriteString("Runner 阻断执行：目标工作区存在未提交修改。")
	b.WriteString("请先提交或处理这些改动，或显式禁用 dirty worktree 检查后重试。")
	b.WriteString("未提交条目（仅 git status，不包含 diff）：")
	for _, line := range shown {
		b.WriteString("\n- ")
		b.WriteString(line)
	}
	if hidden := len(e.entries) - len(shown); hidden > 0 {
		fmt.Fprintf(&b, "\n- ... 还有 %d 项", hidden)
	}
	return b.String()
}
