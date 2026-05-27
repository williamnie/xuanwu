package claude

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func lookPath(command string, env []string) (string, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return "", errors.New("command is empty")
	}
	if strings.ContainsRune(command, filepath.Separator) {
		return command, executableError(command)
	}
	pathEnv := envValue(env, "PATH")
	if pathEnv == "" {
		return exec.LookPath(command)
	}
	return lookPathInEnv(command, pathEnv)
}

func lookPathInEnv(command string, pathEnv string) (string, error) {
	for _, dir := range filepath.SplitList(pathEnv) {
		candidate := filepath.Join(dir, command)
		if err := executableError(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("exec: %q not found in PATH", command)
}

func executableError(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() || info.Mode()&0o111 == 0 {
		return fmt.Errorf("%s is not executable", path)
	}
	return nil
}

func authStatus(env []string) AuthStatus {
	if envValue(env, "ANTHROPIC_API_KEY") != "" || strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")) != "" {
		return AuthStatus{Configured: true, Method: "env:ANTHROPIC_API_KEY", Status: "configured"}
	}
	return AuthStatus{Status: "unknown"}
}

func mergeEnv(base, overrides []string) []string {
	merged := append([]string(nil), base...)
	index := map[string]int{}
	for i, item := range merged {
		index[envKey(item)] = i
	}
	for _, item := range cleanEnv(overrides) {
		merged = upsertEnv(merged, index, item)
	}
	return merged
}

func upsertEnv(env []string, index map[string]int, item string) []string {
	key := envKey(item)
	if key == "" {
		return env
	}
	if pos, ok := index[key]; ok {
		env[pos] = item
		return env
	}
	index[key] = len(env)
	return append(env, item)
}

func cleanEnv(env []string) []string {
	out := []string{}
	for _, item := range env {
		if strings.TrimSpace(item) != "" && strings.Contains(item, "=") {
			out = append(out, item)
		}
	}
	return out
}

func envValue(env []string, key string) string {
	for _, item := range env {
		if envKey(item) == key {
			return strings.TrimPrefix(item, key+"=")
		}
	}
	return ""
}

func envKey(item string) string {
	key, _, ok := strings.Cut(item, "=")
	if !ok {
		return ""
	}
	return key
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func commandVersion(ctx context.Context, path string, env []string) string {
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = mergeEnv(os.Environ(), env)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
