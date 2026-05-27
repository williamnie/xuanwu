package runner

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const verifierReportTimeout = 2 * time.Minute

type IssueVerifierInput struct {
	Issue      store.Issue
	Project    store.Project
	Refinement IssueRefinementDraft
	Runs       []store.IssueRun
	Events     []store.IssueEvent
	GitSummary string
}

type IssueVerifierResult struct {
	Report   IssueVerificationReport `json:"report"`
	ThreadID string                  `json:"thread_id"`
	TurnID   string                  `json:"turn_id"`
}

type IssueVerificationReport struct {
	Summary             string `json:"summary"`
	AcceptanceChecklist string `json:"acceptanceChecklist"`
	EvidenceFound       string `json:"evidenceFound"`
	EvidenceMissing     string `json:"evidenceMissing"`
	Risk                string `json:"risk"`
	Recommendation      string `json:"recommendation"`
}

func (r *Runner) GenerateIssueVerifierReport(
	ctx context.Context,
	input IssueVerifierInput,
) (IssueVerifierResult, error) {
	if err := r.requireCapability(agent.CapabilitySessions); err != nil {
		return IssueVerifierResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, verifierReportTimeout)
	defer cancel()
	if err := r.prepareCodex(ctx); err != nil {
		return IssueVerifierResult{}, err
	}
	prompt := BuildIssueVerifierPrompt(input)
	threadID, turnID, text, err := r.runVerifierTurn(ctx, input.Project, prompt)
	if err != nil {
		return IssueVerifierResult{}, err
	}
	report, err := parseIssueVerifierOutput(text)
	if err != nil {
		return IssueVerifierResult{}, err
	}
	return IssueVerifierResult{Report: report, ThreadID: threadID, TurnID: turnID}, nil
}

func (r *Runner) runVerifierTurn(
	ctx context.Context,
	project store.Project,
	prompt string,
) (string, string, string, error) {
	threadID, err := r.startThread(ctx, verifierThreadInput(project))
	if err != nil {
		return "", "", "", err
	}
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	defer unsubscribe()
	turnID, err := r.startTurn(ctx, threadID, []agent.UserInput{agent.TextInput(prompt)}, verifierTurnOptions(project))
	if err != nil {
		return "", "", "", err
	}
	text, err := r.consumeVerifierEvents(ctx, threadID, turnID, eventsCh)
	return threadID, turnID, text, err
}

func verifierThreadInput(project store.Project) agent.ThreadInput {
	return agent.ThreadInput{
		CWD: project.CWD, Model: project.Model, ApprovalPolicy: "always", Sandbox: "read-only",
		DeveloperInstructions: "Verifier Agent v0 only. Read-only review: do not modify code, execute shell commands, request approvals, or update issue status/final status.",
		ThreadSource:          agent.ThreadSourceSubagent,
	}
}

func verifierTurnOptions(project store.Project) agent.TurnOptions {
	return agent.TurnOptions{Model: project.Model, ApprovalPolicy: "always", Sandbox: "read-only"}
}

func (r *Runner) consumeVerifierEvents(
	ctx context.Context,
	threadID string,
	turnID string,
	eventsCh <-chan agent.Event,
) (string, error) {
	var out strings.Builder
	for {
		select {
		case <-ctx.Done():
			_ = r.interruptTurn(context.Background(), threadID, turnID)
			return "", fmt.Errorf("生成 verifier report 超时或已取消: %w", ctx.Err())
		case event, ok := <-eventsCh:
			if !ok {
				return "", errors.New("provider event stream closed")
			}
			if !matches(event, threadID, turnID) {
				continue
			}
			if err := rejectProhibitedVerifierEvent(r, threadID, turnID, event); err != nil {
				return "", err
			}
			appendVerifierText(&out, event)
			if isAgentError(event) {
				return "", eventError(event.Error)
			}
			if isAgentTurnCompleted(event) {
				return finishVerifierTurn(event, out.String())
			}
		}
	}
}

func rejectProhibitedVerifierEvent(r *Runner, threadID, turnID string, event agent.Event) error {
	if !isProhibitedVerifierEvent(event) {
		return nil
	}
	_ = r.interruptTurn(context.Background(), threadID, turnID)
	return errors.New("Verifier Agent attempted a prohibited command/file/approval/status action")
}

func isProhibitedVerifierEvent(event agent.Event) bool {
	if event.Command != "" || event.Path != "" {
		return true
	}
	switch event.NormalizedType() {
	case events.AgentCommandStarted, events.AgentCommandOutputDelta,
		events.AgentCommandCompleted, events.AgentFilePatch, events.AgentApprovalRequested:
		return true
	}
	method := event.ProviderMethod()
	return strings.Contains(method, "commandExecution") ||
		strings.Contains(method, "fileChange") || strings.Contains(method, "approval")
}

func appendVerifierText(out *strings.Builder, event agent.Event) {
	if event.Text == "" {
		return
	}
	if event.NormalizedType() == events.AgentMessageDelta ||
		event.ProviderMethod() == "item/agentMessage/delta" {
		out.WriteString(event.Text)
	}
}

func finishVerifierTurn(event agent.Event, text string) (string, error) {
	if event.Status != "" && event.Status != "completed" {
		return "", eventError(event.Error)
	}
	if strings.TrimSpace(text) == "" {
		return "", errors.New("Verifier Agent 未返回 report")
	}
	return text, nil
}
