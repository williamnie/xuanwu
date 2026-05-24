package agent

import (
	"context"
	"errors"
	"strings"
)

var ErrCapabilityUnsupported = errors.New("agent capability unsupported")

const (
	ProviderCodex             = "codex"
	ProviderFakeExecutionOnly = "fake-execution-only"
)

type Capability string

const (
	CapabilityIssueExecution   Capability = "issue_execution"
	CapabilitySessions         Capability = "sessions"
	CapabilityResumeSession    Capability = "resume_session"
	CapabilityInterrupt        Capability = "interrupt"
	CapabilityApprovals        Capability = "approvals"
	CapabilityModelList        Capability = "model_list"
	CapabilityTranscriptExport Capability = "transcript_export"
)

type Capabilities []Capability

func (c Capabilities) Supports(capability Capability) bool {
	for _, item := range c {
		if item == capability {
			return true
		}
	}
	return false
}

func CapabilitiesForProviderID(provider string) Capabilities {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "", ProviderCodex:
		return CodexCapabilities()
	case ProviderFakeExecutionOnly:
		return Capabilities{CapabilityIssueExecution}
	}
	return nil
}

func CodexCapabilities() Capabilities {
	return Capabilities{
		CapabilityIssueExecution,
		CapabilitySessions,
		CapabilityResumeSession,
		CapabilityInterrupt,
		CapabilityApprovals,
		CapabilityModelList,
	}
}

type CapabilityReporter interface {
	Capabilities() Capabilities
}

type Stopper interface {
	Stop(ctx context.Context) error
}

type ModelLister interface {
	ListModels(ctx context.Context, input ModelListInput) (ModelListResult, error)
}

type ThreadLister interface {
	ListThreads(ctx context.Context, input SessionListInput) (SessionListResult, error)
}

type ThreadReader interface {
	ReadThread(ctx context.Context, threadID string) (Session, error)
}

type ThreadResumer interface {
	ResumeThread(ctx context.Context, threadID string) (Session, error)
}

type ThreadNamer interface {
	SetThreadName(ctx context.Context, threadID string, name string) error
}

type TurnInterrupter interface {
	InterruptTurn(ctx context.Context, threadID string, turnID string) error
}

type ApprovalResolver interface {
	ResolveApproval(
		ctx context.Context,
		requestID string,
		decision ApprovalDecision,
	) error
}
