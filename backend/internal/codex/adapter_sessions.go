package codex

import (
	"context"
	"encoding/json"
)

func (a *Adapter) ThreadList(ctx context.Context, input SessionListInput) (SessionListResult, error) {
	result, err := a.request(ctx, "thread/list", threadListParams(input))
	if err != nil {
		return SessionListResult{}, err
	}
	var out SessionListResult
	if err := json.Unmarshal(result, &out); err != nil {
		return SessionListResult{}, err
	}
	return out, nil
}

func (a *Adapter) ThreadRead(ctx context.Context, threadID string) (Session, error) {
	result, err := a.request(ctx, "thread/read", map[string]any{"threadId": threadID})
	if err != nil {
		return Session{}, err
	}
	return decodeThreadResult(result)
}

func (a *Adapter) ThreadResume(ctx context.Context, threadID string) (Session, error) {
	result, err := a.request(ctx, "thread/resume", map[string]any{"threadId": threadID})
	if err != nil {
		return Session{}, err
	}
	return decodeThreadResult(result)
}

func (a *Adapter) ThreadSetName(ctx context.Context, threadID, name string) error {
	_, err := a.request(ctx, "thread/name/set", map[string]any{"threadId": threadID, "name": name})
	return err
}

func threadListParams(input SessionListInput) map[string]any {
	params := map[string]any{}
	if input.Limit > 0 {
		params["limit"] = input.Limit
	}
	if input.Cursor != "" {
		params["cursor"] = input.Cursor
	}
	return params
}

func decodeThreadResult(raw json.RawMessage) (Session, error) {
	var wrapper struct {
		Thread Session `json:"thread"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return Session{}, err
	}
	return wrapper.Thread, nil
}
