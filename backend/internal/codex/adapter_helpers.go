package codex

import (
	"encoding/json"
	"fmt"
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
		"ephemeral": false, "threadSource": "user",
	}
	if input.ReasoningEffort != "" {
		params["config"] = map[string]any{"model_reasoning_effort": input.ReasoningEffort}
	}
	return params
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
		params["sandboxPolicy"] = defaultString(options.Sandbox, "workspace-write")
	}
	return params
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

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
