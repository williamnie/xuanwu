package main

import (
	"strings"
	"testing"

	"github.com/xiaobei/codex-issue-runner/backend/internal/config"
)

func TestCommandModeKeepsDefaultServeCompatibility(t *testing.T) {
	serve, args := commandMode([]string{"--addr", "127.0.0.1:3999"})
	if !serve || len(args) != 2 || args[0] != "--addr" {
		t.Fatalf("expected default serve mode, serve=%v args=%v", serve, args)
	}
}

func TestCommandModeAcceptsExplicitServe(t *testing.T) {
	serve, args := commandMode([]string{"serve", "--db", "/tmp/app.db"})
	if !serve || len(args) != 2 || args[0] != "--db" {
		t.Fatalf("expected explicit serve mode, serve=%v args=%v", serve, args)
	}
}

func TestCommandModeRoutesIssueToCLI(t *testing.T) {
	serve, args := commandMode([]string{"issue", "create"})
	if serve || len(args) != 2 || args[0] != "issue" {
		t.Fatalf("expected cli mode, serve=%v args=%v", serve, args)
	}
}

func TestCommandModeRoutesSystemStatusToCLI(t *testing.T) {
	serve, args := commandMode([]string{"system", "status"})
	if serve || len(args) != 2 || args[0] != "system" {
		t.Fatalf("expected cli mode, serve=%v args=%v", serve, args)
	}
}

func TestCommandModeRoutesDaemonToCLI(t *testing.T) {
	serve, args := commandMode([]string{"daemon", "status"})
	if serve || len(args) != 2 || args[0] != "daemon" {
		t.Fatalf("expected cli mode, serve=%v args=%v", serve, args)
	}
}

func TestRunnerCallbackEnvUsesLoopbackAddrAndTokenFile(t *testing.T) {
	env := runnerCallbackEnv(config.Config{
		Addr:          "0.0.0.0:3008",
		AuthTokenFile: "/tmp/runner-token",
	}, "secret-token")

	assertEnvContains(t, env, "CODEX_RUNNER_ADDR=127.0.0.1:3008")
	assertEnvContains(t, env, "CODEX_RUNNER_AUTH_TOKEN_FILE=/tmp/runner-token")
	assertEnvMissing(t, env, "CODEX_RUNNER_AUTH_TOKEN=")
}

func TestRunnerCallbackEnvUsesDirectTokenWhenConfigured(t *testing.T) {
	env := runnerCallbackEnv(config.Config{
		Addr:          ":3008",
		AuthToken:     "direct-token",
		AuthTokenFile: "/tmp/runner-token",
	}, "direct-token")

	assertEnvContains(t, env, "CODEX_RUNNER_ADDR=127.0.0.1:3008")
	assertEnvContains(t, env, "CODEX_RUNNER_AUTH_TOKEN=direct-token")
}

func assertEnvContains(t *testing.T, env []string, want string) {
	t.Helper()
	for _, item := range env {
		if item == want {
			return
		}
	}
	t.Fatalf("env missing %q in %v", want, env)
}

func assertEnvMissing(t *testing.T, env []string, prefix string) {
	t.Helper()
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			t.Fatalf("env should not contain %q entry: %v", prefix, env)
		}
	}
}
