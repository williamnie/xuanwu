package agent

import "testing"

func TestRegisteredProviderCapabilities(t *testing.T) {
	fake := CapabilitiesForProviderID(ProviderFakeExecutionOnly)
	if !fake.Supports(CapabilityIssueExecution) {
		t.Fatalf("fake execution-only provider must support issue execution: %+v", fake)
	}
	if fake.Supports(CapabilitySessions) || fake.Supports(CapabilityResumeSession) {
		t.Fatalf("fake execution-only provider must not pretend session support: %+v", fake)
	}

	codex := CapabilitiesForProviderID(ProviderCodex)
	for _, capability := range []Capability{
		CapabilityIssueExecution,
		CapabilitySessions,
		CapabilityResumeSession,
		CapabilityInterrupt,
		CapabilityApprovals,
		CapabilityModelList,
	} {
		if !codex.Supports(capability) {
			t.Fatalf("codex capability %q = false: %+v", capability, codex)
		}
	}
}
