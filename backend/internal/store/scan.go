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
	err := row.Scan(&p.ID, &p.Name, &p.CWD, &p.AutoRun, &p.Model,
		&p.ApprovalPolicy, &p.Sandbox, &p.CreatedAt, &p.UpdatedAt)
	if err == nil {
		applyProjectDefaults(&p)
	}
	return p, err
}

func scanIssue(row scanner) (Issue, error) {
	var i Issue
	err := row.Scan(&i.ID, &i.ProjectID, &i.Title, &i.Description, &i.Status,
		&i.Priority, &i.TemplateID, &i.PromptTemplate, &i.CodexThreadID,
		&i.CodexTurnID, &i.AttemptCount, &i.Error, &i.CreatedAt, &i.UpdatedAt)
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
