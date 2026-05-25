package usage

import (
	"path/filepath"
	"sort"
	"strings"
)

const UnknownUsageKey = "unknown"

type CodexUsageOptions struct {
	Limit    int
	Projects []UsageProjectRef
	Issues   []UsageIssueRef
}

type UsageProjectRef struct {
	ID   string
	Name string
	CWD  string
}

type UsageIssueRef struct {
	ID        int64
	ProjectID string
	SessionID string
	Title     string
	Status    string
}

type UsageProjectAggregate struct {
	ID       string                  `json:"id"`
	Name     string                  `json:"name"`
	CWD      string                  `json:"cwd,omitempty"`
	Unknown  bool                    `json:"unknown,omitempty"`
	Usage    TokenUsage              `json:"usage"`
	Percent  float64                 `json:"percent"`
	Sessions []UsageSessionAggregate `json:"sessions,omitempty"`
	Issues   []UsageIssueAggregate   `json:"issues,omitempty"`
}

type UsageSessionAggregate struct {
	ID        string                `json:"id"`
	ProjectID string                `json:"project_id,omitempty"`
	Unknown   bool                  `json:"unknown,omitempty"`
	Usage     TokenUsage            `json:"usage"`
	Issues    []UsageIssueAggregate `json:"issues,omitempty"`
}

type UsageIssueAggregate struct {
	ID        int64      `json:"id"`
	ProjectID string     `json:"project_id,omitempty"`
	SessionID string     `json:"session_id,omitempty"`
	Title     string     `json:"title,omitempty"`
	Status    string     `json:"status,omitempty"`
	Usage     TokenUsage `json:"usage"`
}

type usageSessionMetadata struct {
	ID  string
	CWD string
}

type usageRecord struct {
	Event   tokenEvent
	Session usageSessionMetadata
}

type dimensionAccumulator struct {
	options       CodexUsageOptions
	projectsByCWD map[string]UsageProjectRef
	issuesBySess  map[string]UsageIssueRef
	projects      map[string]*UsageProjectAggregate
	sessions      map[string]*UsageSessionAggregate
	issues        map[int64]*UsageIssueAggregate
}

type issueUsageTarget struct {
	Project *UsageProjectAggregate
	Session *UsageSessionAggregate
	Issue   UsageIssueRef
}

func newDimensionAccumulator(options CodexUsageOptions) dimensionAccumulator {
	return dimensionAccumulator{
		options:       sanitizeOptions(options),
		projectsByCWD: projectRefsByCWD(options.Projects),
		issuesBySess:  issueRefsBySession(options.Issues),
		projects:      map[string]*UsageProjectAggregate{},
		sessions:      map[string]*UsageSessionAggregate{},
		issues:        map[int64]*UsageIssueAggregate{},
	}
}

func (a *dimensionAccumulator) add(record usageRecord, usage TokenUsage) {
	if usage.TotalTokens == 0 {
		return
	}
	project, unknown := a.projectFor(record.Session.CWD)
	projectAgg := a.ensureProject(project, unknown)
	projectAgg.Usage.add(usage)

	sessionAgg := a.ensureSession(projectAgg.ID, record.Session.ID)
	sessionAgg.Usage.add(usage)
	if issue, ok := a.issueFor(record.Session.ID); ok {
		a.addIssueUsage(issueUsageTarget{Project: projectAgg, Session: sessionAgg, Issue: issue}, usage)
	}
}

func (a *dimensionAccumulator) finish(totalTokens int64) []UsageProjectAggregate {
	if len(a.projects) == 0 {
		return nil
	}
	for _, session := range a.sessions {
		session.Issues = sortedIssues(session.Issues)
		if project := a.projects[session.ProjectID]; project != nil {
			project.Sessions = append(project.Sessions, *session)
		}
	}
	for _, project := range a.projects {
		project.Percent = usagePercent(project.Usage.TotalTokens, totalTokens)
		project.Sessions = sortedSessions(project.Sessions)
		project.Issues = sortedIssues(project.Issues)
	}
	return sortedProjects(a.projects)
}

