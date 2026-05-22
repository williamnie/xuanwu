package codex

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type localConfigDefaults struct {
	Model           string
	ReasoningEffort string
}

var codexConfigLinePattern = regexp.MustCompile(`^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"#\s]+)"?`)

func applyConfiguredModelDefaults(result *ModelListResult) {
	defaults := readLocalConfigDefaults(defaultCodexConfigPath())
	if defaults.ReasoningEffort == "" {
		return
	}
	for i := range result.Data {
		model := &result.Data[i]
		if defaults.Model != "" {
			model.IsDefault = model.ID == defaults.Model || model.Model == defaults.Model
		}
		if supportsReasoningEffort(*model, defaults.ReasoningEffort) {
			model.DefaultReasoningEffort = defaults.ReasoningEffort
		}
	}
}

func readLocalConfigDefaults(path string) localConfigDefaults {
	content, err := os.ReadFile(path)
	if err != nil {
		return localConfigDefaults{}
	}
	var defaults localConfigDefaults
	for _, line := range strings.Split(string(content), "\n") {
		key, value, ok := parseConfigLine(line)
		if !ok {
			continue
		}
		switch key {
		case "model":
			defaults.Model = value
		case "model_reasoning_effort":
			defaults.ReasoningEffort = value
		}
	}
	return defaults
}

func parseConfigLine(line string) (string, string, bool) {
	matches := codexConfigLinePattern.FindStringSubmatch(line)
	if len(matches) != 3 {
		return "", "", false
	}
	return matches[1], strings.Trim(matches[2], `"`), true
}

func defaultCodexConfigPath() string {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return filepath.Join(home, "config.toml")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".codex", "config.toml")
}

func supportsReasoningEffort(model Model, value string) bool {
	if value == "" || len(model.SupportedReasoningEfforts) == 0 {
		return value != ""
	}
	for _, effort := range model.SupportedReasoningEfforts {
		if effort.ReasoningEffort == value {
			return true
		}
	}
	return false
}
