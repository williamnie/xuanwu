package runner

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	HoldReasonUsageLimit     = "usage_limit"
	HoldReasonAuthentication = "authentication"
)

type holdReason struct {
	Kind        string
	Message     string
	NextCheckAt time.Time
}

var holdJSONErrorType = regexp.MustCompile(`"type"\s*:\s*"([^"]+)"`)

func isRunnerHoldError(text string) (holdReason, bool) {
	source := strings.TrimSpace(text)
	if source == "" {
		return holdReason{}, false
	}
	lower := strings.ToLower(source)
	if isUsageLimitText(lower) {
		return holdReason{
			Kind:        HoldReasonUsageLimit,
			Message:     usageLimitMessage(source, lower),
			NextCheckAt: usageLimitNextCheck(source),
		}, true
	}
	if isAuthText(lower) {
		return holdReason{
			Kind:    HoldReasonAuthentication,
			Message: "Runner paused: authentication failed",
		}, true
	}
	return holdReason{}, false
}

func isUsageLimitText(lower string) bool {
	if typ := extractJSONErrorType(lower); typ != "" {
		return typ == "usage_limit_reached" || typ == "rate_limit_exceeded" || typ == "insufficient_quota"
	}
	if strings.Contains(lower, "api returned 429") || strings.Contains(lower, "http 429") ||
		strings.Contains(lower, "429 too many requests") || strings.Contains(lower, "status 429") {
		return true
	}
	for _, token := range []string{
		"usage_limit_reached", "rate_limit_exceeded", "insufficient_quota",
		"usage limit has been reached", "resets_at", "resets_in_seconds",
	} {
		if strings.Contains(lower, token) {
			return true
		}
	}
	return false
}

func isAuthText(lower string) bool {
	if typ := extractJSONErrorType(lower); typ != "" {
		return typ == "invalid_api_key"
	}
	if strings.Contains(lower, "api returned 401") || strings.Contains(lower, "http 401") ||
		strings.Contains(lower, "401 unauthorized") || strings.Contains(lower, "status 401") {
		return true
	}
	for _, token := range []string{
		"unauthorized", "invalid_api_key", "invalid auth", "invalid bearer token",
		"access token could not be refreshed", "authentication failed", "expired token",
	} {
		if strings.Contains(lower, token) {
			return true
		}
	}
	return false
}

func usageLimitMessage(source, lower string) string {
	if at := parseResetAt(source); !at.IsZero() {
		return "Runner paused: usage limit reached; reset at " + at.UTC().Format(time.RFC3339)
	}
	if seconds := parseResetSeconds(source); seconds > 0 {
		return "Runner paused: usage limit reached; retry after " + strconv.Itoa(seconds) + "s"
	}
	if strings.Contains(lower, "rate_limit_exceeded") {
		return "Runner paused: rate limit exceeded"
	}
	if strings.Contains(lower, "insufficient_quota") {
		return "Runner paused: insufficient quota"
	}
	return "Runner paused: usage limit reached"
}

func usageLimitNextCheck(source string) time.Time {
	if at := parseResetAt(source); !at.IsZero() {
		return at.Add(time.Minute)
	}
	if seconds := parseResetSeconds(source); seconds > 0 {
		return time.Now().UTC().Add(time.Duration(seconds) * time.Second)
	}
	return time.Time{}
}

func parseResetAt(source string) time.Time {
	value, ok := jsonNumberField(source, "resets_at")
	if !ok || value <= 0 {
		return time.Time{}
	}
	return time.Unix(value, 0).UTC()
}

func parseResetSeconds(source string) int {
	value, ok := jsonNumberField(source, "resets_in_seconds")
	if !ok || value <= 0 {
		return 0
	}
	return int(value)
}

func jsonNumberField(source, field string) (int64, bool) {
	re := regexp.MustCompile(`"` + regexp.QuoteMeta(field) + `"\s*:\s*([0-9]+)`)
	matches := re.FindStringSubmatch(source)
	if len(matches) != 2 {
		return 0, false
	}
	value, err := strconv.ParseInt(matches[1], 10, 64)
	return value, err == nil
}

func extractJSONErrorType(source string) string {
	start := strings.Index(source, "{")
	if start < 0 {
		return ""
	}
	var payload struct {
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(source[start:]), &payload); err != nil {
		return ""
	}
	return strings.ToLower(payload.Error.Type)
}
