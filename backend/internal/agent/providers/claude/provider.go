package claude

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
)

const defaultCommand = "claude"

type Config struct {
	Command string
	Env     []string
}

type ProbeResult struct {
	Available bool       `json:"available"`
	Path      string     `json:"path,omitempty"`
	Version   string     `json:"version,omitempty"`
	Auth      AuthStatus `json:"auth"`
	Error     string     `json:"error,omitempty"`
}

type AuthStatus struct {
	Configured bool   `json:"configured"`
	Method     string `json:"method,omitempty"`
	Status     string `json:"status"`
}

type Provider struct {
	command string
	env     []string
}

func New(cfg Config) *Provider {
	command := strings.TrimSpace(cfg.Command)
	if command == "" {
		command = defaultCommand
	}
	return &Provider{command: command, env: cleanEnv(cfg.Env)}
}

func (p *Provider) Name() string { return agent.ProviderClaudeCode }

func (p *Provider) Start(context.Context) error { return nil }

func (p *Provider) Capabilities() agent.Capabilities {
	return agent.CapabilitiesForProviderID(agent.ProviderClaudeCode)
}

func (p *Provider) Probe(ctx context.Context) (ProbeResult, error) {
	probe := ProbeResult{Auth: authStatus(p.env)}
	path, err := lookPath(p.command, p.env)
	if err != nil {
		probe.Error = err.Error()
		return probe, nil
	}
	probe.Available = true
	probe.Path = path
	probe.Version = commandVersion(ctx, path, p.env)
	return probe, nil
}

func (p *Provider) RunIssue(ctx context.Context, input agent.IssueRunInput) (agent.IssueRunResult, error) {
	if strings.TrimSpace(input.CWD) == "" {
		return agent.IssueRunResult{}, errors.New("Claude Code issue run blocked: cwd is required")
	}
	if stat, err := os.Stat(input.CWD); err != nil || !stat.IsDir() {
		return agent.IssueRunResult{}, fmt.Errorf("Claude Code issue run blocked: cwd unavailable: %s", input.CWD)
	}
	probe, err := p.Probe(ctx)
	if err != nil {
		return agent.IssueRunResult{}, err
	}
	if !probe.Available {
		return agent.IssueRunResult{}, fmt.Errorf("Claude Code CLI unavailable: %s", probe.Error)
	}
	return p.runCommand(ctx, input, probe.Path)
}

func (p *Provider) runCommand(ctx context.Context, input agent.IssueRunInput, path string) (agent.IssueRunResult, error) {
	runID := providerRunID(input)
	cmd := exec.CommandContext(ctx, path, claudeArgs(input)...)
	cmd.Dir = input.CWD
	cmd.Env = mergeEnv(os.Environ(), p.env)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return agent.IssueRunResult{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return agent.IssueRunResult{}, err
	}
	if err := cmd.Start(); err != nil {
		return agent.IssueRunResult{}, fmt.Errorf("Claude Code startup failed: %w", err)
	}
	return waitCommand(ctx, input, cmd, stdout, stderr, runID, p.env)
}
