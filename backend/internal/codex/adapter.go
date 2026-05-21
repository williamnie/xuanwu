package codex

import (
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"sync"
	"time"
)

type Adapter struct {
	command string
	args    []string

	mu      sync.Mutex
	started bool
	nextID  int64
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	pending map[int64]chan rpcResponse
	events  chan Event
}

type rpcResponse struct {
	Result json.RawMessage
	Err    error
}

func NewAdapter(command string, args []string) *Adapter {
	return &Adapter{command: command, args: args, pending: map[int64]chan rpcResponse{}, events: make(chan Event, 256)}
}

func (a *Adapter) Start(ctx context.Context) error {
	a.mu.Lock()
	if a.started {
		a.mu.Unlock()
		return nil
	}
	if err := a.startLocked(ctx); err != nil {
		a.mu.Unlock()
		return err
	}
	a.started = true
	a.mu.Unlock()
	_, err := a.request(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "codex-issue-runner", "version": "0.1.0"},
		"capabilities": map[string]any{"experimentalApi": true},
	})
	return err
}

func (a *Adapter) Stop(ctx context.Context) error {
	a.mu.Lock()
	cmd := a.cmd
	a.started = false
	a.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	_ = cmd.Process.Signal(execErrSignal())
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		return ctx.Err()
	case <-done:
		return nil
	case <-time.After(2 * time.Second):
		_ = cmd.Process.Kill()
		return nil
	}
}

func (a *Adapter) ThreadStart(ctx context.Context, input ThreadInput) (string, error) {
	params := threadStartParams(input)
	result, err := a.request(ctx, "thread/start", params)
	if err != nil {
		return "", err
	}
	return nestedString(result, "thread", "id")
}

func (a *Adapter) TurnStart(ctx context.Context, threadID, prompt string) (string, error) {
	params := map[string]any{"threadId": threadID, "input": []any{textInput(prompt)}}
	result, err := a.request(ctx, "turn/start", params)
	if err != nil {
		return "", err
	}
	return nestedString(result, "turn", "id")
}

func (a *Adapter) InterruptTurn(ctx context.Context, threadID, turnID string) error {
	_, err := a.request(ctx, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID})
	return err
}

func (a *Adapter) Events() <-chan Event {
	return a.events
}

func (a *Adapter) startLocked(ctx context.Context) error {
	a.cmd = exec.CommandContext(ctx, a.command, a.args...)
	stdout, err := a.cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := a.cmd.StderrPipe()
	if err != nil {
		return err
	}
	a.stdin, err = a.cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := a.cmd.Start(); err != nil {
		return err
	}
	go a.readLoop(stdout)
	go a.stderrLoop(stderr)
	return nil
}

func (a *Adapter) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id, ch := a.registerRequest()
	if err := a.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		a.unregister(id)
		return nil, err
	}
	select {
	case <-ctx.Done():
		a.unregister(id)
		return nil, ctx.Err()
	case res := <-ch:
		return res.Result, res.Err
	}
}
