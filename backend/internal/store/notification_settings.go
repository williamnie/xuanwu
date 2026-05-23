package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const notificationSettingsKey = "notifications.settings"

func DefaultNotificationSettings() NotificationSettings {
	return NotificationSettings{Events: []string{StatusDone, StatusFailed}}
}

func (s *Store) NotificationSettings(ctx context.Context) (NotificationSettings, error) {
	settings := DefaultNotificationSettings()
	var raw string
	err := s.db.QueryRowContext(ctx, `select value from app_preferences where key=?`, notificationSettingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	if err := json.Unmarshal([]byte(raw), &settings); err != nil {
		return settings, err
	}
	return normalizeNotificationSettings(settings)
}

func (s *Store) SaveNotificationSettings(
	ctx context.Context,
	settings NotificationSettings,
) (NotificationSettings, error) {
	normalized, err := normalizeNotificationSettings(settings)
	if err != nil {
		return NotificationSettings{}, err
	}
	body, err := json.Marshal(normalized)
	if err != nil {
		return NotificationSettings{}, err
	}
	_, err = s.db.ExecContext(ctx, `insert into app_preferences (key, value, updated_at)
		values (?, ?, ?)
		on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at`,
		notificationSettingsKey, string(body), now())
	if err != nil {
		return NotificationSettings{}, err
	}
	return normalized, nil
}

func normalizeNotificationSettings(settings NotificationSettings) (NotificationSettings, error) {
	settings.WebhookURL = strings.TrimSpace(settings.WebhookURL)
	settings.ActiveStart = strings.TrimSpace(settings.ActiveStart)
	settings.ActiveEnd = strings.TrimSpace(settings.ActiveEnd)
	events := normalizeNotificationEvents(settings.Events)
	settings.Events = events
	if err := validateClockPair(settings.ActiveStart, settings.ActiveEnd); err != nil {
		return settings, err
	}
	return settings, nil
}

func normalizeNotificationEvents(events []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, event := range events {
		event = strings.TrimSpace(event)
		if (event == StatusDone || event == StatusFailed) && !seen[event] {
			out = append(out, event)
			seen[event] = true
		}
	}
	return out
}

func validateClockPair(start, end string) error {
	if start == "" && end == "" {
		return nil
	}
	if start == "" || end == "" {
		return fmt.Errorf("active_start 和 active_end 必须同时设置")
	}
	if !validClock(start) || !validClock(end) {
		return fmt.Errorf("通知时间段必须使用 HH:MM 格式")
	}
	return nil
}

func validClock(value string) bool {
	if len(value) != len("15:04") {
		return false
	}
	_, err := time.Parse("15:04", value)
	return err == nil
}
