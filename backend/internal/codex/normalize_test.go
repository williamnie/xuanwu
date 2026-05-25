package codex

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

func TestNormalizeAgentDelta(t *testing.T) {
	raw := json.RawMessage(`{"threadId":"t1","turnId":"u1","itemId":"i1","delta":"hello"}`)
	event := normalizeEvent("item/agentMessage/delta", raw)
	if event.ThreadID != "t1" || event.TurnID != "u1" || event.Text != "hello" {
		t.Fatalf("unexpected event: %+v", event)
	}
	if event.AgentEventType != events.AgentMessageDelta || event.Provider != events.ProviderCodex ||
		event.RawMethod != "item/agentMessage/delta" || event.RawPayload != string(raw) {
		t.Fatalf("normalized metadata missing: %+v", event)
	}
}

func TestNormalizeTurnCompletedFailure(t *testing.T) {
	raw := json.RawMessage(`{"threadId":"t1","turn":{"id":"u1","status":"failed","error":{"message":"boom","additionalDetails":"detail"}}}`)
	event := normalizeEvent("turn/completed", raw)
	if event.Status != "failed" || event.Error != "boom detail" {
		t.Fatalf("unexpected completion: %+v", event)
	}
}

func TestNormalizeItemStartedCommandExecution(t *testing.T) {
	raw := json.RawMessage(`{"threadId":"t1","turnId":"u1","item":{"type":"commandExecution","status":"inProgress","command":"/bin/zsh -lc \"go test ./backend/...\""}}`)
	event := normalizeEvent("item/started", raw)
	if event.ThreadID != "t1" || event.TurnID != "u1" {
		t.Fatalf("runtime ids not preserved: %+v", event)
	}
	if event.AgentEventType != events.AgentCommandStarted ||
		event.Command != `/bin/zsh -lc "go test ./backend/..."` || event.Status != "inProgress" {
		t.Fatalf("command event not normalized: %+v", event)
	}
	if event.Text != `$ /bin/zsh -lc "go test ./backend/..."` {
		t.Fatalf("command text = %q", event.Text)
	}
}

