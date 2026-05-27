package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

type runState struct {
	runID     string
	sessionID string
	turnID    string
	stderr    strings.Builder
	secrets   []string
}

func claudeArgs(input agent.IssueRunInput) []string {
	args := []string{
		"-p", "--verbose", "--bare", "--output-format", "stream-json",
		"--permission-mode", claudePermissionMode(input.ApprovalPolicy),
		"--allowedTools", claudeAllowedTools(input.Sandbox),
	}
	if model := strings.TrimSpace(input.Model); model != "" && model != "codex-default" {
		args = append(args, "--model", model)
	}
	args = append(args, "--max-turns", "50", input.Prompt)
	return args
}

func claudeAllowedTools(sandbox string) string {
	switch strings.ToLower(strings.TrimSpace(sandbox)) {
	case "read-only":
		return "Read,Grep,Glob,LS,Bash(codex-issue-runner issue update:*),Bash(curl:*)"
	default:
		return "Read,Grep,Glob,LS,Edit,MultiEdit,Write,Bash"
	}
}

func claudePermissionMode(policy string) string {
	switch strings.ToLower(strings.TrimSpace(policy)) {
	case "never", "on-request", "danger-only":
		return "dontAsk"
	default:
		return "default"
	}
}

func scanJSONLines(reader io.Reader, log func(agent.Event), state *runState, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if event, ok := normalizedEvent(line, state); ok {
			log(event)
		}
	}
}

func waitCommand(
	ctx context.Context,
	input agent.IssueRunInput,
	cmd *exec.Cmd,
	stdout io.Reader,
	stderr io.Reader,
	runID string,
	env []string,
) (agent.IssueRunResult, error) {
	state := &runState{runID: runID, secrets: secretValues(env)}
	input.Log(agent.Event{Type: events.AgentTurnStarted, Provider: agent.ProviderClaudeCode,
		ThreadID: runID, TurnID: runID, Status: "started"})
	var wg sync.WaitGroup
	wg.Add(2)
	go scanJSONLines(stdout, input.Log, state, &wg)
	go scanStderr(stderr, input.Log, state, &wg)
	waitErr := cmd.Wait()
	wg.Wait()
	if ctx.Err() != nil {
		return agent.IssueRunResult{}, ctx.Err()
	}
	if waitErr != nil {
		return agent.IssueRunResult{}, commandError(input.Log, state, waitErr)
	}
	return agent.IssueRunResult{
		ProviderRunID:     runID,
		ProviderSessionID: firstNonEmpty(state.sessionID, runID),
		ProviderTurnID:    firstNonEmpty(state.turnID, runID),
	}, nil
}

func commandError(log func(agent.Event), state *runState, err error) error {
	message := classifyFailure(err, state.stderr.String(), state)
	log(agent.Event{Type: events.AgentError, Provider: agent.ProviderClaudeCode,
		ThreadID: firstNonEmpty(state.sessionID, state.runID),
		TurnID:   firstNonEmpty(state.turnID, state.runID), Error: message})
	return errors.New(message)
}

func scanStderr(reader io.Reader, log func(agent.Event), state *runState, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		text := state.redact(scanner.Text())
		if text == "" {
			continue
		}
		if state.stderr.Len() < 4096 {
			state.stderr.WriteString(text)
			state.stderr.WriteByte('\n')
		}
		log(agent.Event{Type: events.AgentMessageDelta, Provider: agent.ProviderClaudeCode,
			ThreadID: firstNonEmpty(state.sessionID, state.runID), TurnID: firstNonEmpty(state.turnID, state.runID),
			Text: text, Raw: agent.RawEvent{Method: "stderr", Payload: text}})
	}
}

func normalizedEvent(line string, state *runState) (agent.Event, bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return agent.Event{}, false
	}
	var record map[string]any
	if err := json.Unmarshal([]byte(line), &record); err != nil {
		return agent.Event{Type: events.AgentMessageDelta, Provider: agent.ProviderClaudeCode,
			ThreadID: firstNonEmpty(state.sessionID, state.runID), TurnID: firstNonEmpty(state.turnID, state.runID), Text: state.redact(line)}, true
	}
	state.sessionID = firstNonEmpty(stringField(record, "session_id"), state.sessionID)
	raw := agent.RawEvent{Method: stringField(record, "type"), Payload: state.redact(line)}
	switch stringField(record, "type") {
	case "system":
		return systemEvent(record, state, raw)
	case "assistant":
		return assistantEvent(record, state, raw)
	case "result":
		return resultEvent(record, state, raw), true
	}
	return agent.Event{}, false
}

