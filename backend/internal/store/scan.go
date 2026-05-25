package store

import (
	"database/sql"
	"errors"
)

var ErrNotFound = errors.New("not found")

type scanner interface {
	Scan(dest ...any) error
}

func scanProject(row scanner) (Project, error) {
	var p Project
	var holdReason, holdMessage, holdSince, nextCheckAt, lastCheckAt, lastCheckError sql.NullString
	err := row.Scan(&p.ID, &p.Name, &p.CWD, &p.Provider, &p.ProviderConfig,
		&p.AutoRun, &p.Model, &p.ApprovalPolicy, &p.Sandbox, &p.SortOrder, &p.CreatedAt, &p.UpdatedAt,
		&holdReason, &holdMessage, &holdSince, &nextCheckAt, &lastCheckAt, &lastCheckError)
	if err == nil {
		applyProjectDefaults(&p)
		p.Hold = nullableProjectHold(holdReason, holdMessage, holdSince, nextCheckAt, lastCheckAt, lastCheckError)
	}
	return p, err
}

func nullableProjectHold(reason, message, since, nextAt, lastAt, lastErr sql.NullString) *ProjectHold {
	if !reason.Valid {
		return nil
	}
	return &ProjectHold{
		Reason: reason.String, Message: message.String, HoldSince: since.String,
		NextCheckAt: nextAt.String, LastCheckAt: lastAt.String, LastCheckError: lastErr.String,
	}
}

func scanIssue(row scanner) (Issue, error) {
	var i Issue
	err := row.Scan(&i.ID, &i.ProjectID, &i.Title, &i.Description, &i.Status,
		&i.Priority, &i.TemplateID, &i.PromptTemplate, &i.CodexThreadID,
		&i.CodexTurnID, &i.AttemptCount, &i.AutoRetryNextAt,
		&i.AutoRetryReason, &i.Error, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

func scanIssueTemplate(row scanner) (IssueTemplate, error) {
	var tmpl IssueTemplate
	err := row.Scan(&tmpl.ID, &tmpl.Name, &tmpl.Content, &tmpl.IsDefault,
		&tmpl.CreatedAt, &tmpl.UpdatedAt)
	return tmpl, err
}

func scanIssueEvent(row scanner) (IssueEvent, error) {
	var e IssueEvent
	err := row.Scan(&e.ID, &e.IssueID, &e.Type, &e.Payload, &e.CreatedAt)
	return e, err
}

func scanIssueRun(row scanner) (IssueRun, error) {
	var run IssueRun
	err := row.Scan(&run.ID, &run.IssueID, &run.Attempt, &run.Status,
		&run.Provider, &run.ProviderSessionID, &run.ProviderTurnID,
		&run.CodexThreadID, &run.CodexTurnID, &run.StartedAt,
		&run.EndedAt, &run.ExitReason, &run.Error)
	return run, err
}

func scanCronTask(row scanner) (CronTask, error) {
	var task CronTask
	err := row.Scan(&task.ID, &task.Name, &task.ProjectID, &task.Action,
		&task.Mode, &task.TimeOfDay, &task.NextRunAt, &task.LastRunAt,
		&task.LastStatus, &task.LastResult, &task.Status, &task.RunCount,
		&task.Error, &task.CreatedAt, &task.UpdatedAt)
	if err == nil {
		task.LastError = task.Error
	}
	return task, err
}

func scanUpload(row scanner) (Upload, error) {
	var upload Upload
	err := row.Scan(&upload.ID, &upload.OriginalName, &upload.MimeType,
		&upload.SizeBytes, &upload.SHA256, &upload.StoragePath, &upload.CreatedAt)
	if err == nil {
		upload.URL = uploadContentURL(upload.ID)
	}
	return upload, err
}

func requireAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
