package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
)

func (s *Store) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, projectSelect+` order by p.sort_order asc, p.created_at asc, p.id asc`)
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return s.attachProjectAgentProfiles(ctx, projects)
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
		(id, name, cwd, provider, provider_config_json, auto_run, model,
		approval_policy, sandbox, default_agent_profile_id, sort_order, created_at, updated_at)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.CWD, p.Provider, p.ProviderConfig, p.AutoRun, p.Model,
		p.ApprovalPolicy, p.Sandbox, p.DefaultAgentProfileID, p.SortOrder, t, t)
	if err != nil {
		return Project{}, err
	}
	return s.GetProject(ctx, p.ID)
}

func (s *Store) GetProject(ctx context.Context, id string) (Project, error) {
	row := s.db.QueryRowContext(ctx, projectSelect+` where p.id = ?`, id)
	p, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, err
	}
	return s.attachProjectAgentProfile(ctx, p)
}

func (s *Store) UpdateProject(ctx context.Context, id string, patch ProjectPatch) (Project, error) {
	p, err := s.GetProject(ctx, id)
	if err != nil {
		return Project{}, err
	}
	patch = applyProjectPatchDefaults(&p, patch)
	applyProjectPatch(&p, patch)
	_, err = s.db.ExecContext(ctx, `update projects set name=?, cwd=?, provider=?,
		provider_config_json=?, auto_run=?, model=?, approval_policy=?, sandbox=?,
		default_agent_profile_id=?, updated_at=? where id=?`,
		p.Name, p.CWD, p.Provider, p.ProviderConfig, p.AutoRun,
		p.Model, p.ApprovalPolicy, p.Sandbox, p.DefaultAgentProfileID, now(), id)
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

func (s *Store) attachProjectAgentProfile(ctx context.Context, project Project) (Project, error) {
	projects, err := s.attachProjectAgentProfiles(ctx, []Project{project})
	if err != nil || len(projects) == 0 {
		return project, err
	}
	return projects[0], nil
}

func (s *Store) attachProjectAgentProfiles(ctx context.Context, projects []Project) ([]Project, error) {
	for idx := range projects {
		profileID := strings.TrimSpace(projects[idx].DefaultAgentProfileID)
		if profileID == "" {
			continue
		}
		profile, err := s.GetAgentProfile(ctx, profileID)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		projects[idx].DefaultAgentProfile = &profile
	}
	return projects, nil
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
	p.Provider = normalizeProjectProvider(p.Provider)
	p.ProviderConfig = normalizeProjectProviderConfig(p.ProviderConfig)
	if strings.TrimSpace(p.Name) == "" {
		p.Name = projectNameFromCWD(p.CWD)
	}
	p.Model = normalizeProjectModel(p.Model)
	p.DefaultAgentProfileID = normalizeIdentifier(p.DefaultAgentProfileID)
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
	if patch.Provider != nil {
		provider := normalizeProjectProvider(*patch.Provider)
		patch.Provider = &provider
	}
	if patch.ProviderConfig != nil {
		config := normalizeProjectProviderConfig(*patch.ProviderConfig)
		patch.ProviderConfig = &config
	}
	if patch.DefaultAgentProfileID != nil {
		profileID := normalizeIdentifier(*patch.DefaultAgentProfileID)
		patch.DefaultAgentProfileID = &profileID
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
	if patch.Provider != nil {
		p.Provider = normalizeProjectProvider(*patch.Provider)
	}
	if patch.ProviderConfig != nil {
		p.ProviderConfig = normalizeProjectProviderConfig(*patch.ProviderConfig)
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
	if patch.DefaultAgentProfileID != nil {
		p.DefaultAgentProfileID = normalizeIdentifier(*patch.DefaultAgentProfileID)
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

const projectSelect = `select p.id, p.name, p.cwd, p.provider, p.provider_config_json,
	p.auto_run, p.model, p.approval_policy,
	p.sandbox, p.default_agent_profile_id, p.sort_order, p.created_at, p.updated_at,
	h.reason, h.message, h.hold_since, h.next_check_at, h.last_check_at, h.last_check_error
	from projects p left join project_holds h on h.project_id=p.id`

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

func normalizeProjectProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		return ProviderCodex
	}
	return provider
}

func normalizeProjectProviderConfig(config string) string {
	config = strings.TrimSpace(config)
	if config == "" {
		return "{}"
	}
	return config
}

func AttachProjectCapabilities(projects []Project) {
	for i := range projects {
		AttachProjectCapability(&projects[i])
	}
}

func AttachProjectCapability(project *Project) {
	project.ProviderCapabilities = ProjectProviderCapabilities(project.Provider)
}

func ProjectProviderCapabilities(provider string) []string {
	capabilities := agent.CapabilitiesForProviderID(provider)
	result := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		result = append(result, string(capability))
	}
	return result
}