func (a *dimensionAccumulator) projectFor(cwd string) (UsageProjectRef, bool) {
	if project, ok := a.projectsByCWD[normalizeCWD(cwd)]; ok {
		return project, false
	}
	return UsageProjectRef{ID: UnknownUsageKey, Name: "Unknown"}, true
}

func (a *dimensionAccumulator) issueFor(sessionID string) (UsageIssueRef, bool) {
	issue, ok := a.issuesBySess[normalizeSessionID(sessionID)]
	return issue, ok
}

func (a *dimensionAccumulator) ensureProject(ref UsageProjectRef, unknown bool) *UsageProjectAggregate {
	if current, ok := a.projects[ref.ID]; ok {
		return current
	}
	agg := &UsageProjectAggregate{ID: ref.ID, Name: firstNonEmpty(ref.Name, ref.ID), CWD: ref.CWD, Unknown: unknown}
	a.projects[ref.ID] = agg
	return agg
}

func (a *dimensionAccumulator) ensureSession(projectID, sessionID string) *UsageSessionAggregate {
	id := normalizeSessionID(sessionID)
	if id == "" {
		id = UnknownUsageKey
	}
	key := projectID + "\x00" + id
	if current, ok := a.sessions[key]; ok {
		return current
	}
	agg := &UsageSessionAggregate{ID: id, ProjectID: projectID, Unknown: id == UnknownUsageKey}
	a.sessions[key] = agg
	return agg
}

func (a *dimensionAccumulator) addIssueUsage(target issueUsageTarget, usage TokenUsage) {
	issue := a.ensureIssue(target.Issue)
	issue.Usage.add(usage)
	target.Project.Issues = upsertIssue(target.Project.Issues, *issue)
	target.Session.Issues = upsertIssue(target.Session.Issues, *issue)
}

func (a *dimensionAccumulator) ensureIssue(ref UsageIssueRef) *UsageIssueAggregate {
	if current, ok := a.issues[ref.ID]; ok {
		return current
	}
	agg := &UsageIssueAggregate{
		ID: ref.ID, ProjectID: ref.ProjectID, SessionID: normalizeSessionID(ref.SessionID),
		Title: ref.Title, Status: ref.Status,
	}
	a.issues[ref.ID] = agg
	return agg
}

func sanitizeOptions(options CodexUsageOptions) CodexUsageOptions {
	if options.Limit < 0 {
		options.Limit = 0
	}
	return options
}

func projectRefsByCWD(projects []UsageProjectRef) map[string]UsageProjectRef {
	out := map[string]UsageProjectRef{}
	for _, project := range projects {
		if cwd := normalizeCWD(project.CWD); cwd != "" {
			out[cwd] = project
		}
	}
	return out
}

func issueRefsBySession(issues []UsageIssueRef) map[string]UsageIssueRef {
	out := map[string]UsageIssueRef{}
	for _, issue := range issues {
		if sessionID := normalizeSessionID(issue.SessionID); sessionID != "" {
			out[sessionID] = issue
		}
	}
	return out
}

func filteredUsageRecords(records []usageRecord, limit int) []usageRecord {
	sort.SliceStable(records, func(i, j int) bool {
		return records[i].Event.timestamp().Before(records[j].Event.timestamp())
	})
	if limit > 0 && len(records) > limit {
		return records[len(records)-limit:]
	}
	return records
}

func normalizeCWD(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return filepath.Clean(trimmed)
}

func normalizeSessionID(value string) string {
	value = strings.TrimSpace(value)
	_, sessionID, ok := strings.Cut(value, ":")
	if ok {
		value = strings.TrimSpace(sessionID)
	}
	return value
}

func usagePercent(value int64, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return (float64(value) / float64(total)) * 100
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return UnknownUsageKey
}
