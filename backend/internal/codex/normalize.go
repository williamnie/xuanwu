package codex

import (
	"encoding/json"
	"strings"
)

func normalizeEvent(method string, raw json.RawMessage) Event {
	var p map[string]any
	_ = json.Unmarshal(raw, &p)
	e := Event{Method: method, Payload: string(raw)}
	e.ThreadID = stringField(p, "threadId")
	e.TurnID = stringField(p, "turnId")
	switch method {
	case "item/agentMessage/delta", "item/commandExecution/outputDelta":
		e.Text = stringField(p, "delta")
	case "item/fileChange/outputDelta":
		e.Text = stringField(p, "delta")
	case "item/fileChange/patchUpdated":
		e.Text = patchText(p)
	case "turn/completed":
		e.Status, e.Error = turnStatus(p)
	case "turn/started":
		e.Status = "inProgress"
	case "error":
		e.Status, e.Error = "failed", errorMessage(p)
	}
	return e
}

func stringField(m map[string]any, key string) string {
	if value, ok := m[key].(string); ok {
		return value
	}
	return ""
}

func patchText(m map[string]any) string {
	changes, ok := m["changes"].([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, item := range changes {
		change, ok := item.(map[string]any)
		if !ok {
			continue
		}
		b.WriteString("--- ")
		b.WriteString(stringField(change, "path"))
		b.WriteByte('\n')
		b.WriteString(stringField(change, "diff"))
		b.WriteByte('\n')
	}
	return b.String()
}

func turnStatus(m map[string]any) (string, string) {
	turn, ok := m["turn"].(map[string]any)
	if !ok {
		return "failed", "missing turn payload"
	}
	status := stringField(turn, "status")
	if status == "completed" {
		return status, ""
	}
	return status, errorMessage(turn)
}

func errorMessage(m map[string]any) string {
	errObj, ok := m["error"].(map[string]any)
	if !ok {
		return ""
	}
	msg := stringField(errObj, "message")
	if detail := stringField(errObj, "additionalDetails"); detail != "" {
		return strings.TrimSpace(msg + " " + detail)
	}
	return msg
}
