package claude

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

func TestProviderProbeReportsVersionPathAndAuthWithoutSecrets(t *testing.T) {
	dir := t.TempDir()
	bin := writeFakeClaude(t, dir, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "claude 2.1.114 (Claude Code)"
  exit 0
fi
exit 0
`)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ANTHROPIC_API_KEY", "secret-value")

	provider := New(Config{Command: filepath.Base(bin)})
	probe, err := provider.Probe(context.Background())
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if !probe.Available || probe.Path != bin || probe.Version != "claude 2.1.114 (Claude Code)" {
		t.Fatalf("unexpected probe: %+v", probe)
	}
	if !probe.Auth.Configured || probe.Auth.Method != "env:ANTHROPIC_API_KEY" {
		t.Fatalf("auth status mismatch: %+v", probe.Auth)
	}
	if strings.Contains(mustJSON(t, probe), "secret-value") {
		t.Fatalf("probe leaked secret: %+v", probe)
	}
}

func TestRunIssueStreamsClaudeJSONAndUsesProfileSettings(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "capture.txt")
	writeFakeClaude(t, dir, `#!/bin/sh
{
  printf 'cwd=%s\n' "$PWD"
  printf 'args=%s\n' "$*"
  printf 'env_addr=%s\n' "$CODEX_RUNNER_ADDR"
  printf 'env_token_file=%s\n' "$CODEX_RUNNER_AUTH_TOKEN_FILE"
} > "`+capture+`"
last=""
for arg do last="$arg"; done
printf 'prompt=%s\n' "$last" >> "`+capture+`"
printf '{"type":"system","subtype":"init","session_id":"sess-1","cwd":"%s","model":"sonnet"}\n' "$PWD"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from claude"}]}}\n'
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"codex-issue-runner issue update --id 42 --status done --json"}}]}}\n'
printf '{"type":"result","session_id":"sess-1","uuid":"turn-1","is_error":false,"terminal_reason":"end_turn"}\n'
`)

	cwd := t.TempDir()
	logs := []string{}
	provider := New(Config{
		Command: "claude", Env: []string{
			"PATH=" + dir + string(os.PathListSeparator) + os.Getenv("PATH"),
			"CODEX_RUNNER_ADDR=127.0.0.1:3008",
			"CODEX_RUNNER_AUTH_TOKEN_FILE=/tmp/runner-token",
		},
	})
	result, err := provider.RunIssue(context.Background(), issueInput(cwd, func(eventType, text string) {
		logs = append(logs, eventType+":"+text)
	}))
	if err != nil {
		t.Fatalf("run issue: %v", err)
	}
	if result.ProviderRunID == "" || result.ProviderSessionID != "sess-1" || result.ProviderTurnID != "turn-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	got := readFile(t, capture)
	for _, want := range []string{
		"--output-format stream-json",
		"--permission-mode dontAsk",
		"--allowedTools Read,Grep,Glob,LS,Edit,MultiEdit,Write,Bash",
		"--model sonnet",
		"--max-turns 50",
		"env_addr=127.0.0.1:3008",
		"env_token_file=/tmp/runner-token",
		"prompt=issue prompt",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("capture missing %q:\n%s", want, got)
		}
	}
	if resolved, err := filepath.EvalSymlinks(cwd); err != nil || !strings.Contains(got, "cwd="+resolved) {
		t.Fatalf("capture cwd mismatch resolved=%q err=%v:\n%s", resolved, err, got)
	}
	if !containsLog(logs, events.AgentTurnStarted, "") ||
		!containsLog(logs, events.AgentMessageDelta, "hello from claude") ||
		!containsLog(logs, events.AgentCommandStarted, "codex-issue-runner issue update") ||
		!containsLog(logs, events.AgentTurnCompleted, "") {
		t.Fatalf("normalized logs missing expected events: %+v", logs)
	}
}

func TestRunIssueUsesReadOnlyAllowedToolsForReadOnlySandbox(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "capture.txt")
	writeFakeClaude(t, dir, `#!/bin/sh
printf 'args=%s\n' "$*" > "`+capture+`"
printf '{"type":"result","session_id":"sess-1","uuid":"turn-1","is_error":false,"terminal_reason":"end_turn"}\n'
`)

	provider := New(Config{Command: "claude", Env: []string{"PATH=" + dir}})
	input := issueInput(t.TempDir(), nil)
	input.Sandbox = "read-only"
	if _, err := provider.RunIssue(context.Background(), input); err != nil {
		t.Fatalf("run issue: %v", err)
	}
	got := readFile(t, capture)
	if !strings.Contains(got, "--allowedTools Read,Grep,Glob,LS,Bash(codex-issue-runner issue update:*),Bash(curl:*)") {
		t.Fatalf("read-only allowed tools mismatch:\n%s", got)
	}
}

func TestRunIssueReturnsClearStartupBlockWhenClaudeMissing(t *testing.T) {
	provider := New(Config{Command: "missing-claude-for-test", Env: []string{"PATH=" + t.TempDir()}})
	_, err := provider.RunIssue(context.Background(), issueInput(t.TempDir(), nil))
	if err == nil || !strings.Contains(err.Error(), "Claude Code CLI unavailable") {
		t.Fatalf("err = %v, want clear missing cli error", err)
	}
}

func issueInput(cwd string, onLog func(eventType string, text string)) agent.IssueRunInput {
	return agent.IssueRunInput{
		IssueID: 42, ProjectID: "demo", CWD: cwd, Prompt: "issue prompt",
		Model: "sonnet", ApprovalPolicy: "never", Sandbox: "workspace-write",
		Log: func(event agent.Event) {
			if onLog != nil {
				onLog(event.NormalizedType(), event.Text+event.Command)
			}
		},
	}
}

func writeFakeClaude(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, "claude")
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	return path
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(body)
}

func containsLog(logs []string, eventType, text string) bool {
	for _, log := range logs {
		if strings.HasPrefix(log, eventType+":") && strings.Contains(log, text) {
			return true
		}
	}
	return false
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	return string(body)
}
