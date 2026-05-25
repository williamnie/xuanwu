package usage

import (
	"bufio"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const (
	maxDailyPeriods   = 31
	maxWeeklyPeriods  = 12
	maxMonthlyPeriods = 12
)

var ErrNoCodexSessionsDir = errors.New("codex sessions dir 未配置")

type TokenUsage struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
	TotalTokens           int64 `json:"total_tokens"`
}

type LimitWindow struct {
	UsedPercent      float64 `json:"used_percent"`
	RemainingPercent float64 `json:"remaining_percent"`
	WindowMinutes    int     `json:"window_minutes"`
	ResetsAt         int64   `json:"resets_at"`
	ResetsAtISO      string  `json:"resets_at_iso,omitempty"`
}

type RateLimits struct {
	CapturedAt           string       `json:"captured_at,omitempty"`
	LimitID              string       `json:"limit_id,omitempty"`
	LimitName            string       `json:"limit_name,omitempty"`
	PlanType             string       `json:"plan_type,omitempty"`
	RateLimitReachedType string       `json:"rate_limit_reached_type,omitempty"`
	Primary              *LimitWindow `json:"primary,omitempty"`
	Secondary            *LimitWindow `json:"secondary,omitempty"`
	Credits              any          `json:"credits,omitempty"`
}

type UsageSnapshot struct {
	CapturedAt         string     `json:"captured_at"`
	TotalTokenUsage    TokenUsage `json:"total_token_usage"`
	LastTokenUsage     TokenUsage `json:"last_token_usage"`
	ModelContextWindow int64      `json:"model_context_window,omitempty"`
}

type UsagePeriod struct {
	Key   string     `json:"key"`
	Label string     `json:"label"`
	Usage TokenUsage `json:"usage"`
}

type UsageSummary struct {
	Today     TokenUsage `json:"today"`
	ThisWeek  TokenUsage `json:"this_week"`
	ThisMonth TokenUsage `json:"this_month"`
	AllTime   TokenUsage `json:"all_time"`
}

type CodexUsageReadRequest struct {
	Root    string
	Now     time.Time
	Options CodexUsageOptions
}

type CodexUsageReport struct {
	Source        string                  `json:"source"`
	GeneratedAt   string                  `json:"generated_at"`
	EventsScanned int                     `json:"events_scanned"`
	LatestUsage   *UsageSnapshot          `json:"latest_usage,omitempty"`
	RateLimits    *RateLimits             `json:"rate_limits,omitempty"`
	Summary       UsageSummary            `json:"summary"`
	Daily         []UsagePeriod           `json:"daily"`
	Weekly        []UsagePeriod           `json:"weekly"`
	Monthly       []UsagePeriod           `json:"monthly"`
	ProjectUsage  []UsageProjectAggregate `json:"project_usage,omitempty"`
}

type accumulator struct {
	now         time.Time
	daily       map[string]TokenUsage
	weekly      map[string]TokenUsage
	monthly     map[string]TokenUsage
	report      CodexUsageReport
	latestUsage time.Time
	latestLimit time.Time
	records     []usageRecord
	dimensions  dimensionAccumulator
}

func ReadCodexUsage(ctx context.Context, root string, now time.Time) (CodexUsageReport, error) {
	return ReadCodexUsageWithOptions(ctx, CodexUsageReadRequest{Root: root, Now: now})
}

func ReadCodexUsageWithOptions(
	ctx context.Context,
	req CodexUsageReadRequest,
) (CodexUsageReport, error) {
	if req.Root == "" {
		return CodexUsageReport{}, ErrNoCodexSessionsDir
	}
	acc := newAccumulator(req.Root, req.Now, req.Options)
	if err := filepath.WalkDir(req.Root, acc.visit(ctx)); err != nil {
		return CodexUsageReport{}, err
	}
	acc.finish()
	return acc.report, nil
}

func newAccumulator(root string, now time.Time, options CodexUsageOptions) *accumulator {
	return &accumulator{
		now:        now.Local(),
		daily:      map[string]TokenUsage{},
		weekly:     map[string]TokenUsage{},
		monthly:    map[string]TokenUsage{},
		dimensions: newDimensionAccumulator(options),
		report: CodexUsageReport{
			Source:      root,
			GeneratedAt: now.UTC().Format(time.RFC3339),
		},
	}
}

func (a *accumulator) visit(ctx context.Context) fs.WalkDirFunc {
	return func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != ".jsonl" {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			return a.scanFile(path)
		}
	}
}

