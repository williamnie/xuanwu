package usage

import (
	"fmt"
	"sort"
	"time"
)

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
