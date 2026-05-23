package codex

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

func (a *Adapter) handleServerRequest(msg wireMessage) {
	if isApprovalRequest(msg.Method) {
		a.handleApprovalRequest(msg)
		return
	}
	result, ok := staticServerRequestResult(msg.Method)
	if !ok {
		_ = a.write(map[string]any{"id": rawID(msg.ID), "error": map[string]any{"code": -32601, "message": "unsupported server request: " + msg.Method}})
		return
	}
	_ = a.write(map[string]any{"id": rawID(msg.ID), "result": result})
}

func (a *Adapter) handleApprovalRequest(msg wireMessage) {
	requestID, ch := a.registerApproval(msg.Method, msg.Params)
	defer a.unregisterApproval(requestID)
	decision := <-ch
	result := approvalResponse(msg.Method, decision, msg.Params)
	_ = a.write(map[string]any{"id": rawID(msg.ID), "result": result})
	a.emit(Event{Method: "approval/resolved", Payload: approvalResolvedPayload(requestID, decision)})
}

func (a *Adapter) ResolveApproval(ctx context.Context, requestID string, decision ApprovalDecision) error {
	a.mu.Lock()
	ch := a.pendingApprovals[requestID]
	a.mu.Unlock()
	if ch == nil {
		return fmt.Errorf("approval request %q not found", requestID)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case ch <- decision:
		return nil
	}
}

func (a *Adapter) registerApproval(method string, params json.RawMessage) (string, chan ApprovalDecision) {
	a.mu.Lock()
	a.nextApprovalID++
	requestID := fmt.Sprintf("approval-%d", a.nextApprovalID)
	ch := make(chan ApprovalDecision, 1)
	a.pendingApprovals[requestID] = ch
	a.mu.Unlock()
	a.emit(approvalRequestedEvent(requestID, method, params))
	return requestID, ch
}

func (a *Adapter) unregisterApproval(requestID string) {
	a.mu.Lock()
	delete(a.pendingApprovals, requestID)
	a.mu.Unlock()
}

func staticServerRequestResult(method string) (map[string]any, bool) {
	switch method {
	case "item/tool/requestUserInput":
		return map[string]any{"answers": map[string]any{}}, true
	case "mcpServer/elicitation/request":
		return map[string]any{"action": "cancel", "content": nil, "_meta": nil}, true
	case "item/tool/call":
		return map[string]any{"contentItems": []any{}, "success": false}, true
	default:
		return nil, false
	}
}

func rawID(raw json.RawMessage) any {
	var id any
	if err := json.Unmarshal(raw, &id); err != nil {
		return string(raw)
	}
	return id
}

func isApprovalRequest(method string) bool {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
		"item/permissions/requestApproval", "applyPatchApproval", "execCommandApproval":
		return true
	default:
		return false
	}
}

func approvalRequestedEvent(requestID, method string, params json.RawMessage) Event {
	var decoded map[string]any
	_ = json.Unmarshal(params, &decoded)
	payload, _ := json.Marshal(map[string]any{
		"id":     requestID,
		"method": method,
		"params": decoded,
	})
	return Event{
		Method: "approval/requested", AgentEventType: events.AgentApprovalRequested,
		Provider: events.ProviderCodex, RawMethod: method, RawPayload: string(params),
		ThreadID: stringField(decoded, "threadId"), TurnID: stringField(decoded, "turnId"),
		Payload: string(payload),
	}
}

func approvalResolvedPayload(requestID string, decision ApprovalDecision) string {
	payload, _ := json.Marshal(map[string]any{
		"id": requestID, "decision": decision.Decision, "scope": decision.Scope,
	})
	return string(payload)
}

func approvalResponse(method string, decision ApprovalDecision, params json.RawMessage) map[string]any {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		return map[string]any{"decision": itemApprovalDecision(decision.Decision)}
	case "applyPatchApproval", "execCommandApproval":
		return map[string]any{"decision": legacyApprovalDecision(decision.Decision)}
	case "item/permissions/requestApproval":
		return permissionsApprovalResponse(decision, params)
	default:
		return map[string]any{}
	}
}

func itemApprovalDecision(value string) string {
	switch value {
	case "approve_session":
		return "acceptForSession"
	case "deny":
		return "decline"
	case "abort":
		return "cancel"
	default:
		return "accept"
	}
}

func legacyApprovalDecision(value string) string {
	switch value {
	case "approve_session":
		return "approved_for_session"
	case "deny":
		return "denied"
	case "abort":
		return "abort"
	default:
		return "approved"
	}
}

func permissionsApprovalResponse(decision ApprovalDecision, params json.RawMessage) map[string]any {
	if decision.Decision == "approve" || decision.Decision == "approve_session" {
		return map[string]any{"permissions": requestedPermissions(params), "scope": approvalScope(decision)}
	}
	return map[string]any{"permissions": map[string]any{}, "scope": "turn"}
}

func requestedPermissions(params json.RawMessage) any {
	var decoded map[string]any
	if err := json.Unmarshal(params, &decoded); err != nil {
		return map[string]any{}
	}
	if permissions, ok := decoded["permissions"]; ok && permissions != nil {
		return permissions
	}
	return map[string]any{}
}

func approvalScope(decision ApprovalDecision) string {
	if decision.Decision == "approve_session" || decision.Scope == "session" {
		return "session"
	}
	return "turn"
}
