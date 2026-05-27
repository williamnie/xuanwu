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
	sourceSessionID := fs.String("source-session", e.env("CODEX_THREAD_ID"), "source session id")
	sourceTurnID := fs.String("source-turn", e.env("CODEX_TURN_ID"), "source turn id")
	sourceExcerpt := fs.String("source-excerpt", "", "source excerpt")
	run := fs.Bool("run", false, "enqueue issue after creation")
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	description, err := readIssueBody(*body, *bodyFile)
	if err != nil {
		return e.fail(err.Error())
	}
	payload, err := createPayload(issueCreateInput{
		projectID: *projectID, title: *title, body: description, status: *status,
		priority: *priority, templateID: *templateID, sourceSessionID: *sourceSessionID,
		sourceTurnID: *sourceTurnID, sourceExcerpt: *sourceExcerpt,
	})
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
	comment := fs.String("comment", "", "verification review comment")
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	id, err := parseID(*idRaw)
	if err != nil {
		return e.fail(err.Error())
	}
	payload := issueActionPayload(action, *comment)
	var issue issueDTO
	path := issueActionPath(id, action)
	if err := postJSON(ctx, e.client, *addr, path, payload, &issue); err != nil {
		return e.fail(err.Error())
	}
	if err := writeIssue(e.out, issue, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}

func issueActionPath(id int64, action string) string {
	if action == "accept" || action == "reject" || action == "request-changes" {
		return fmt.Sprintf("/api/issues/%d/verification", id)
	}
	return fmt.Sprintf("/api/issues/%d/%s", id, action)
}

func issueActionPayload(action string, comment string) map[string]any {
	if action == "accept" || action == "reject" || action == "request-changes" {
		reviewAction := strings.ReplaceAll(action, "-", "_")
		return map[string]any{"action": reviewAction, "comment": strings.TrimSpace(comment)}
	}
	return map[string]any{}
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

type issueCreateInput struct {
	projectID, title, body, status string
	priority                       int
	templateID                     string
	sourceSessionID                string
	sourceTurnID                   string
	sourceExcerpt                  string
}

func createPayload(input issueCreateInput) (issueDTO, error) {
	issue := issueDTO{ProjectID: strings.TrimSpace(input.projectID), Title: strings.TrimSpace(input.title),
		Description: strings.TrimSpace(input.body), Status: strings.TrimSpace(input.status), Priority: input.priority,
		TemplateID: strings.TrimSpace(input.templateID), SourceSessionID: strings.TrimSpace(input.sourceSessionID),
		SourceTurnID: strings.TrimSpace(input.sourceTurnID), SourceExcerpt: strings.TrimSpace(input.sourceExcerpt)}
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
