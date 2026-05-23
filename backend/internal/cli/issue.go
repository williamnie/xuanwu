package cli

import (
	"context"
	"fmt"
	"os"
	"strings"
)

func (e commandEnv) createIssue(ctx context.Context, args []string) int {
	fs := newFlagSet("issue create")
	addr, asJSON := e.addCommonFlags(fs)
	projectID := fs.String("project", "", "project id")
	title := fs.String("title", "", "issue title")
	body := fs.String("body", "", "issue body")
	bodyFile := fs.String("body-file", "", "issue body markdown file")
	status := fs.String("status", "triage", "initial issue status")
	priority := fs.Int("priority", 0, "issue priority")
	templateID := fs.String("template", "", "issue template id")
	run := fs.Bool("run", false, "enqueue issue after creation")
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	description, err := readIssueBody(*body, *bodyFile)
	if err != nil {
		return e.fail(err.Error())
	}
	payload, err := createPayload(*projectID, *title, description, *status, *priority, *templateID)
	if err != nil {
		return e.fail(err.Error())
	}
	var issue issueDTO
	if err := postJSON(ctx, e.client, *addr, "/api/issues", payload, &issue); err != nil {
		return e.fail(err.Error())
	}
	if *run {
		path := fmt.Sprintf("/api/issues/%d/enqueue", issue.ID)
		if err := postJSON(ctx, e.client, *addr, path, map[string]any{}, &issue); err != nil {
			return e.fail(err.Error())
		}
	}
	if err := writeIssue(e.out, issue, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}

func (e commandEnv) getIssue(ctx context.Context, args []string) int {
	fs := newFlagSet("issue status")
	addr, asJSON := e.addCommonFlags(fs)
	idRaw := fs.String("id", "", "issue id")
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	id, err := parseID(*idRaw)
	if err != nil {
		return e.fail(err.Error())
	}
	var issue issueDTO
	if err := getJSON(ctx, e.client, *addr, fmt.Sprintf("/api/issues/%d", id), &issue); err != nil {
		return e.fail(err.Error())
	}
	if err := writeIssue(e.out, issue, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}

func (e commandEnv) updateIssue(ctx context.Context, args []string) int {
	fs := newFlagSet("issue update")
	addr, asJSON := e.addCommonFlags(fs)
	idRaw := fs.String("id", "", "issue id")
	status := fs.String("status", "", "issue status")
	errText := fs.String("error", "", "issue error message")
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	id, err := parseID(*idRaw)
	if err != nil {
		return e.fail(err.Error())
	}
	payload := issueUpdatePayload(*status, *errText)
	if len(payload) == 0 {
		return e.fail("--status or --error is required")
	}
	var issue issueDTO
	if err := patchJSON(ctx, e.client, *addr, fmt.Sprintf("/api/issues/%d", id), payload, &issue); err != nil {
		return e.fail(err.Error())
	}
	if err := writeIssue(e.out, issue, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}

func (e commandEnv) getIssueLogs(ctx context.Context, args []string) int {
	fs := newFlagSet("issue logs")
	addr, asJSON := e.addCommonFlags(fs)
	idRaw := fs.String("id", "", "issue id")
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	id, err := parseID(*idRaw)
	if err != nil {
		return e.fail(err.Error())
	}
	var events []issueEventDTO
	if err := getJSON(ctx, e.client, *addr, fmt.Sprintf("/api/issues/%d/events", id), &events); err != nil {
		return e.fail(err.Error())
	}
	if err := writeEvents(e.out, events, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}

func (e commandEnv) issueAction(ctx context.Context, action string, args []string) int {
	fs := newFlagSet("issue " + action)
	addr, asJSON := e.addCommonFlags(fs)
	idRaw := fs.String("id", "", "issue id")
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	id, err := parseID(*idRaw)
	if err != nil {
		return e.fail(err.Error())
	}
	var issue issueDTO
	path := fmt.Sprintf("/api/issues/%d/%s", id, action)
	if err := postJSON(ctx, e.client, *addr, path, map[string]any{}, &issue); err != nil {
		return e.fail(err.Error())
	}
	if err := writeIssue(e.out, issue, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}

func readIssueBody(body, bodyFile string) (string, error) {
	if strings.TrimSpace(bodyFile) == "" {
		return strings.TrimSpace(body), nil
	}
	content, err := os.ReadFile(bodyFile)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(content)), nil
}

func createPayload(projectID, title, body, status string, priority int, templateID string) (issueDTO, error) {
	issue := issueDTO{ProjectID: strings.TrimSpace(projectID), Title: strings.TrimSpace(title),
		Description: strings.TrimSpace(body), Status: strings.TrimSpace(status), Priority: priority,
		TemplateID: strings.TrimSpace(templateID)}
	if issue.ProjectID == "" {
		return issue, fmt.Errorf("--project is required")
	}
	if issue.Title == "" && issue.Description == "" {
		return issue, fmt.Errorf("--title or --body/--body-file is required")
	}
	if issue.Status == "" {
		issue.Status = "triage"
	}
	return issue, nil
}

func issueUpdatePayload(status, errText string) map[string]string {
	payload := map[string]string{}
	status = strings.TrimSpace(status)
	errText = strings.TrimSpace(errText)
	if status != "" {
		payload["status"] = status
		if status != "failed" {
			payload["error"] = ""
		}
	}
	if errText != "" {
		payload["error"] = errText
	}
	return payload
}
