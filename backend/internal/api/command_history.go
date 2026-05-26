package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/runner"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const commandSummaryMaxRunes = 240

func (s *Server) saveCommandEvent(
	r *http.Request,
	req runnerCommandRequest,
	cmd runnerCommandPayload,
	res RunnerCommandResponse,
	execErr error,
) error {
	sessionID := commandSourceSessionID(req, cmd)
	if sessionID == "" {
		return nil
	}
	argsJSON, err := json.Marshal(safeCommandArgs(cmd.Args))
	if err != nil {
		return err
	}
	return s.store.SaveSessionCommandEvent(r.Context(), store.SessionCommandEventRecord{
		Provider:          store.ProviderCodex,
		ProviderSessionID: sessionID,
		CommandName:       cmd.Name,
		CommandArgsJSON:   string(argsJSON),
		PromptSummary:     safeSummary(req.Prompt),
		ReferencesSummary: referencesSummary(commandReferences(req, cmd)),
		ResultSummary:     safeSummary(res.Summary),
		TargetIssueID:     commandIssueID(cmd),
		CreatedIssueID:    commandCreatedIssueID(cmd.Name, res),
		EnqueuedIssueID:   commandEnqueuedIssueID(cmd.Name, res),
		Error:             safeSummary(errorText(execErr)),
	})
}

func commandCreatedIssueID(name string, res RunnerCommandResponse) int64 {
	if name == "issue" && res.Issue != nil {
		return res.Issue.ID
	}
	return 0
}

func commandEnqueuedIssueID(name string, res RunnerCommandResponse) int64 {
	if name == "run" && res.Issue != nil {
		return res.Issue.ID
	}
	return 0
}

func commandSourceSessionID(req runnerCommandRequest, cmd runnerCommandPayload) string {
	return normalizeCommandSessionID(firstNonEmpty(req.SessionID, commandStringArg(cmd, "source_session_id")))
}

func normalizeCommandSessionID(value string) string {
	value = strings.TrimSpace(value)
	provider, sessionID, ok := strings.Cut(value, ":")
	if ok && strings.EqualFold(strings.TrimSpace(provider), store.ProviderCodex) {
		return strings.TrimSpace(sessionID)
	}
	return value
}

func commandIssueSourceExcerpt(cmd runnerCommandPayload, sessionID string) string {
	if sessionID == "" || cmd.Name != "issue" {
		return ""
	}
	return safeSummary("Composer /issue command from session " + sessionID)
}

func safeCommandArgs(args map[string]any) map[string]any {
	clean := map[string]any{}
	for key, value := range args {
		if isSensitiveKey(key) {
			clean[key] = "[redacted]"
			continue
		}
		clean[key] = safeCommandValue(value)
	}
	return clean
}

func safeCommandValue(value any) any {
	switch typed := value.(type) {
	case string:
		return safeSummary(typed)
	case []runner.SessionReference:
		return referenceSummaries(typed)
	case []any:
		return safeCommandValues(typed)
	case map[string]any:
		return safeCommandArgs(typed)
	default:
		return value
	}
}

func safeCommandValues(values []any) []any {
	items := make([]any, 0, len(values))
	for _, item := range values {
		items = append(items, safeCommandValue(item))
	}
	return items
}

func isSensitiveKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	for _, marker := range []string{"token", "secret", "password", "credential", "api_key", "apikey"} {
		if strings.Contains(key, marker) {
			return true
		}
	}
	return false
}

func referencesSummary(refs []runner.SessionReference) string {
	return strings.Join(referenceSummaries(refs), ", ")
}

func referenceSummaries(refs []runner.SessionReference) []string {
	items := make([]string, 0, len(refs))
	for _, ref := range refs {
		if line := referenceCommandLine(ref); line != "" {
			items = append(items, safeSummary(line))
		}
	}
	return items
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func safeSummary(value string) string {
	value = redactSecrets(strings.Join(strings.Fields(strings.TrimSpace(value)), " "))
	return truncateRunes(value, commandSummaryMaxRunes)
}

func redactSecrets(value string) string {
	fields := strings.Fields(value)
	for index, field := range fields {
		if hasSecretAssignment(field) {
			fields[index] = redactAssignment(field)
		}
	}
	return strings.Join(fields, " ")
}

func hasSecretAssignment(value string) bool {
	lower := strings.ToLower(value)
	return strings.Contains(lower, "token=") || strings.Contains(lower, "secret=") ||
		strings.Contains(lower, "password=") || strings.Contains(lower, "api_key=") ||
		strings.Contains(lower, "apikey=")
}

func redactAssignment(value string) string {
	key, _, ok := strings.Cut(value, "=")
	if !ok {
		return "[redacted]"
	}
	return key + "=[redacted]"
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit-1]) + "…"
}
