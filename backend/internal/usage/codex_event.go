package usage

import (
	"bytes"
	"encoding/json"
	"time"
)

type tokenEvent struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type       string      `json:"type"`
		Info       *tokenInfo  `json:"info"`
		RateLimits *RateLimits `json:"rate_limits"`
	} `json:"payload"`
}

type tokenInfo struct {
	TotalTokenUsage    TokenUsage `json:"total_token_usage"`
	LastTokenUsage     TokenUsage `json:"last_token_usage"`
	ModelContextWindow int64      `json:"model_context_window"`
}

type sessionMetaEvent struct {
	Type    string `json:"type"`
	Payload struct {
		ID  string `json:"id"`
		CWD string `json:"cwd"`
	} `json:"payload"`
}

var (
	tokenCountMarker  = []byte(`"type":"token_count"`)
	sessionMetaMarker = []byte(`"type":"session_meta"`)
)

func isUsageCandidate(line []byte) bool {
	return isTokenCountCandidate(line) || bytes.Contains(line, sessionMetaMarker)
}

func isTokenCountCandidate(line []byte) bool {
	return bytes.Contains(line, tokenCountMarker)
}

func parseTokenEvent(line []byte) (tokenEvent, bool) {
	if !isTokenCountCandidate(line) {
		return tokenEvent{}, false
	}
	var event tokenEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return tokenEvent{}, false
	}
	return event, event.Type == "event_msg" && event.Payload.Type == "token_count"
}

func parseSessionMetaEvent(line []byte) (sessionMetaEvent, bool) {
	if !bytes.Contains(line, sessionMetaMarker) {
		return sessionMetaEvent{}, false
	}
	var event sessionMetaEvent
	if err := json.Unmarshal(line, &event); err != nil {
		return sessionMetaEvent{}, false
	}
	return event, event.Type == "session_meta"
}

func (e tokenEvent) timestamp() time.Time {
	ts, err := time.Parse(time.RFC3339Nano, e.Timestamp)
	if err != nil {
		return time.Time{}
	}
	return ts
}
