package codex

import (
	"encoding/json"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

func normalizeEvent(method string, raw json.RawMessage) Event {
	var p map[string]any
	_ = json.Unmarshal(raw, &p)
	e := Event{
		Method: method, AgentEventType: agentEventType(method, p),
		Provider: events.ProviderCodex, RawMethod: method, RawPayload: string(raw), Payload: string(raw),
	}
	e.ThreadID = stringField(p, "threadId")
	e.TurnID = stringField(p, "turnId")
	switch method {
	case "item/agentMessage/delta":
		e.Text = stringField(p, "delta")
	case "item/commandExecution/outputDelta":
		e.Text = stringField(p, "delta")
		e.Command = commandFromPayload(p)
	case "item/fileChange/outputDelta":
		e.Text = stringField(p, "delta")
		e.Path = pathFromPayload(p)
	case "item/fileChange/patchUpdated":
		e.Text = patchText(p)
		e.Path = pathFromPayload(p)
	case "item/started", "item/completed":
		e.Text, e.Command, e.Path, e.Status = itemLifecycleFields(method, p)
	case "turn/completed":
		e.Status, e.Error = turnStatus(p)
	case "turn/started":
		e.Status = "inProgress"
	case "error":
		e.Status, e.Error = "failed", errorMessage(p)
	}
	return e
}

func agentEventType(method string, p map[string]any) string {
	switch method {
	case "item/agentMessage/delta":
		return events.AgentMessageDelta
	case "item/commandExecution/outputDelta":
		return events.AgentCommandOutputDelta
	case "item/fileChange/outputDelta", "item/fileChange/patchUpdated":
		return events.AgentFilePatch
	case "item/started":
		return startedEventType(p)
	case "item/completed":
		return completedEventType(p)
	case "approval/requested":
		return events.AgentApprovalRequested
	case "turn/started":
		return events.AgentTurnStarted
	case "turn/completed":
		return events.AgentTurnCompleted
	case "error", "protocol/error", "process/stderr":
		return events.AgentError
	default:
		return ""
	}
}

func startedEventType(m map[string]any) string {
	item, ok := m["item"].(map[string]any)
	if !ok {
		return ""
	}
	if stringField(item, "type") == "commandExecution" {
		return events.AgentCommandStarted
	}
	return ""
}

func completedEventType(m map[string]any) string {
	item, ok := m["item"].(map[string]any)
	if !ok {
		return ""
	}
	switch stringField(item, "type") {
	case "commandExecution":
		return events.AgentCommandCompleted
	case "fileChange":
		return events.AgentFilePatch
	default:
		return ""
	}
}

func stringField(m map[string]any, key string) string {
	if value, ok := m[key].(string); ok {
		return value
	}
	return ""
}

func itemLifecycleFields(method string, m map[string]any) (string, string, string, string) {
	item, ok := m["item"].(map[string]any)
	if !ok {
		return "", "", "", ""
	}
	switch stringField(item, "type") {
	case "commandExecution":
		return commandLifecycleText(method, item), stringField(item, "command"), "", stringField(item, "status")
	case "fileChange":
		return fileChangeLifecycleText(method, item), "", pathFromPayload(item), stringField(item, "status")
	default:
		return "", "", "", ""
	}
}

func commandLifecycleText(method string, item map[string]any) string {
	command := stringField(item, "command")
	if command == "" {
		return ""
	}
	if method == "item/started" {
		return "$ " + command
	}
	if status := stringField(item, "status"); status != "" && status != "completed" {
		return "! command " + status + ": " + command
	}
	return ""
}

func fileChangeLifecycleText(method string, item map[string]any) string {
	if method != "item/completed" {
		return ""
	}
	return patchText(item)
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

func commandFromPayload(m map[string]any) string {
	if command := stringField(m, "command"); command != "" {
		return command
	}
	if item, ok := m["item"].(map[string]any); ok {
		return stringField(item, "command")
	}
	return ""
}

func pathFromPayload(m map[string]any) string {
	if path := stringField(m, "path"); path != "" {
		return path
	}
	if item, ok := m["item"].(map[string]any); ok {
		return pathFromPayload(item)
	}
	changes, ok := m["changes"].([]any)
	if !ok || len(changes) == 0 {
		return ""
	}
	change, ok := changes[0].(map[string]any)
	if !ok {
		return ""
	}
	return stringField(change, "path")
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
