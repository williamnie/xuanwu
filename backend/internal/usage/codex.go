package usage

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
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

type CodexUsageReport struct {
	Source        string         `json:"source"`
	GeneratedAt   string         `json:"generated_at"`
	EventsScanned int            `json:"events_scanned"`
	LatestUsage   *UsageSnapshot `json:"latest_usage,omitempty"`
	RateLimits    *RateLimits    `json:"rate_limits,omitempty"`
	Summary       UsageSummary   `json:"summary"`
	Daily         []UsagePeriod  `json:"daily"`
	Weekly        []UsagePeriod  `json:"weekly"`
	Monthly       []UsagePeriod  `json:"monthly"`
}

type accumulator struct {
	now         time.Time
	daily       map[string]TokenUsage
	weekly      map[string]TokenUsage
	monthly     map[string]TokenUsage
	report      CodexUsageReport
	latestUsage time.Time
	latestLimit time.Time
}

func ReadCodexUsage(ctx context.Context, root string, now time.Time) (CodexUsageReport, error) {
	if root == "" {
		return CodexUsageReport{}, ErrNoCodexSessionsDir
	}
	acc := newAccumulator(root, now)
	if err := filepath.WalkDir(root, acc.visit(ctx)); err != nil {
		return CodexUsageReport{}, err
	}
	acc.finish()
	return acc.report, nil
}

func newAccumulator(root string, now time.Time) *accumulator {
	return &accumulator{
		now:     now.Local(),
		daily:   map[string]TokenUsage{},
		weekly:  map[string]TokenUsage{},
		monthly: map[string]TokenUsage{},
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
	for {
		chunk, readErr := reader.ReadSlice('\n')
		candidate = appendCandidate(candidate, chunk, readErr)
		if isCompleteLine(readErr) {
			a.handleLine(candidate)
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
	if len(candidate) == 0 && !isTokenCountCandidate(chunk) {
		return nil
	}
	return append(candidate, chunk...)
}

func isCompleteLine(err error) bool {
	return err == nil || err == io.EOF
}

func (a *accumulator) handleLine(line []byte) {
	event, ok := parseTokenEvent(line)
	if !ok {
		return
	}
	a.report.EventsScanned++
	if event.Payload.Info != nil {
		a.addUsage(event.timestamp(), event.Payload.Info.LastTokenUsage)
		a.captureLatestUsage(event)
	}
	if event.Payload.RateLimits != nil {
		a.captureLatestLimits(event)
	}
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
	a.report.Daily = periodsFromMap(a.daily, maxDailyPeriods)
	a.report.Weekly = periodsFromMap(a.weekly, maxWeeklyPeriods)
	a.report.Monthly = periodsFromMap(a.monthly, maxMonthlyPeriods)
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

func normalizeWindow(window *LimitWindow) {
	if window == nil {
		return
	}
	remaining := 100 - window.UsedPercent
	if remaining < 0 {
		remaining = 0
	}
	window.RemainingPercent = remaining
	if window.ResetsAt > 0 {
		window.ResetsAtISO = time.Unix(window.ResetsAt, 0).UTC().Format(time.RFC3339)
	}
}

func periodsFromMap(values map[string]TokenUsage, max int) []UsagePeriod {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) > max {
		keys = keys[len(keys)-max:]
	}
	periods := make([]UsagePeriod, 0, len(keys))
	for _, key := range keys {
		periods = append(periods, UsagePeriod{Key: key, Label: key, Usage: values[key]})
	}
	return periods
}

func isoWeekKey(t time.Time) string {
	year, week := t.ISOWeek()
	return fmt.Sprintf("%04d-W%02d", year, week)
}

func sameDay(a, b time.Time) bool {
	return a.Year() == b.Year() && a.YearDay() == b.YearDay()
}

func sameISOWeek(a, b time.Time) bool {
	aYear, aWeek := a.ISOWeek()
	bYear, bWeek := b.ISOWeek()
	return aYear == bYear && aWeek == bWeek
}
