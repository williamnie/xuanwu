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
