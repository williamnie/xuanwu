package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDaemonStatusFailsOnUnsupportedPlatform(t *testing.T) {
	original := daemonGOOS
	daemonGOOS = "linux"
	t.Cleanup(func() { daemonGOOS = original })

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"daemon", "status", "--json"}, &stdout, &stderr, Options{})
	if code == 0 {
		t.Fatalf("expected non-zero exit, stdout=%s", stdout.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	if output["loaded"] != false || output["running"] != false {
		t.Fatalf("unexpected output: %+v", output)
	}
	if !strings.Contains(stderr.String(), "unsupported platform linux") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

func TestDaemonStatusJSONIncludesLaunchdAndHTTPFields(t *testing.T) {
	requireDarwin(t)
	fakeLoadedLaunchctl(t, "12345", tempLogPaths(t)...)
	server := daemonStatusServer(t, "0.2.0", "stamp-1")
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"daemon", "status", "--addr", server.URL, "--json",
	}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	assertDaemonStatusJSON(t, output, "0.2.0", "stamp-1")
}

func TestDaemonStatusFailsWhenLaunchctlMissing(t *testing.T) {
	requireDarwin(t)
	t.Setenv("PATH", t.TempDir())
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"daemon", "status", "--json"}, &stdout, &stderr, Options{})
	if code == 0 {
		t.Fatalf("expected non-zero exit, stdout=%s", stdout.String())
	}
	if !strings.Contains(stderr.String(), "launchctl not found") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

func TestDaemonStatusFailsWhenLaunchdServiceIsNotLoaded(t *testing.T) {
	requireDarwin(t)
	fakeLaunchctl(t, `
if [ "$1" = "print" ]; then
  exit 113
fi
exit 64
`)
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"daemon", "status", "--json"}, &stdout, &stderr, Options{})
	if code == 0 {
		t.Fatalf("expected non-zero exit, stdout=%s", stdout.String())
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	if output["loaded"] != false || output["label"] != "com.xiaobei.codex-issue-runner" {
		t.Fatalf("unexpected output: %+v", output)
	}
	if !strings.Contains(stderr.String(), "launchd service is not loaded") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

func TestDaemonLogsRedactsSensitiveLines(t *testing.T) {
	requireDarwin(t)
	dir := t.TempDir()
	stdoutLog := filepath.Join(dir, "launchd.out.log")
	stderrLog := filepath.Join(dir, "launchd.err.log")
	if err := os.WriteFile(stdoutLog, []byte("safe line\nCODEX_RUNNER_AUTH_TOKEN=secret-token\n"), 0o600); err != nil {
		t.Fatalf("write stdout log: %v", err)
	}
	if err := os.WriteFile(stderrLog, []byte("Authorization: Bearer secret-token\nanother safe line\n"), 0o600); err != nil {
		t.Fatalf("write stderr log: %v", err)
	}
	fakeLaunchctl(t, fmt.Sprintf(`
if [ "$1" = "print" ]; then
  printf 'state = running\n'
  printf 'pid = 12345\n'
  printf 'stdout path = %s\n'
  printf 'stderr path = %s\n'
  exit 0
fi
exit 64
`, stdoutLog, stderrLog))

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"daemon", "logs", "--lines", "20"}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	got := stdout.String() + stderr.String()
	for _, forbidden := range []string{"secret-token", "Authorization:", "CODEX_RUNNER_AUTH_TOKEN"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("sensitive value leaked in output: %q", got)
		}
	}
	if !strings.Contains(got, "safe line") || !strings.Contains(got, "another safe line") {
		t.Fatalf("safe log lines missing: %q", got)
	}
}

func TestDaemonRestartKickstartsAndVerifiesHTTP(t *testing.T) {
	requireDarwin(t)
	dir := t.TempDir()
	calls := filepath.Join(dir, "calls")
	hits := 0
	fakeRestartLaunchctl(t, calls)
	server := daemonStatusServerWithHits(t, "0.2.1", "stamp-2", &hits)
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"daemon", "restart", "--addr", server.URL, "--json",
	}, &stdout, &stderr, Options{})
	if code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	if hits == 0 {
		t.Fatal("restart did not verify /api/system/status")
	}
	rawCalls, err := os.ReadFile(calls)
	if err != nil {
		t.Fatalf("read calls: %v", err)
	}
	if !strings.Contains(string(rawCalls), "kickstart -k gui/") ||
		!strings.Contains(string(rawCalls), "com.xiaobei.codex-issue-runner") {
		t.Fatalf("kickstart not called safely: %q", string(rawCalls))
	}
	var output map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %q err=%v", stdout.String(), err)
	}
	if output["http_ok"] != true || output["db_ok"] != true {
		t.Fatalf("restart status missing HTTP verification: %+v", output)
	}
}

func tempLogPaths(t *testing.T) []string {
	t.Helper()
	dir := t.TempDir()
	return []string{
		filepath.Join(dir, "launchd.out.log"),
		filepath.Join(dir, "launchd.err.log"),
	}
}

func fakeLoadedLaunchctl(t *testing.T, pid string, logPaths ...string) {
	t.Helper()
	fakeLaunchctl(t, fmt.Sprintf(`
if [ "$1" = "print" ]; then
  printf 'state = running\n'
  printf 'pid = %s\n'
  printf 'stdout path = %s\n'
  printf 'stderr path = %s\n'
  exit 0
fi
exit 64
`, pid, logPaths[0], logPaths[1]))
}

func daemonStatusServer(t *testing.T, version, stamp string) *httptest.Server {
	t.Helper()
	hits := 0
	return daemonStatusServerWithHits(t, version, stamp, &hits)
}

func daemonStatusServerWithHits(
	t *testing.T, version, stamp string, hits *int,
) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/system/status" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		*hits++
		writeTestJSON(w, http.StatusOK, daemonStatusPayload(version, stamp))
	}))
}

func daemonStatusPayload(version, stamp string) map[string]any {
	return map[string]any{
		"service": map[string]any{
			"alive": true, "version": version,
			"build": map[string]any{"stamp": stamp},
		},
		"config": map[string]any{"addr": "0.0.0.0:3008"},
		"db":     map[string]any{"ok": true},
	}
}

func assertDaemonStatusJSON(t *testing.T, output map[string]any, version, stamp string) {
	t.Helper()
	if output["loaded"] != true || output["running"] != true || output["pid"] != float64(12345) {
		t.Fatalf("launchd fields missing: %+v", output)
	}
	if output["label"] != "com.xiaobei.codex-issue-runner" ||
		output["listen_addr"] != "0.0.0.0:3008" ||
		output["version"] != version ||
		output["build_stamp"] != stamp ||
		output["http_ok"] != true ||
		output["db_ok"] != true {
		t.Fatalf("status fields missing: %+v", output)
	}
	paths, ok := output["log_paths"].([]any)
	if !ok || len(paths) != 2 {
		t.Fatalf("log_paths missing: %+v", output["log_paths"])
	}
}

func fakeRestartLaunchctl(t *testing.T, calls string) {
	t.Helper()
	fakeLaunchctl(t, fmt.Sprintf(`
printf '%%s\n' "$*" >> %s
if [ "$1" = "print" ]; then
  printf 'state = running\n'
  printf 'pid = 12345\n'
  exit 0
fi
if [ "$1" = "kickstart" ]; then
  exit 0
fi
exit 64
`, calls))
}

func requireDarwin(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("macOS launchd-specific test")
	}
}

func fakeLaunchctl(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "launchctl")
	script := "#!/bin/sh\nset -eu\n" + body
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake launchctl: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}
