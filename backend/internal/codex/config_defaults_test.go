package codex

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadLocalConfigDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	content := `model = "gpt-5.5" # current model
model_reasoning_effort = "xhigh"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	defaults := readLocalConfigDefaults(path)
	if defaults.Model != "gpt-5.5" || defaults.ReasoningEffort != "xhigh" {
		t.Fatalf("defaults = %+v", defaults)
	}
}

func TestApplyConfiguredModelDefaultsUsesCodexConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(`model = "gpt-5.5"
model_reasoning_effort = "xhigh"`), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	result := ModelListResult{Data: []Model{
		{
			ID:                     "gpt-5.5",
			Model:                  "gpt-5.5",
			IsDefault:              false,
			DefaultReasoningEffort: "medium",
			SupportedReasoningEfforts: []ReasoningEffortOption{
				{ReasoningEffort: "medium"}, {ReasoningEffort: "xhigh"},
			},
		},
		{ID: "gpt-5.4", Model: "gpt-5.4", IsDefault: true, DefaultReasoningEffort: "medium"},
	}}

	applyConfiguredModelDefaults(&result)
	if !result.Data[0].IsDefault || result.Data[0].DefaultReasoningEffort != "xhigh" {
		t.Fatalf("configured model not applied: %+v", result.Data[0])
	}
	if result.Data[1].IsDefault || result.Data[1].DefaultReasoningEffort != "xhigh" {
		t.Fatalf("global reasoning default not applied: %+v", result.Data[1])
	}
}
