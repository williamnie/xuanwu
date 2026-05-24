package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

func writeIssue(out io.Writer, issue issueDTO, asJSON bool) error {
	if asJSON {
		return writeJSON(out, issue)
	}
	_, err := fmt.Fprintf(out, "#%d [%s] %s - %s\n", issue.ID, issue.Status, issue.ProjectID, issue.Title)
	return err
}

func writeProject(out io.Writer, project projectDTO, asJSON bool) error {
	if asJSON {
		return writeJSON(out, project)
	}
	_, err := fmt.Fprintf(out, "%s [%s] %s\n", project.ID, project.LoopStatus, project.CWD)
	return err
}

func writeSystemStatus(out io.Writer, status systemStatusDTO, asJSON bool) error {
	if asJSON {
		return writeJSON(out, status)
	}
	_, err := fmt.Fprintf(out, "API alive=%t db=%t codex_cmd=%t auth=%t loops=%d in_progress=%d\n",
		status.Service.Alive, status.DB.OK, status.Codex.CommandOK,
		status.Config.AuthEnabled, status.Runner.RunningLoops,
		status.Runner.InProgressIssues)
	if err != nil {
		return err
	}
	for _, provider := range status.Providers {
		if _, err := fmt.Fprintf(out, "provider %s status=%s cli=%t secrets=%s\n",
			provider.ID, provider.Status, provider.CLI.Available,
			secretSummary(provider.Secrets)); err != nil {
			return err
		}
	}
	return err
}

func writeEvents(out io.Writer, events []issueEventDTO, asJSON bool) error {
	if asJSON {
		return writeJSON(out, events)
	}
	for _, event := range events {
		if _, err := fmt.Fprintf(out, "%s %s %s\n", event.CreatedAt, event.Type, eventText(event)); err != nil {
			return err
		}
	}
	return nil
}

func writeJSON(out io.Writer, value any) error {
	enc := json.NewEncoder(out)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

func secretSummary(secrets map[string]secretStatusDTO) string {
	if len(secrets) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(secrets))
	for name, status := range secrets {
		value := "missing"
		if status.Configured {
			value = "configured"
		}
		parts = append(parts, name+":"+value)
	}
	return strings.Join(parts, ",")
}

func eventText(event issueEventDTO) string {
	payload := strings.TrimSpace(event.Payload)
	if payload == "" {
		return ""
	}
	var body struct {
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(payload), &body) == nil && body.Text != "" {
		return body.Text
	}
	return payload
}
