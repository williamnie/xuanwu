package codex

import "encoding/json"

func (a *Adapter) handleServerRequest(msg wireMessage) {
	result, ok := serverRequestResult(msg.Method)
	if !ok {
		_ = a.write(map[string]any{"id": rawID(msg.ID), "error": map[string]any{"code": -32601, "message": "unsupported server request: " + msg.Method}})
		return
	}
	_ = a.write(map[string]any{"id": rawID(msg.ID), "result": result})
}

func serverRequestResult(method string) (map[string]any, bool) {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		return map[string]any{"decision": "cancel"}, true
	case "applyPatchApproval", "execCommandApproval":
		return map[string]any{"decision": "abort"}, true
	case "item/tool/requestUserInput":
		return map[string]any{"answers": map[string]any{}}, true
	case "mcpServer/elicitation/request":
		return map[string]any{"action": "cancel", "content": nil, "_meta": nil}, true
	case "item/permissions/requestApproval":
		return map[string]any{"permissions": map[string]any{}, "scope": "turn"}, true
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
