package runner

import (
	"context"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
)

type fakeCodex struct {
	events           chan agent.Event
	setName          string
	threadInputs     []agent.ThreadInput
	turnInputs       []agent.UserInput
	turnOptions      []agent.TurnOptions
	resumeSession    agent.Session
	pendingApprovals []agent.PendingApproval
	manualEvents     bool
	autoTurns        int
	startErr         error
	threadErr        error
	resumeErr        error
	turnErr          error
	interrupts       chan [2]string
	resumeCalls      int
}

func (f *fakeCodex) Name() string                { return "codex" }
func (f *fakeCodex) Start(context.Context) error { return f.startErr }
func (f *fakeCodex) Stop(context.Context) error  { return nil }
func (f *fakeCodex) StartThread(_ context.Context, input agent.ThreadInput) (string, error) {
	f.threadInputs = append(f.threadInputs, input)
	if f.threadErr != nil {
		return "", f.threadErr
	}
	return "thread-1", nil
}
func (f *fakeCodex) ListModels(context.Context, agent.ModelListInput) (agent.ModelListResult, error) {
	return agent.ModelListResult{}, nil
}
func (f *fakeCodex) ListThreads(context.Context, agent.SessionListInput) (agent.SessionListResult, error) {
	return agent.SessionListResult{Data: []agent.Session{{ID: "thread-1", CWD: "/tmp/demo"}}}, nil
}
func (f *fakeCodex) ReadThread(context.Context, string) (agent.Session, error) {
	return agent.Session{}, nil
}
func (f *fakeCodex) ResumeThread(context.Context, string) (agent.Session, error) {
	f.resumeCalls++
	if f.resumeErr != nil {
		return agent.Session{}, f.resumeErr
	}
	if f.resumeSession.ID != "" {
		return f.resumeSession, nil
	}
	return agent.Session{ID: "thread-1", CWD: "/tmp/demo"}, nil
}
func (f *fakeCodex) SetThreadName(_ context.Context, _ string, name string) error {
	f.setName = name
	return nil
}
func (f *fakeCodex) StartTurn(_ context.Context, _ string, input []agent.UserInput, options agent.TurnOptions) (string, error) {
	f.turnInputs = input
	f.turnOptions = append(f.turnOptions, options)
	if f.turnErr != nil {
		return "", f.turnErr
	}
	shouldAutoComplete := !f.manualEvents || f.autoTurns > 0
	if f.autoTurns > 0 {
		f.autoTurns--
	}
	if shouldAutoComplete {
		go func() {
			f.events <- agent.Event{Method: "item/agentMessage/delta", ThreadID: "thread-1", TurnID: "turn-1", Text: "working"}
			f.events <- agent.Event{
				Type:     "agent.turn.completed",
				Method:   "turn/completed",
				ThreadID: "thread-1",
				TurnID:   "turn-1",
				Status:   "completed",
			}
		}()
	}
	return "turn-1", nil
}
func (f *fakeCodex) InterruptTurn(_ context.Context, threadID, turnID string) error {
	if f.interrupts != nil {
		f.interrupts <- [2]string{threadID, turnID}
	}
	return nil
}
func (f *fakeCodex) ResolveApproval(context.Context, string, agent.ApprovalDecision) error {
	return nil
}
func (f *fakeCodex) PendingApprovals(context.Context) ([]agent.PendingApproval, error) {
	return f.pendingApprovals, nil
}

func (f *fakeCodex) Events() <-chan agent.Event {
	if f.events == nil {
		f.events = make(chan agent.Event)
	}
	return f.events
}
