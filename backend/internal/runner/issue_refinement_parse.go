package runner

import "strings"

const (
	issueRefinementStart = "<!-- codex-refinement:start -->"
	issueRefinementEnd   = "<!-- codex-refinement:end -->"
)

func ParseIssueRefinementFromDescription(description string) IssueRefinementDraft {
	block := issueRefinementBlock(description)
	if strings.TrimSpace(block) == "" {
		return IssueRefinementDraft{}
	}
	fields := issueRefinementFields(block)
	return issueRefinementDraftFromFields(fields)
}

func issueRefinementBlock(description string) string {
	text := description
	start := strings.Index(text, issueRefinementStart)
	end := strings.Index(text, issueRefinementEnd)
	if start < 0 || end < start {
		return ""
	}
	return text[start+len(issueRefinementStart) : end]
}

func issueRefinementFields(block string) map[string]string {
	labels := map[string]string{
		"problem":                           "problem",
		"context / impacted files":          "context",
		"acceptance criteria":               "acceptanceCriteria",
		"verification plan":                 "verificationPlan",
		"non-goals":                         "nonGoals",
		"risks / questions":                 "risks",
		"recommended profile":               "recommendedProfile",
		"recommended provider":              "recommendedProvider",
		"risk level":                        "riskLevel",
		"reasoning / why this profile fits": "recommendationReasoning",
		"needs human confirmation":          "needsHumanConfirmation",
	}
	fields := map[string]string{}
	current := ""
	for _, line := range strings.Split(block, "\n") {
		heading := issueRefinementHeading(line)
		if heading != "" {
			current = labels[heading]
			continue
		}
		if current != "" {
			fields[current] += line + "\n"
		}
	}
	for key, value := range fields {
		fields[key] = strings.TrimSpace(value)
	}
	return fields
}

func issueRefinementHeading(line string) string {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "### ") {
		return ""
	}
	return normalizeIssueRefinementLabel(strings.TrimSpace(strings.TrimPrefix(trimmed, "### ")))
}

func normalizeIssueRefinementLabel(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}