func systemEvent(record map[string]any, state *runState, raw agent.RawEvent) (agent.Event, bool) {
	if stringField(record, "subtype") != "init" {
		return agent.Event{}, false
	}
	return agent.Event{Type: events.AgentTurnStarted, Provider: agent.ProviderClaudeCode,
		ThreadID: firstNonEmpty(state.sessionID, state.runID), TurnID: state.runID, Status: "started", Raw: raw}, true
}

func resultEvent(record map[string]any, state *runState, raw agent.RawEvent) agent.Event {
	state.turnID = firstNonEmpty(stringField(record, "uuid"), state.turnID, state.runID)
	event := agent.Event{Provider: agent.ProviderClaudeCode,
		ThreadID: firstNonEmpty(state.sessionID, state.runID), TurnID: state.turnID,
		Status: firstNonEmpty(resultStatus(record), "completed"), Raw: raw}
	if boolField(record, "is_error") {
		event.Type = events.AgentError
		event.Error = resultError(record)
		return event
	}
	event.Type = events.AgentTurnCompleted
	return event
}

func assistantEvent(record map[string]any, state *runState, raw agent.RawEvent) (agent.Event, bool) {
	content := nestedList(record, "message", "content")
	for _, item := range content {
		if event, ok := contentEvent(item, state, raw); ok {
			return event, true
		}
	}
	return agent.Event{}, false
}

func contentEvent(item map[string]any, state *runState, raw agent.RawEvent) (agent.Event, bool) {
	switch stringField(item, "type") {
	case "text":
		text := stringField(item, "text")
		if text == "" {
			return agent.Event{}, false
		}
		return agent.Event{Type: events.AgentMessageDelta, Provider: agent.ProviderClaudeCode,
			ThreadID: firstNonEmpty(state.sessionID, state.runID), TurnID: firstNonEmpty(state.turnID, state.runID),
			Text: state.redact(text), Raw: raw}, true
	case "tool_use":
		return agent.Event{Type: events.AgentCommandStarted, Provider: agent.ProviderClaudeCode,
			ThreadID: firstNonEmpty(state.sessionID, state.runID), TurnID: firstNonEmpty(state.turnID, state.runID),
			Command: toolCommand(item, state), Raw: raw}, true
	}
	return agent.Event{}, false
}

func toolCommand(item map[string]any, state *runState) string {
	if input, ok := item["input"].(map[string]any); ok {
		if command := stringField(input, "command"); command != "" {
			return state.redact(command)
		}
	}
	return stringField(item, "name")
}

func resultStatus(record map[string]any) string {
	return firstNonEmpty(stringField(record, "terminal_reason"), stringField(record, "stop_reason"))
}

func resultError(record map[string]any) string {
	return firstNonEmpty(stringField(record, "error"), stringField(record, "result"), resultStatus(record))
}

func nestedList(record map[string]any, keys ...string) []map[string]any {
	var current any = record
	for _, key := range keys {
		m, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = m[key]
	}
	items, ok := current.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if ok {
			out = append(out, m)
		}
	}
	return out
}

func stringField(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}

func boolField(record map[string]any, key string) bool {
	value, _ := record[key].(bool)
	return value
}

func (s *runState) redact(value string) string {
	for _, secret := range s.secrets {
		value = strings.ReplaceAll(value, secret, "[redacted]")
	}
	return value
}

func secretValues(env []string) []string {
	seen := map[string]bool{}
	values := []string{}
	for _, key := range []string{"CODEX_RUNNER_AUTH_TOKEN", "ANTHROPIC_API_KEY"} {
		for _, value := range []string{envValue(env, key), strings.TrimSpace(os.Getenv(key))} {
			if value != "" && !seen[value] {
				seen[value] = true
				values = append(values, value)
			}
		}
	}
	return values
}

func providerRunID(input agent.IssueRunInput) string {
	return "cli:claude:" + strconv.FormatInt(input.IssueID, 10)
}

func classifyFailure(err error, stderr string, state *runState) string {
	message := strings.TrimSpace(stderr)
	if message == "" {
		message = err.Error()
	}
	return "Claude Code run failed: " + state.redact(message)
}
