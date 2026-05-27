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

const refinementDraftTimeout = 2 * time.Minute

type IssueRefinementDraftInput struct {
	Issue         store.Issue
	Project       store.Project
	AgentProfiles []store.AgentProfile
	Events        []store.IssueEvent
}

type IssueRefinementDraftResult struct {
	Draft    IssueRefinementDraft `json:"draft"`
	ThreadID string               `json:"thread_id"`
	TurnID   string               `json:"turn_id"`
}

type IssueRefinementDraft struct {
	Problem                 string `json:"problem"`
	Context                 string `json:"context"`
	AcceptanceCriteria      string `json:"acceptanceCriteria"`
	VerificationPlan        string `json:"verificationPlan"`
	NonGoals                string `json:"nonGoals"`
	Risks                   string `json:"risks"`
	RecommendedProfile      string `json:"recommendedProfile"`
	RecommendedProvider     string `json:"recommendedProvider"`
	RiskLevel               string `json:"riskLevel"`
	RecommendationReasoning string `json:"recommendationReasoning"`
	NeedsHumanConfirmation  string `json:"needsHumanConfirmation"`
}

func (r *Runner) GenerateIssueRefinementDraft(
	ctx context.Context,
	input IssueRefinementDraftInput,
) (IssueRefinementDraftResult, error) {
	if err := r.requireCapability(agent.CapabilitySessions); err != nil {
		return IssueRefinementDraftResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, refinementDraftTimeout)
	defer cancel()
	if err := r.prepareCodex(ctx); err != nil {
		return IssueRefinementDraftResult{}, err
	}
	prompt := BuildIssueRefinementDraftPrompt(input.Issue, input.Project, input.AgentProfiles, input.Events)
	threadID, turnID, text, err := r.runRefinementDraftTurn(ctx, input.Project, prompt)
	if err != nil {
		return IssueRefinementDraftResult{}, err
	}
	draft, err := parseIssueRefinementDraftOutput(text)
	if err != nil {
		return IssueRefinementDraftResult{}, err
	}
	return IssueRefinementDraftResult{Draft: draft, ThreadID: threadID, TurnID: turnID}, nil
}

func (r *Runner) runRefinementDraftTurn(
	ctx context.Context,
	project store.Project,
	prompt string,
) (string, string, string, error) {
	threadID, err := r.startThread(ctx, refinementDraftThreadInput(project))
	if err != nil {
		return "", "", "", err
	}
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	defer unsubscribe()
	turnID, err := r.startTurn(ctx, threadID, []agent.UserInput{agent.TextInput(prompt)}, refinementDraftTurnOptions(project))
	if err != nil {
		return "", "", "", err
	}
	text, err := r.consumeRefinementDraftEvents(ctx, threadID, turnID, eventsCh)
	return threadID, turnID, text, err
}

func refinementDraftThreadInput(project store.Project) agent.ThreadInput {
	return agent.ThreadInput{
		CWD: project.CWD, Model: project.Model, ApprovalPolicy: "always", Sandbox: "read-only",
		DeveloperInstructions: "PI Agent refinement draft only. Do not modify code, execute shell commands, or update issue status.",
		ThreadSource:          agent.ThreadSourceSubagent,
	}
}

func refinementDraftTurnOptions(project store.Project) agent.TurnOptions {
	return agent.TurnOptions{Model: project.Model, ApprovalPolicy: "always", Sandbox: "read-only"}
}

func (r *Runner) consumeRefinementDraftEvents(
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
			return "", fmt.Errorf("生成 refinement 草稿超时或已取消: %w", ctx.Err())
		case event, ok := <-eventsCh:
			if !ok {
				return "", errors.New("provider event stream closed")
			}
			if !matches(event, threadID, turnID) {
				continue
			}
			if err := rejectProhibitedRefinementEvent(r, threadID, turnID, event); err != nil {
				return "", err
			}
			appendRefinementDraftText(&out, event)
			if isAgentError(event) {
				return "", eventError(event.Error)
			}
			if isAgentTurnCompleted(event) {
				return finishRefinementDraftTurn(event, out.String())
			}
		}
	}
}

func rejectProhibitedRefinementEvent(r *Runner, threadID, turnID string, event agent.Event) error {
	if !isProhibitedRefinementEvent(event) {
		return nil
	}
	_ = r.interruptTurn(context.Background(), threadID, turnID)
	return errors.New("PI Agent attempted a prohibited command/file/approval action")
}

func isProhibitedRefinementEvent(event agent.Event) bool {
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
		strings.Contains(method, "fileChange") ||
		strings.Contains(method, "approval")
}

func appendRefinementDraftText(out *strings.Builder, event agent.Event) {
	if event.Text == "" {
		return
	}
	if event.NormalizedType() == events.AgentMessageDelta ||
		event.ProviderMethod() == "item/agentMessage/delta" {
		out.WriteString(event.Text)
	}
}

func finishRefinementDraftTurn(event agent.Event, text string) (string, error) {
	if event.Status != "" && event.Status != "completed" {
		return "", eventError(event.Error)
	}
	if strings.TrimSpace(text) == "" {
		return "", errors.New("PI Agent 未返回 refinement 草稿")
	}
	return text, nil
}
