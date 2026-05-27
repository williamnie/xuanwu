package runner

import (
	"encoding/json"
	"strings"

	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

const verificationGatePrompt = `
Verification gate v1:
- This issue is configured for human/verifier review after implementation.
- After you finish the directly relevant verification, submit verification evidence by updating the issue to pending_verification instead of done:
  codex-issue-runner issue update --id {{issue.id}} --status pending_verification --error "<verification evidence summary>" --json
- Use failed only when verification fails, requirements cannot be completed, or you are blocked.
- Do not mark this issue done yourself; a human or verifier will Accept it from pending_verification.
`

type verificationGateConfig struct {
	VerificationGate     bool `json:"verification_gate"`
	VerificationRequired bool `json:"verification_required"`
}

func VerificationGateEnabled(project store.Project) bool {
	return projectConfigVerificationGate(project.ProviderConfig) ||
		profileVerificationGate(project.DefaultAgentProfile)
}

func projectConfigVerificationGate(raw string) bool {
	var cfg verificationGateConfig
	if json.Unmarshal([]byte(strings.TrimSpace(raw)), &cfg) != nil {
		return false
	}
	return cfg.VerificationGate || cfg.VerificationRequired
}

func profileVerificationGate(profile *store.AgentProfile) bool {
	if profile == nil {
		return false
	}
	return strings.Contains(strings.ToLower(profile.DefaultInstructions), "verification_gate")
}

func appendVerificationGatePrompt(prompt string, issue store.Issue, enabled bool) string {
	if !enabled {
		return prompt
	}
	gate := renderIssuePromptTemplate(verificationGatePrompt, store.Project{}, issue)
	return strings.TrimRight(prompt, "\n") + "\n" + gate
}
