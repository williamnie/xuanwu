package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

const DefaultIssueTemplateID = "default"

const DefaultIssuePromptTemplate = `{{issue.content}}

执行上下文：
- 项目路径：{{project.cwd}}
- Issue ID：{{issue.id}}
- Issue 标题：{{issue.title}}

要求：
1. 先阅读相关代码确认根因。
2. 只做和这个 issue 直接相关的最小修改。
3. 不要扩大改动范围。
4. 如果需要运行测试，请运行最小必要验证。
5. 完成后总结修改内容、验证结果、未验证风险。
6. 不要提交 git commit，除非用户明确要求。
`

const legacyDefaultIssuePromptTemplate = `你正在处理一个项目 issue。

项目路径：
{{project.cwd}}

Issue 标题：
{{issue.title}}

Issue 描述：
{{issue.description}}

要求：
1. 先阅读相关代码确认根因。
2. 只做和这个 issue 直接相关的最小修改。
3. 不要扩大改动范围。
4. 如果需要运行测试，请运行最小必要验证。
5. 完成后总结修改内容、验证结果、未验证风险。
6. 不要提交 git commit，除非用户明确要求。
`

func (s *Store) ListIssueTemplates(ctx context.Context) ([]IssueTemplate, error) {
	rows, err := s.db.QueryContext(ctx, issueTemplateSelect+` order by is_default desc, created_at asc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	templates := []IssueTemplate{}
	for rows.Next() {
		tmpl, err := scanIssueTemplate(rows)
		if err != nil {
			return nil, err
		}
		templates = append(templates, tmpl)
	}
	return templates, rows.Err()
}

func (s *Store) GetIssueTemplate(ctx context.Context, id string) (IssueTemplate, error) {
	row := s.db.QueryRowContext(ctx, issueTemplateSelect+` where id = ?`, id)
	tmpl, err := scanIssueTemplate(row)
	if errors.Is(err, sql.ErrNoRows) {
		return IssueTemplate{}, ErrNotFound
	}
	return tmpl, err
}

func (s *Store) GetDefaultIssueTemplate(ctx context.Context) (IssueTemplate, error) {
	row := s.db.QueryRowContext(ctx, issueTemplateSelect+` where is_default=1 order by created_at asc limit 1`)
	tmpl, err := scanIssueTemplate(row)
	if errors.Is(err, sql.ErrNoRows) {
		return IssueTemplate{}, ErrNotFound
	}
	return tmpl, err
}

func (s *Store) CreateIssueTemplate(ctx context.Context, tmpl IssueTemplate) (IssueTemplate, error) {
	t := now()
	normalizeIssueTemplate(&tmpl)
	if tmpl.ID == "" {
		tmpl.ID = s.uniqueIssueTemplateID(ctx, issueTemplateIDFromName(tmpl.Name))
	}
	if err := validateIssueTemplate(tmpl); err != nil {
		return IssueTemplate{}, err
	}
	if tmpl.IsDefault != 0 {
		return s.createDefaultIssueTemplate(ctx, tmpl, t)
	}
	_, err := s.db.ExecContext(ctx, `insert into issue_templates
		(id, name, content, is_default, created_at, updated_at)
		values (?, ?, ?, 0, ?, ?)`, tmpl.ID, tmpl.Name, tmpl.Content, t, t)
	if err != nil {
		return IssueTemplate{}, err
	}
	return s.GetIssueTemplate(ctx, tmpl.ID)
}

func (s *Store) UpdateIssueTemplate(ctx context.Context, id string, patch IssueTemplatePatch) (IssueTemplate, error) {
	tmpl, err := s.GetIssueTemplate(ctx, id)
	if err != nil {
		return IssueTemplate{}, err
	}
	wasDefault := tmpl.IsDefault == 1
	applyIssueTemplatePatch(&tmpl, patch)
	if wasDefault && patch.IsDefault != nil && *patch.IsDefault == 0 {
		tmpl.IsDefault = 1
	}
	if err := validateIssueTemplate(tmpl); err != nil {
		return IssueTemplate{}, err
	}
	if patch.IsDefault != nil && *patch.IsDefault != 0 {
		return s.updateDefaultIssueTemplate(ctx, tmpl)
	}
	_, err = s.db.ExecContext(ctx, `update issue_templates set name=?, content=?,
		is_default=?, updated_at=? where id=?`, tmpl.Name, tmpl.Content, tmpl.IsDefault, now(), id)
	if err != nil {
		return IssueTemplate{}, err
	}
	return s.GetIssueTemplate(ctx, id)
}

func (s *Store) DeleteIssueTemplate(ctx context.Context, id string) error {
	tmpl, err := s.GetIssueTemplate(ctx, id)
	if err != nil {
		return err
	}
	count, err := s.issueTemplateCount(ctx)
	if err != nil {
		return err
	}
	if count <= 1 {
		return fmt.Errorf("至少保留一个 issue 模板")
	}
	return s.deleteIssueTemplate(ctx, tmpl)
}

func (s *Store) issueTemplateForIssue(ctx context.Context, id string) (IssueTemplate, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return s.GetDefaultIssueTemplate(ctx)
	}
	return s.GetIssueTemplate(ctx, id)
}

func (s *Store) ensureSeedIssueTemplate() error {
	ctx := context.Background()
	count, err := s.issueTemplateCount(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		_, err = s.CreateIssueTemplate(ctx, IssueTemplate{
			ID: DefaultIssueTemplateID, Name: "默认模板", Content: DefaultIssuePromptTemplate, IsDefault: 1,
		})
		return err
	}
	if err := s.migrateSeedIssueTemplate(ctx); err != nil {
		return err
	}
	return s.ensureOneDefaultIssueTemplate(ctx)
}

func (s *Store) migrateSeedIssueTemplate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `update issue_templates set content=?, updated_at=?
		where id=? and content=?`, DefaultIssuePromptTemplate, now(),
		DefaultIssueTemplateID, legacyDefaultIssuePromptTemplate)
	return err
}

func (s *Store) createDefaultIssueTemplate(ctx context.Context, tmpl IssueTemplate, timestamp string) (IssueTemplate, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return IssueTemplate{}, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `update issue_templates set is_default=0, updated_at=?`, timestamp); err != nil {
		return IssueTemplate{}, err
	}
	_, err = tx.ExecContext(ctx, `insert into issue_templates
		(id, name, content, is_default, created_at, updated_at)
		values (?, ?, ?, 1, ?, ?)`, tmpl.ID, tmpl.Name, tmpl.Content, timestamp, timestamp)
	if err != nil {
		return IssueTemplate{}, err
	}
	if err = tx.Commit(); err != nil {
		return IssueTemplate{}, err
	}
	return s.GetIssueTemplate(ctx, tmpl.ID)
}

func (s *Store) updateDefaultIssueTemplate(ctx context.Context, tmpl IssueTemplate) (IssueTemplate, error) {
	t := now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return IssueTemplate{}, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `update issue_templates set is_default=0, updated_at=?`, t); err != nil {
		return IssueTemplate{}, err
	}
	_, err = tx.ExecContext(ctx, `update issue_templates set name=?, content=?,
		is_default=1, updated_at=? where id=?`, tmpl.Name, tmpl.Content, t, tmpl.ID)
	if err != nil {
		return IssueTemplate{}, err
	}
	if err = tx.Commit(); err != nil {
		return IssueTemplate{}, err
	}
	return s.GetIssueTemplate(ctx, tmpl.ID)
}

func (s *Store) deleteIssueTemplate(ctx context.Context, tmpl IssueTemplate) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `delete from issue_templates where id=?`, tmpl.ID); err != nil {
		return err
	}
	if tmpl.IsDefault == 1 {
		if _, err = tx.ExecContext(ctx, `update issue_templates set is_default=1,
			updated_at=? where id=(select id from issue_templates order by created_at asc limit 1)`, now()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ensureOneDefaultIssueTemplate(ctx context.Context) error {
	var count int
	err := s.db.QueryRowContext(ctx, `select count(*) from issue_templates where is_default=1`).Scan(&count)
	if err != nil || count > 0 {
		return err
	}
	_, err = s.db.ExecContext(ctx, `update issue_templates set is_default=1,
		updated_at=? where id=(select id from issue_templates order by created_at asc limit 1)`, now())
	return err
}

func (s *Store) issueTemplateCount(ctx context.Context) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `select count(*) from issue_templates`).Scan(&count)
	return count, err
}

func (s *Store) uniqueIssueTemplateID(ctx context.Context, base string) string {
	id := base
	for suffix := 2; ; suffix++ {
		if _, err := s.GetIssueTemplate(ctx, id); errors.Is(err, ErrNotFound) {
			return id
		}
		id = fmt.Sprintf("%s-%d", base, suffix)
	}
}

func normalizeIssueTemplate(tmpl *IssueTemplate) {
	tmpl.ID = strings.TrimSpace(tmpl.ID)
	tmpl.Name = strings.TrimSpace(tmpl.Name)
	tmpl.Content = strings.TrimSpace(tmpl.Content)
	if tmpl.IsDefault != 0 {
		tmpl.IsDefault = 1
	}
}

func applyIssueTemplatePatch(tmpl *IssueTemplate, patch IssueTemplatePatch) {
	if patch.Name != nil {
		tmpl.Name = strings.TrimSpace(*patch.Name)
	}
	if patch.Content != nil {
		tmpl.Content = strings.TrimSpace(*patch.Content)
	}
	if patch.IsDefault != nil {
		tmpl.IsDefault = boolInt(*patch.IsDefault != 0)
	}
}

func validateIssueTemplate(tmpl IssueTemplate) error {
	if tmpl.ID == "" {
		return fmt.Errorf("模板 ID 不能为空")
	}
	if tmpl.Name == "" {
		return fmt.Errorf("模板名称不能为空")
	}
	if tmpl.Content == "" {
		return fmt.Errorf("模板内容不能为空")
	}
	return nil
}

func issueTemplateIDFromName(name string) string {
	id := regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(name), "-")
	id = strings.Trim(id, "-")
	if id == "" {
		return "template"
	}
	return id
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

const issueTemplateSelect = `select id, name, content, is_default, created_at, updated_at from issue_templates`