func (a *accumulator) scanFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	reader := bufio.NewReaderSize(file, 256*1024)
	var candidate []byte
	meta := usageSessionMetadata{}
	for {
		chunk, readErr := reader.ReadSlice('\n')
		candidate = appendCandidate(candidate, chunk, readErr)
		if isCompleteLine(readErr) {
			a.handleLine(candidate, &meta)
			candidate = nil
		}
		if readErr == nil || readErr == bufio.ErrBufferFull {
			continue
		}
		if readErr == io.EOF {
			return nil
		}
		return readErr
	}
}

func appendCandidate(candidate, chunk []byte, err error) []byte {
	if len(candidate) == 0 && !isUsageCandidate(chunk) {
		return nil
	}
	return append(candidate, chunk...)
}

func isCompleteLine(err error) bool {
	return err == nil || err == io.EOF
}

func (a *accumulator) handleLine(line []byte, meta *usageSessionMetadata) {
	if session, ok := parseSessionMetaEvent(line); ok {
		meta.ID = session.Payload.ID
		meta.CWD = session.Payload.CWD
		return
	}
	event, ok := parseTokenEvent(line)
	if !ok {
		return
	}
	a.records = append(a.records, usageRecord{Event: event, Session: *meta})
}

func (a *accumulator) addUsage(ts time.Time, usage TokenUsage) {
	if usage.TotalTokens == 0 {
		return
	}
	local := ts.Local()
	a.report.Summary.AllTime.add(usage)
	addToMap(a.daily, local.Format("2006-01-02"), usage)
	addToMap(a.weekly, isoWeekKey(local), usage)
	addToMap(a.monthly, local.Format("2006-01"), usage)
	if sameDay(local, a.now) {
		a.report.Summary.Today.add(usage)
	}
	if sameISOWeek(local, a.now) {
		a.report.Summary.ThisWeek.add(usage)
	}
	if local.Format("2006-01") == a.now.Format("2006-01") {
		a.report.Summary.ThisMonth.add(usage)
	}
}

func (a *accumulator) captureLatestUsage(event tokenEvent) {
	ts := event.timestamp()
	if !a.latestUsage.IsZero() && !ts.After(a.latestUsage) {
		return
	}
	a.latestUsage = ts
	a.report.LatestUsage = &UsageSnapshot{
		CapturedAt:         ts.UTC().Format(time.RFC3339),
		TotalTokenUsage:    event.Payload.Info.TotalTokenUsage,
		LastTokenUsage:     event.Payload.Info.LastTokenUsage,
		ModelContextWindow: event.Payload.Info.ModelContextWindow,
	}
}

func (a *accumulator) captureLatestLimits(event tokenEvent) {
	ts := event.timestamp()
	if !a.latestLimit.IsZero() && !ts.After(a.latestLimit) {
		return
	}
	a.latestLimit = ts
	limits := *event.Payload.RateLimits
	limits.CapturedAt = ts.UTC().Format(time.RFC3339)
	normalizeWindow(limits.Primary)
	normalizeWindow(limits.Secondary)
	a.report.RateLimits = &limits
}

func (a *accumulator) finish() {
	for _, record := range filteredUsageRecords(a.records, a.dimensions.options.Limit) {
		a.report.EventsScanned++
		if record.Event.Payload.Info != nil {
			usage := record.Event.Payload.Info.LastTokenUsage
			a.addUsage(record.Event.timestamp(), usage)
			a.captureLatestUsage(record.Event)
			a.dimensions.add(record, usage)
		}
		if record.Event.Payload.RateLimits != nil {
			a.captureLatestLimits(record.Event)
		}
	}
	a.report.Daily = periodsFromMap(a.daily, maxDailyPeriods)
	a.report.Weekly = periodsFromMap(a.weekly, maxWeeklyPeriods)
	a.report.Monthly = periodsFromMap(a.monthly, maxMonthlyPeriods)
	a.report.ProjectUsage = a.dimensions.finish(a.report.Summary.AllTime.TotalTokens)
}

func (u *TokenUsage) add(other TokenUsage) {
	u.InputTokens += other.InputTokens
	u.CachedInputTokens += other.CachedInputTokens
	u.OutputTokens += other.OutputTokens
	u.ReasoningOutputTokens += other.ReasoningOutputTokens
	u.TotalTokens += other.TotalTokens
}

func addToMap(values map[string]TokenUsage, key string, usage TokenUsage) {
	current := values[key]
	current.add(usage)
	values[key] = current
}
