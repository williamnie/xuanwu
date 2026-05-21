package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

func (r *Runner) runIssue(issue store.Issue) {
	r.execMu.Lock()
	defer r.execMu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	r.setRunning(issue.ID, &runState{cancel: cancel})
	defer r.clearRunning(issue.ID)
	r.publishStatus(issue.ID, store.StatusInProgress)
	project, err := r.store.GetProject(ctx, issue.ProjectID)
	if err != nil {
		r.failIssue(ctx, issue.ID, err.Error())
		return
	}
	if err := r.startCodexTurn(ctx, issue, project); err != nil {
		r.failIssue(ctx, issue.ID, err.Error())
	}
}

func (r *Runner) startCodexTurn(ctx context.Context, issue store.Issue, project store.Project) error {
	if err := r.codex.Start(ctx); err != nil {
		return err
	}
	r.ensureCodexEventPump()
	threadID, err := r.codex.ThreadStart(ctx, codex.ThreadInput{
		CWD: project.CWD, Model: project.Model, ApprovalPolicy: project.ApprovalPolicy,
		Sandbox: project.Sandbox, DeveloperInstructions: developerInstructions(),
	})
	if err != nil {
		return err
	}
	r.updateRuntime(ctx, issue.ID, threadID, "")
	eventsCh, unsubscribe := r.subscribeCodexEvents()
	defer unsubscribe()
	turnID, err := r.codex.TurnStart(ctx, threadID, renderPrompt(project, issue))
	if err != nil {
		return err
	}
	r.updateRuntime(ctx, issue.ID, threadID, turnID)
	return r.consumeEvents(ctx, issue.ID, threadID, turnID, eventsCh)
}

func (r *Runner) consumeEvents(ctx context.Context, issueID int64, threadID, turnID string, eventsCh <-chan codex.Event) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		case event := <-eventsCh:
			if !matches(event, threadID, turnID) {
				continue
			}
			if done, err := r.handleCodexEvent(ctx, issueID, event); done || err != nil {
				return err
			}
		}
	}
}

func (r *Runner) handleCodexEvent(ctx context.Context, issueID int64, event codex.Event) (bool, error) {
	if event.Text != "" {
		r.publishLog(ctx, issueID, event)
	}
	if event.Method == "error" && event.Error != "" {
		r.failIssue(ctx, issueID, event.Error)
		return true, nil
	}
	if event.Method != "turn/completed" {
		return false, nil
	}
	if event.Status == "completed" {
		r.completeIssue(ctx, issueID)
		return true, nil
	}
	if event.Error == "" {
		event.Error = "Codex turn ended with status: " + event.Status
	}
	r.failIssue(ctx, issueID, event.Error)
	return true, nil
}

func matches(event codex.Event, threadID, turnID string) bool {
	if event.ThreadID == "" {
		return false
	}
	if event.ThreadID != threadID {
		return false
	}
	return event.TurnID == "" || event.TurnID == turnID
}

func (r *Runner) publishLog(ctx context.Context, issueID int64, event codex.Event) {
	payload, _ := json.Marshal(map[string]any{"text": event.Text, "codexMethod": event.Method})
	e, err := r.store.AddIssueEvent(ctx, issueID, "issue.log", string(payload))
	if err != nil {
		return
	}
	r.bus.Publish(events.AppEvent{ID: e.ID, Type: "issue.log", IssueID: issueID, Text: event.Text, Payload: e.Payload, CreatedAt: e.CreatedAt})
}

func renderPrompt(project store.Project, issue store.Issue) string {
	return fmt.Sprintf(`你正在处理一个项目 issue。

项目路径：
%s

Issue 标题：
%s

Issue 描述：
%s

要求：
1. 先阅读相关代码确认根因。
2. 只做和这个 issue 直接相关的最小修改。
3. 不要扩大改动范围。
4. 如果需要运行测试，请运行最小必要验证。
5. 完成后总结修改内容、验证结果、未验证风险。
6. 不要提交 git commit，除非用户明确要求。
`, project.CWD, issue.Title, strings.TrimSpace(issue.Description))
}
