package codex

import (
	"encoding/json"
	"fmt"
	"strings"
)

func decodeID(raw json.RawMessage) (int64, error) {
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		return n, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0, err
	}
	_, err := fmt.Sscan(s, &n)
	return n, err
}

func nestedString(raw json.RawMessage, keys ...string) (string, error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return "", err
	}
	cur := v
	for _, key := range keys {
		m, ok := cur.(map[string]any)
		if !ok {
			return "", fmt.Errorf("missing object key %q", key)
		}
		cur = m[key]
	}
	s, ok := cur.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("missing string path %v", keys)
	}
	return s, nil
}

func threadStartParams(input ThreadInput) map[string]any {
	model := any(input.Model)
	if input.Model == "" || input.Model == "codex-default" {
		model = nil
	}
	params := map[string]any{
		"cwd": input.CWD, "model": model, "approvalPolicy": approvalPolicy(input.ApprovalPolicy),
		"sandbox": defaultString(input.Sandbox, "workspace-write"), "developerInstructions": input.DeveloperInstructions,
		"ephemeral": false,
	}
	if source := threadSource(input.ThreadSource); source != "" {
		params["threadSource"] = source
	}
	if input.ReasoningEffort != "" {
		params["config"] = map[string]any{"model_reasoning_effort": input.ReasoningEffort}
	}
	return params
}

func threadSource(value string) string {
	switch strings.TrimSpace(value) {
	case ThreadSourceUser, ThreadSourceSubagent, ThreadSourceMemoryConsolidation:
		return strings.TrimSpace(value)
	default:
		return ""
	}
}

func modelListParams(input ModelListInput) map[string]any {
	return map[string]any{"includeHidden": input.IncludeHidden}
}

func turnStartParams(threadID string, input []UserInput, options TurnOptions) map[string]any {
	params := map[string]any{"threadId": threadID, "input": input}
	if options.Model != "" && options.Model != "codex-default" {
		params["model"] = options.Model
	}
	if options.ReasoningEffort != "" {
		params["effort"] = options.ReasoningEffort
	}
	if options.ApprovalPolicy != "" {
		params["approvalPolicy"] = approvalPolicy(options.ApprovalPolicy)
	}
	if options.Sandbox != "" {
		params["sandboxPolicy"] = turnSandboxPolicy(options.Sandbox)
	}
	return params
}

func turnSteerParams(threadID, turnID string, input []UserInput) map[string]any {
	return map[string]any{"threadId": threadID, "expectedTurnId": turnID, "input": input}
}

func TextInput(text string) UserInput {
	return UserInput{Type: "text", Text: text, TextElements: []any{}}
}

func LocalImageInput(path string) UserInput {
	return UserInput{Type: "localImage", Path: path}
}

func approvalPolicy(value string) string {
	switch value {
	case "", "never", "untrusted", "on-failure", "on-request":
		return defaultString(value, "never")
	case "always":
		return "untrusted"
	case "danger-only":
		return "on-request"
	default:
		return value
	}
}

func turnSandboxPolicy(value string) map[string]any {
	normalized := strings.TrimSpace(value)
	switch normalized {
	case "read-only", "readOnly":
		return map[string]any{"type": "readOnly"}
	case "", "workspace-write", "workspaceWrite":
		return map[string]any{"type": "workspaceWrite"}
	case "danger-full-access", "dangerFullAccess":
		return map[string]any{"type": "dangerFullAccess"}
	default:
		return map[string]any{"type": normalized}
	}
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
