package usage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"time"
)

var turnContextMarker = []byte(`"type":"turn_context"`)

type SessionMetadata struct {
	Model      string         `json:"model,omitempty"`
	TokenUsage *UsageSnapshot `json:"token_usage,omitempty"`
}

func ReadSessionMetadata(ctx context.Context, path string) (SessionMetadata, error) {
	if path == "" {
		return SessionMetadata{}, nil
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return SessionMetadata{}, nil
	}
	if err != nil {
		return SessionMetadata{}, err
	}
	defer file.Close()
	return scanSessionMetadata(ctx, file)
}

func scanSessionMetadata(ctx context.Context, reader io.Reader) (SessionMetadata, error) {
	bufReader := bufio.NewReaderSize(reader, 256*1024)
	meta := SessionMetadata{}
	var latestUsage time.Time
	var candidate []byte
	for {
		select {
		case <-ctx.Done():
			return meta, ctx.Err()
		default:
		}
		chunk, readErr := bufReader.ReadSlice('\n')
		candidate = appendSessionCandidate(candidate, chunk)
		if isCompleteLine(readErr) {
			handleSessionMetadataLine(&meta, &latestUsage, candidate)
			candidate = nil
		}
		if readErr == nil || readErr == bufio.ErrBufferFull {
			continue
		}
		if readErr == io.EOF {
			return meta, nil
		}
		return meta, readErr
	}
}

func appendSessionCandidate(candidate, chunk []byte) []byte {
	if len(candidate) == 0 && !isSessionMetadataCandidate(chunk) {
		return nil
	}
	return append(candidate, chunk...)
}

func isSessionMetadataCandidate(line []byte) bool {
	return isTokenCountCandidate(line) || bytes.Contains(line, turnContextMarker)
}

func handleSessionMetadataLine(meta *SessionMetadata, latestUsage *time.Time, line []byte) {
	if len(line) == 0 {
		return
	}
	if model, ok := parseTurnContextModel(line); ok {
		meta.Model = model
	}
	if event, ok := parseTokenEvent(line); ok && event.Payload.Info != nil {
		captureSessionUsage(meta, latestUsage, event)
	}
}

func captureSessionUsage(meta *SessionMetadata, latestUsage *time.Time, event tokenEvent) {
	ts := event.timestamp()
	if !latestUsage.IsZero() && !ts.After(*latestUsage) {
		return
	}
	*latestUsage = ts
	meta.TokenUsage = &UsageSnapshot{
		CapturedAt:         ts.UTC().Format(time.RFC3339),
		TotalTokenUsage:    event.Payload.Info.TotalTokenUsage,
		LastTokenUsage:     event.Payload.Info.LastTokenUsage,
		ModelContextWindow: event.Payload.Info.ModelContextWindow,
	}
}

func parseTurnContextModel(line []byte) (string, bool) {
	if !bytes.Contains(line, turnContextMarker) {
		return "", false
	}
	var event turnContextEvent
	if err := json.Unmarshal(line, &event); err != nil || event.Type != "turn_context" {
		return "", false
	}
	if event.Payload.Model != "" {
		return event.Payload.Model, true
	}
	return event.Payload.CollaborationMode.Settings.Model, event.Payload.CollaborationMode.Settings.Model != ""
}

type turnContextEvent struct {
	Type    string `json:"type"`
	Payload struct {
		Model             string `json:"model"`
		CollaborationMode struct {
			Settings struct {
				Model string `json:"model"`
			} `json:"settings"`
		} `json:"collaboration_mode"`
	} `json:"payload"`
}
