package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAdapterStartPassesEnvironmentOverrides(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "capture-env.sh")
	capture := filepath.Join(dir, "env.txt")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nenv > \"$1\"\n"), 0o700); err != nil {
		t.Fatalf("write script: %v", err)
	}

	adapter := NewAdapter(script, []string{capture})
	adapter.SetEnv([]string{
		"CODEX_RUNNER_ADDR=127.0.0.1:3008",
		"CODEX_RUNNER_AUTH_TOKEN_FILE=/tmp/runner-token",
	})
	if err := adapter.startLocked(context.Background()); err != nil {
		t.Fatalf("start adapter: %v", err)
	}
	_ = adapter.cmd.Wait()

	got := waitForEnvCapture(t, capture)
	for _, want := range []string{
		"CODEX_RUNNER_ADDR=127.0.0.1:3008",
		"CODEX_RUNNER_AUTH_TOKEN_FILE=/tmp/runner-token",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("captured env missing %q:\n%s", want, got)
		}
	}
}

func waitForEnvCapture(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if body, err := os.ReadFile(path); err == nil {
			return string(body)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("env capture not written: %s", path)
	return ""
}
