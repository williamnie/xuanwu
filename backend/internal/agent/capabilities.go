package agent

import (
	"context"
	"errors"
)

var ErrCapabilityUnsupported = errors.New("agent capability unsupported")

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
