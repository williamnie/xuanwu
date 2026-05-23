package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const defaultWebhookTimeout = 5 * time.Second

type Notifier struct {
	store  *store.Store
	bus    *events.Bus
	client *http.Client
	now    func() time.Time
}

type WebhookPayload struct {
	Event         string `json:"event"`
	IssueID       int64  `json:"issue_id"`
	Title         string `json:"title"`
	Status        string `json:"status"`
	Project       string `json:"project"`
	ProjectName   string `json:"project_name,omitempty"`
	RunID         string `json:"run_id,omitempty"`
	CodexThreadID string `json:"codex_thread_id,omitempty"`
	CodexTurnID   string `json:"codex_turn_id,omitempty"`
	OccurredAt    string `json:"occurred_at"`
}

func New(st *store.Store, bus *events.Bus, client *http.Client) *Notifier {
	if client == nil {
		client = &http.Client{Timeout: defaultWebhookTimeout}
	}
	return &Notifier{store: st, bus: bus, client: client, now: func() time.Time { return time.Now() }}
}

func ShouldNotify(settings store.NotificationSettings, status string, now time.Time) bool {
	if strings.TrimSpace(settings.WebhookURL) == "" {
		return false
	}
	if !eventEnabled(settings.Events, status) {
		return false
	}
	return insideActiveHours(settings.ActiveStart, settings.ActiveEnd, now)
}

func (n *Notifier) NotifyIssueStatus(ctx context.Context, issue store.Issue) {
	if n == nil || n.store == nil {
		return
	}
	now := n.now()
	settings, err := n.store.NotificationSettings(ctx)
	if err != nil || !ShouldNotify(settings, issue.Status, now) {
		return
	}
	project := n.projectSnapshot(ctx, issue.ProjectID)
	payload := buildWebhookPayload(issue, project, now)
	go n.sendWebhook(context.Background(), issue.ID, settings.WebhookURL, payload)
}

func (n *Notifier) projectSnapshot(ctx context.Context, projectID string) store.Project {
	project, err := n.store.GetProject(ctx, projectID)
	if err != nil {
		return store.Project{ID: projectID}
	}
	return project
}

func (n *Notifier) sendWebhook(ctx context.Context, issueID int64, webhookURL string, payload WebhookPayload) {
	ctx, cancel := context.WithTimeout(ctx, defaultWebhookTimeout)
	defer cancel()
	body, err := json.Marshal(payload)
	if err != nil {
		n.recordFailure(ctx, issueID, err)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		n.recordFailure(ctx, issueID, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := n.client.Do(req)
	if err != nil {
		n.recordFailure(ctx, issueID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		n.recordFailure(ctx, issueID, fmt.Errorf("webhook returned %s: %s", resp.Status, responseSnippet(resp.Body)))
	}
}

func (n *Notifier) recordFailure(ctx context.Context, issueID int64, err error) {
	log.Printf("notification webhook failed for issue %d: %v", issueID, err)
	payload, _ := json.Marshal(map[string]string{"channel": "webhook", "error": err.Error()})
	event, addErr := n.store.AddIssueEvent(ctx, issueID, "issue.notification_failed", string(payload))
	if addErr != nil {
		return
	}
	if n.bus != nil {
		n.bus.Publish(events.AppEvent{
			ID: event.ID, Type: event.Type, IssueID: issueID,
			Error: err.Error(), Payload: event.Payload, CreatedAt: event.CreatedAt,
		})
	}
}

func buildWebhookPayload(issue store.Issue, project store.Project, now time.Time) WebhookPayload {
	return WebhookPayload{
		Event:         "issue." + issue.Status,
		IssueID:       issue.ID,
		Title:         issue.Title,
		Status:        issue.Status,
		Project:       issue.ProjectID,
		ProjectName:   project.Name,
		RunID:         runID(issue),
		CodexThreadID: issue.CodexThreadID,
		CodexTurnID:   issue.CodexTurnID,
		OccurredAt:    now.UTC().Format(time.RFC3339),
	}
}

func runID(issue store.Issue) string {
	if issue.CodexTurnID != "" {
		return issue.CodexTurnID
	}
	return issue.CodexThreadID
}

func eventEnabled(events []string, status string) bool {
	for _, event := range events {
		if event == status {
			return true
		}
	}
	return false
}

func insideActiveHours(start, end string, now time.Time) bool {
	startMinute, okStart := parseClock(start)
	endMinute, okEnd := parseClock(end)
	if !okStart || !okEnd || startMinute == endMinute {
		return true
	}
	current := now.Hour()*60 + now.Minute()
	if startMinute < endMinute {
		return current >= startMinute && current <= endMinute
	}
	return current >= startMinute || current <= endMinute
}

func parseClock(value string) (int, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	parsed, err := time.Parse("15:04", value)
	if err != nil {
		return 0, false
	}
	return parsed.Hour()*60 + parsed.Minute(), true
}

func responseSnippet(body io.Reader) string {
	data, _ := io.ReadAll(io.LimitReader(body, 512))
	return strings.TrimSpace(string(data))
}