func TestNormalizeItemCompletedFileChange(t *testing.T) {
	raw := json.RawMessage(`{"threadId":"t1","turnId":"u1","item":{"type":"fileChange","status":"completed","changes":[{"path":"/tmp/demo.go","diff":"@@ -1 +1 @@\n-old\n+new\n"}]}}`)
	event := normalizeEvent("item/completed", raw)
	if event.AgentEventType != events.AgentFilePatch || event.Path != "/tmp/demo.go" || event.Status != "completed" {
		t.Fatalf("file change event not normalized: %+v", event)
	}
	if event.Text == "" || event.Text[:16] != "--- /tmp/demo.go" {
		t.Fatalf("file change text not normalized: %+v", event)
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

func TestThreadStartParamsDropsUnsupportedLegacyThreadSource(t *testing.T) {
	params := threadStartParams(ThreadInput{CWD: "/tmp/demo", ThreadSource: "codex-issue-runner"})
	if source, ok := params["threadSource"]; ok {
		t.Fatalf("threadSource = %v, want omitted for unsupported legacy value", source)
	}
}

func TestThreadStartParamsKeepsSupportedThreadSource(t *testing.T) {
	params := threadStartParams(ThreadInput{CWD: "/tmp/demo", ThreadSource: ThreadSourceSubagent})
	if params["threadSource"] != ThreadSourceSubagent {
		t.Fatalf("threadSource = %v, want %s", params["threadSource"], ThreadSourceSubagent)
	}
}

func TestThreadStartParamsIncludesReasoningEffortConfig(t *testing.T) {
	params := threadStartParams(ThreadInput{CWD: "/tmp/demo", ReasoningEffort: "xhigh"})
	config, ok := params["config"].(map[string]any)
	if !ok || config["model_reasoning_effort"] != "xhigh" {
		t.Fatalf("reasoning config = %#v", params["config"])
	}
}

func TestTurnStartParamsIncludesSessionOverrides(t *testing.T) {
	params := turnStartParams("thread-1", []UserInput{TextInput("hi")}, TurnOptions{
		Model: "gpt-5.5", ReasoningEffort: "xhigh", ApprovalPolicy: "danger-only", Sandbox: "read-only",
	})
	if params["model"] != "gpt-5.5" || params["effort"] != "xhigh" {
		t.Fatalf("model/effort params = %#v", params)
	}
	sandboxPolicy, ok := params["sandboxPolicy"].(map[string]any)
	if params["approvalPolicy"] != "on-request" || !ok || sandboxPolicy["type"] != "readOnly" {
		t.Fatalf("permission params = %#v", params)
	}
}

func TestApprovalResponseMapsCommandDecisions(t *testing.T) {
	result := approvalResponse("item/commandExecution/requestApproval", ApprovalDecision{Decision: "approve_session"}, nil)
	if result["decision"] != "acceptForSession" {
		t.Fatalf("item approval response = %#v", result)
	}
	result = approvalResponse("execCommandApproval", ApprovalDecision{Decision: "deny"}, nil)
	if result["decision"] != "denied" {
		t.Fatalf("legacy approval response = %#v", result)
	}
}

func TestApprovalResponseGrantsRequestedPermissions(t *testing.T) {
	raw := json.RawMessage(`{"permissions":{"network":{"enabled":true}}}`)
	result := approvalResponse("item/permissions/requestApproval", ApprovalDecision{Decision: "approve_session"}, raw)
	if result["scope"] != "session" {
		t.Fatalf("permission scope = %#v", result)
	}
	permissions, ok := result["permissions"].(map[string]any)
	if !ok || permissions["network"] == nil {
		t.Fatalf("permissions = %#v", result["permissions"])
	}
}

func TestResolveApprovalDeliversPendingDecision(t *testing.T) {
	adapter := NewAdapter("", nil)
	requestID, ch := adapter.registerApproval("item/commandExecution/requestApproval",
		json.RawMessage(`{"threadId":"t1","turnId":"u1","command":"go test ./..."}`))
	event := <-adapter.Events()
	if event.Method != "approval/requested" || event.ThreadID != "t1" || event.TurnID != "u1" {
		t.Fatalf("approval event = %+v", event)
	}
	if err := adapter.ResolveApproval(context.Background(), requestID, ApprovalDecision{Decision: "approve"}); err != nil {
		t.Fatalf("resolve approval: %v", err)
	}
	got := <-ch
	if got.Decision != "approve" {
		t.Fatalf("decision = %+v", got)
	}
	adapter.unregisterApproval(requestID)
}

func TestPendingApprovalsListsRuntimeRequestsAndDropsResolved(t *testing.T) {
	adapter := NewAdapter("", nil)
	firstID, _ := adapter.registerApproval("item/commandExecution/requestApproval",
		json.RawMessage(`{"threadId":"t1","turnId":"u1","command":"go test ./..."}`))
	secondID, _ := adapter.registerApproval("item/fileChange/requestApproval",
		json.RawMessage(`{"threadId":"t2","turnId":"u2","changes":[{"path":"demo.go"}]}`))

	pending, err := adapter.PendingApprovals(context.Background())
	if err != nil {
		t.Fatalf("pending approvals: %v", err)
	}
	if len(pending) != 2 || pending[0].ID != firstID || pending[1].ID != secondID ||
		pending[0].ThreadID != "t1" || pending[1].TurnID != "u2" {
		t.Fatalf("pending approvals snapshot = %+v", pending)
	}

	if err := adapter.ResolveApproval(context.Background(), firstID, ApprovalDecision{Decision: "deny"}); err != nil {
		t.Fatalf("resolve first approval: %v", err)
	}
	pending, err = adapter.PendingApprovals(context.Background())
	if err != nil {
		t.Fatalf("pending approvals after resolve: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != secondID {
		t.Fatalf("pending approvals after resolve = %+v", pending)
	}
}
