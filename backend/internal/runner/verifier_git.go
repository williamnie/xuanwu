package runner

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

func BuildVerifierGitSummary(ctx context.Context, cwd string) string {
	if strings.TrimSpace(cwd) == "" || !isGitWorktree(ctx, cwd) {
		return "not a git worktree"
	}
	parts := []string{
		gitSummarySection(ctx, cwd, "last commit", "log", "-1", "--oneline"),
		gitSummarySection(ctx, cwd, "status", "status", "--short"),
		gitSummarySection(ctx, cwd, "diff stat", "diff", "--stat", "HEAD"),
		gitSummarySection(ctx, cwd, "diff files", "diff", "--name-only", "HEAD"),
	}
	return strings.Join(nonEmptyStrings(parts), "\n")
}

func gitSummarySection(ctx context.Context, cwd, label, subcommand string, args ...string) string {
	out, err := gitOutput(ctx, cwd, append([]string{subcommand}, args...)...)
	if err != nil {
		return fmt.Sprintf("%s: unavailable (%v)", label, err)
	}
	text := strings.TrimSpace(out)
	if text == "" {
		text = "(none)"
	}
	return label + ":\n" + truncateVerifierField(text)
}

func gitOutput(ctx context.Context, cwd string, args ...string) (string, error) {
	cmdArgs := append([]string{"-C", cwd}, args...)
	out, err := exec.CommandContext(ctx, "git", cmdArgs...).CombinedOutput()
	return string(out), err
}

func nonEmptyStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}
