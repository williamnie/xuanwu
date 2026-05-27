package config

import (
	"context"
	"os"
	"os/exec"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	agentclaude "github.com/xiaobei/codex-issue-runner/backend/internal/agent/providers/claude"
)

const (
	ProviderStatusAvailable = "available"
	ProviderStatusMissing   = "missing"
	ProviderStatusUnknown   = "unknown"
)

type ProviderSettingsConfig struct {
	CodexCmd    string
	ClaudeCmd   string
	OpencodeCmd string
}

type ProviderStatus struct {
	ID           string                  `json:"id"`
	Label        string                  `json:"label"`
	Status       string                  `json:"status"`
	Available    bool                    `json:"available"`
	Enabled      bool                    `json:"enabled"`
	CLI          ProviderCLIStatus       `json:"cli"`
	Secrets      map[string]SecretStatus `json:"secrets,omitempty"`
	Capabilities []string                `json:"capabilities,omitempty"`
	DefaultModel string                  `json:"default_model,omitempty"`
	Notes        []string                `json:"notes,omitempty"`
	SettingsMode string                  `json:"settings_mode"`
}

type ProviderCLIStatus struct {
	Command   string `json:"command"`
	Available bool   `json:"available"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
	Error     string `json:"error,omitempty"`
}

type SecretStatus struct {
	Configured bool `json:"configured"`
}

func ProviderSettingsFromConfig(cfg Config) ProviderSettingsConfig {
	return ProviderSettingsConfig{
		CodexCmd: cfg.CodexCmd, ClaudeCmd: cfg.ClaudeCmd, OpencodeCmd: cfg.OpencodeCmd,
	}
}

func ProviderStatuses(cfg ProviderSettingsConfig) []ProviderStatus {
	return []ProviderStatus{
		codexProviderStatus(cfg.CodexCmd),
		claudeProviderStatus(cfg.ClaudeCmd),
		opencodeProviderStatus(cfg.OpencodeCmd),
	}
}

func codexProviderStatus(command string) ProviderStatus {
	cli := commandStatus(command)
	return ProviderStatus{
		ID: "codex", Label: "Codex", Status: availability(cli.Available), Available: cli.Available,
		Enabled: true, CLI: cli, Secrets: apiKeyPresence("CODEX_API_KEY", "OPENAI_API_KEY"),
		Capabilities: capabilityStrings(agent.CapabilitiesForProviderID(agent.ProviderCodex)),
		SettingsMode: "env_or_codex_config",
		Notes:        []string{"Codex 仍是默认主 provider，Claude Code 可作为 issue_execution only 后端。"},
	}
}

func claudeProviderStatus(command string) ProviderStatus {
	probe, cli := claudeProbe(command)
	return ProviderStatus{
		ID: "claude", Label: "Claude Code", Status: availability(cli.Available), Available: cli.Available,
		Enabled: true, CLI: cli, Secrets: map[string]SecretStatus{"api_key": {Configured: probe.Auth.Configured}},
		Capabilities: capabilityStrings(agent.CapabilitiesForProviderID(agent.ProviderClaudeCode)),
		SettingsMode: "env_or_provider_login",
		Notes:        []string{"v1 仅支持 issue_execution，不进入 Sessions list/read/resume。"},
	}
}

func opencodeProviderStatus(command string) ProviderStatus {
	cli := commandStatus(command)
	return ProviderStatus{
		ID: "opencode", Label: "opencode", Status: ProviderStatusUnknown, Available: false,
		Enabled: false, CLI: cli, SettingsMode: "env_or_provider_config",
		Notes: []string{"opencode v1 不读取 provider 配置文件或启动 server，" +
			"只展示 CLI 路径；真实可用性保持 unknown。"},
	}
}

func claudeProbe(command string) (agentclaude.ProbeResult, ProviderCLIStatus) {
	provider := agentclaude.New(agentclaude.Config{Command: command})
	probe, _ := provider.Probe(context.Background())
	cli := ProviderCLIStatus{
		Command: strings.TrimSpace(command), Available: probe.Available,
		Path: probe.Path, Version: probe.Version, Error: probe.Error,
	}
	if cli.Command == "" {
		cli.Command = "claude"
	}
	return probe, cli
}

func capabilityStrings(capabilities agent.Capabilities) []string {
	out := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		out = append(out, string(capability))
	}
	return out
}

func commandStatus(command string) ProviderCLIStatus {
	command = strings.TrimSpace(command)
	status := ProviderCLIStatus{Command: command}
	if command == "" {
		status.Error = "command is empty"
		return status
	}
	path, err := exec.LookPath(command)
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Available = true
	status.Path = path
	return status
}

func apiKeyPresence(names ...string) map[string]SecretStatus {
	return map[string]SecretStatus{"api_key": secretPresence(names...)}
}

func secretPresence(names ...string) SecretStatus {
	for _, name := range names {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return SecretStatus{Configured: true}
		}
	}
	return SecretStatus{Configured: false}
}

func availability(ok bool) string {
	if ok {
		return ProviderStatusAvailable
	}
	return ProviderStatusMissing
}
