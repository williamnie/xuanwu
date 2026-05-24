package codex

import (
	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	codexclient "github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

func toCodexThreadInput(input agent.ThreadInput) codexclient.ThreadInput {
	return codexclient.ThreadInput{
		CWD: input.CWD, Model: input.Model, ReasoningEffort: input.ReasoningEffort,
		ApprovalPolicy: input.ApprovalPolicy, Sandbox: input.Sandbox,
		DeveloperInstructions: input.DeveloperInstructions, ThreadSource: input.ThreadSource,
	}
}

func toCodexTurnOptions(options agent.TurnOptions) codexclient.TurnOptions {
	return codexclient.TurnOptions{
		Model: options.Model, ReasoningEffort: options.ReasoningEffort,
		ApprovalPolicy: options.ApprovalPolicy, Sandbox: options.Sandbox,
	}
}

func toCodexUserInputs(inputs []agent.UserInput) []codexclient.UserInput {
	out := make([]codexclient.UserInput, len(inputs))
	for i := range inputs {
		out[i] = codexclient.UserInput(inputs[i])
	}
	return out
}

func toCodexModelListInput(input agent.ModelListInput) codexclient.ModelListInput {
	return codexclient.ModelListInput{IncludeHidden: input.IncludeHidden}
}

func toCodexSessionListInput(input agent.SessionListInput) codexclient.SessionListInput {
	return codexclient.SessionListInput{Cursor: input.Cursor, Limit: input.Limit}
}

func toCodexApprovalDecision(decision agent.ApprovalDecision) codexclient.ApprovalDecision {
	return codexclient.ApprovalDecision{Decision: decision.Decision, Scope: decision.Scope}
}

func fromCodexModelListResult(result codexclient.ModelListResult) agent.ModelListResult {
	models := make([]agent.Model, len(result.Data))
	for i := range result.Data {
		models[i] = fromCodexModel(result.Data[i])
	}
	return agent.ModelListResult{Data: models, NextCursor: result.NextCursor}
}

func fromCodexModel(model codexclient.Model) agent.Model {
	return agent.Model{
		ID: model.ID, Model: model.Model, DisplayName: model.DisplayName,
		Description: model.Description, IsDefault: model.IsDefault, Hidden: model.Hidden,
		DefaultReasoningEffort:    model.DefaultReasoningEffort,
		SupportedReasoningEfforts: fromCodexReasoningEfforts(model.SupportedReasoningEfforts),
		InputModalities:           model.InputModalities,
	}
}

func fromCodexReasoningEfforts(
	options []codexclient.ReasoningEffortOption,
) []agent.ReasoningEffortOption {
	out := make([]agent.ReasoningEffortOption, len(options))
	for i := range options {
		out[i] = agent.ReasoningEffortOption(options[i])
	}
	return out
}

func fromCodexSessionListResult(result codexclient.SessionListResult) agent.SessionListResult {
	sessions := make([]agent.Session, len(result.Data))
	for i := range result.Data {
		sessions[i] = fromCodexSession(result.Data[i])
	}
	return agent.SessionListResult{
		Data: sessions, NextCursor: result.NextCursor,
		BackwardsCursor: result.BackwardsCursor,
	}
}

func fromCodexSession(session codexclient.Session) agent.Session {
	return agent.Session{
		ID: session.ID, SessionID: session.SessionID, Provider: session.Provider,
		ProviderSessionID: session.ProviderSessionID, ForkedFromID: session.ForkedFromID,
		Preview: session.Preview, Ephemeral: session.Ephemeral,
		ModelProvider: session.ModelProvider, CreatedAt: session.CreatedAt,
		UpdatedAt: session.UpdatedAt, Status: session.Status, Path: session.Path,
		CWD: session.CWD, CLIVersion: session.CLIVersion, Source: session.Source,
		ThreadSource: session.ThreadSource, AgentNickname: session.AgentNickname,
		AgentRole: session.AgentRole, GitInfo: session.GitInfo, Name: session.Name,
		Turns: session.Turns, IsRunning: session.IsRunning, Origin: session.Origin,
	}
}

func fromCodexEvent(event codexclient.Event) agent.Event {
	rawMethod := firstNonEmpty(event.RawMethod, event.Method)
	rawPayload := firstNonEmpty(event.RawPayload, event.Payload)
	return agent.Event{
		Type:           event.AgentEventType,
		Provider:       firstNonEmpty(event.Provider, events.ProviderCodex),
		ThreadID:       event.ThreadID,
		TurnID:         event.TurnID,
		Text:           event.Text,
		Command:        event.Command,
		Path:           event.Path,
		Status:         event.Status,
		Error:          event.Error,
		Payload:        event.Payload,
		Raw:            agent.RawEvent{Method: rawMethod, Payload: rawPayload},
		Method:         event.Method,
		AgentEventType: event.AgentEventType,
		RawMethod:      rawMethod,
		RawPayload:     rawPayload,
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
