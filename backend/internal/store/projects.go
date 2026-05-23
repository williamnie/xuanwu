package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

func (s *Store) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, projectSelect+` order by sort_order asc, created_at asc, id asc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	projects := []Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

func (s *Store) CreateProject(ctx context.Context, p Project) (Project, error) {
	t := now()
	applyProjectDefaults(&p)
	if p.ApprovalPolicy == "" {
		p.ApprovalPolicy = "never"
	}
	if p.Sandbox == "" {
		p.Sandbox = "workspace-write"
	}
	nextOrder, err := s.nextProjectSortOrder(ctx)
	if err != nil {
		return Project{}, err
	}
	p.SortOrder = nextOrder
	_, err = s.db.ExecContext(ctx, `insert into projects
		(id, name, cwd, auto_run, model, approval_policy, sandbox, sort_order, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.CWD, p.AutoRun, p.Model, p.ApprovalPolicy, p.Sandbox, p.SortOrder, t, t)
	if err != nil {
		return Project{}, err
	}
	return s.GetProject(ctx, p.ID)
}

func (s *Store) GetProject(ctx context.Context, id string) (Project, error) {
	row := s.db.QueryRowContext(ctx, projectSelect+` where id = ?`, id)
	p, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	return p, err
}

func (s *Store) UpdateProject(ctx context.Context, id string, patch ProjectPatch) (Project, error) {
	p, err := s.GetProject(ctx, id)
	if err != nil {
		return Project{}, err
	}
	patch = applyProjectPatchDefaults(&p, patch)
	applyProjectPatch(&p, patch)
	_, err = s.db.ExecContext(ctx, `update projects set name=?, cwd=?, auto_run=?,
		model=?, approval_policy=?, sandbox=?, updated_at=? where id=?`,
		p.Name, p.CWD, p.AutoRun, p.Model, p.ApprovalPolicy, p.Sandbox, now(), id)
	if err != nil {
		return Project{}, err
	}
	return s.GetProject(ctx, id)
}

func (s *Store) ReorderProjects(ctx context.Context, ids []string) ([]Project, error) {
	if len(ids) == 0 {
		return nil, fmt.Errorf("project order 不能为空")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if err := validateProjectIDs(ctx, tx, ids); err != nil {
		return nil, err
	}
	updatedAt := now()
	for index, id := range ids {
		if _, err := tx.ExecContext(ctx, `update projects set sort_order=?, updated_at=? where id=?`,
			index+1, updatedAt, id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.ListProjects(ctx)
}

func validateProjectIDs(ctx context.Context, tx *sql.Tx, ids []string) error {
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if strings.TrimSpace(id) == "" {
			return fmt.Errorf("project id 不能为空")
		}
		if seen[id] {
			return fmt.Errorf("project id 重复: %s", id)
		}
		seen[id] = true
	}

	var count int
	if err := tx.QueryRowContext(ctx, `select count(*) from projects`).Scan(&count); err != nil {
		return err
	}
	if count != len(ids) {
		return fmt.Errorf("project order 必须包含全部项目")
	}

	rows, err := tx.QueryContext(ctx, `select id from projects`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		if !seen[id] {
			return fmt.Errorf("project order 缺少项目: %s", id)
		}
	}
	return rows.Err()
}

func (s *Store) DeleteProject(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `delete from projects where id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

func applyProjectDefaults(p *Project) {
	p.CWD = strings.TrimSpace(p.CWD)
	if strings.TrimSpace(p.Name) == "" {
		p.Name = projectNameFromCWD(p.CWD)
	}
	p.Model = normalizeProjectModel(p.Model)
}

func applyProjectPatchDefaults(p *Project, patch ProjectPatch) ProjectPatch {
	if patch.CWD != nil {
		nextCWD := strings.TrimSpace(*patch.CWD)
		*patch.CWD = nextCWD
		if patch.Name == nil || strings.TrimSpace(*patch.Name) == "" {
			name := projectNameFromCWD(nextCWD)
			patch.Name = &name
		}
	}
	if patch.Name != nil && strings.TrimSpace(*patch.Name) == "" {
		name := projectNameFromCWD(p.CWD)
		patch.Name = &name
	}
	if patch.Model != nil {
		model := normalizeProjectModel(*patch.Model)
		patch.Model = &model
	}
	return patch
}

func applyProjectPatch(p *Project, patch ProjectPatch) {
	if patch.Name != nil {
		p.Name = strings.TrimSpace(*patch.Name)
	}
	if patch.CWD != nil {
		p.CWD = strings.TrimSpace(*patch.CWD)
	}
	if patch.AutoRun != nil {
		p.AutoRun = *patch.AutoRun
	}
	if patch.Model != nil {
		p.Model = normalizeProjectModel(*patch.Model)
	}
	if patch.ApprovalPolicy != nil {
		p.ApprovalPolicy = *patch.ApprovalPolicy
	}
	if patch.Sandbox != nil {
		p.Sandbox = *patch.Sandbox
	}
}

func (s *Store) nextProjectSortOrder(ctx context.Context) (int, error) {
	var maxOrder int
	err := s.db.QueryRowContext(ctx, `select coalesce(max(sort_order), 0) from projects`).Scan(&maxOrder)
	if err != nil {
		return 0, err
	}
	return maxOrder + 1, nil
}

const projectSelect = `select id, name, cwd, auto_run, model, approval_policy,
	sandbox, sort_order, created_at, updated_at from projects`

func projectNameFromCWD(cwd string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(cwd), string(filepath.Separator))
	name := filepath.Base(trimmed)
	if name == "." || name == string(filepath.Separator) || name == "" {
		return "project"
	}
	return name
}

func normalizeProjectModel(model string) string {
	model = strings.TrimSpace(model)
	if model == "" || strings.HasPrefix(strings.ToLower(model), "gemini-") {
		return "codex-default"
	}
	return model
}
