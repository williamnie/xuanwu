package codex

import (
	"encoding/json"
	"testing"
)

func TestNormalizeAgentDelta(t *testing.T) {
	raw := json.RawMessage(`{"threadId":"t1","turnId":"u1","itemId":"i1","delta":"hello"}`)
	event := normalizeEvent("item/agentMessage/delta", raw)
	if event.ThreadID != "t1" || event.TurnID != "u1" || event.Text != "hello" {
		t.Fatalf("unexpected event: %+v", event)
	}
}

func TestNormalizeTurnCompletedFailure(t *testing.T) {
	raw := json.RawMessage(`{"threadId":"t1","turn":{"id":"u1","status":"failed","error":{"message":"boom","additionalDetails":"detail"}}}`)
	event := normalizeEvent("turn/completed", raw)
	if event.Status != "failed" || event.Error != "boom detail" {
		t.Fatalf("unexpected completion: %+v", event)
	}
}

func TestThreadStartParamsMapsFrontendApprovalValues(t *testing.T) {
	params := threadStartParams(ThreadInput{CWD: "/tmp/demo", ApprovalPolicy: "danger-only"})
	if params["approvalPolicy"] != "on-request" {
		t.Fatalf("approval mapping = %v", params["approvalPolicy"])
	}
	params = threadStartParams(ThreadInput{CWD: "/tmp/demo", ApprovalPolicy: "always"})
	if params["approvalPolicy"] != "untrusted" {
		t.Fatalf("approval mapping = %v", params["approvalPolicy"])
	}
}
