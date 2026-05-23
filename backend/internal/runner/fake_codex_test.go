package runner

import (
	"context"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
)

type fakeCodex struct {
	events        chan codex.Event
	setName       string
	threadInputs  []codex.ThreadInput
	turnInputs    []codex.UserInput
	turnOptions   []codex.TurnOptions
	resumeSession codex.Session
	manualEvents  bool
	autoTurns     int
	startErr      error
	threadErr     error
	resumeErr     error
	turnErr       error
	interrupts    chan [2]string
	resumeCalls   int
}

func (f *fakeCodex) Start(context.Context) error { return f.startErr }
func (f *fakeCodex) Stop(context.Context) error  { return nil }
func (f *fakeCodex) ThreadStart(_ context.Context, input codex.ThreadInput) (string, error) {
	f.threadInputs = append(f.threadInputs, input)
	if f.threadErr != nil {
		return "", f.threadErr
	}
	return "thread-1", nil
}
func (f *fakeCodex) ModelList(context.Context, codex.ModelListInput) (codex.ModelListResult, error) {
	return codex.ModelListResult{}, nil
}
func (f *fakeCodex) ThreadList(context.Context, codex.SessionListInput) (codex.SessionListResult, error) {
	return codex.SessionListResult{Data: []codex.Session{{ID: "thread-1", CWD: "/tmp/demo"}}}, nil
}
func (f *fakeCodex) ThreadRead(context.Context, string) (codex.Session, error) {
	return codex.Session{}, nil
}
func (f *fakeCodex) ThreadResume(context.Context, string) (codex.Session, error) {
	f.resumeCalls++
	if f.resumeErr != nil {
		return codex.Session{}, f.resumeErr
	}
	if f.resumeSession.ID != "" {
		return f.resumeSession, nil
	}
	return codex.Session{ID: "thread-1", CWD: "/tmp/demo"}, nil
}
func (f *fakeCodex) ThreadSetName(_ context.Context, _ string, name string) error {
	f.setName = name
	return nil
}
func (f *fakeCodex) TurnStart(_ context.Context, _ string, input []codex.UserInput, options codex.TurnOptions) (string, error) {
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
			f.events <- codex.Event{Method: "item/agentMessage/delta", ThreadID: "thread-1", TurnID: "turn-1", Text: "working"}
			f.events <- codex.Event{Method: "turn/completed", ThreadID: "thread-1", TurnID: "turn-1", Status: "completed"}
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
func (f *fakeCodex) ResolveApproval(context.Context, string, codex.ApprovalDecision) error {
	return nil
}
func (f *fakeCodex) Events() <-chan codex.Event { return f.events }
