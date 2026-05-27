package codex

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type Adapter struct {
	command string
	args    []string
	env     []string

	mu               sync.Mutex
	started          bool
	nextID           int64
	nextApprovalID   int64
	cmd              *exec.Cmd
	stdin            io.WriteCloser
	pending          map[int64]chan rpcResponse
	pendingApprovals map[string]chan ApprovalDecision
	approvalRecords  map[string]approvalRecord
	events           chan Event
}

type rpcResponse struct {
	Result json.RawMessage
	Err    error
}

type approvalRecord struct {
	seq      int64
	approval PendingApproval
}

func NewAdapter(command string, args []string) *Adapter {
	return &Adapter{
		command: command, args: args, pending: map[int64]chan rpcResponse{},
		pendingApprovals: map[string]chan ApprovalDecision{}, approvalRecords: map[string]approvalRecord{},
		events: make(chan Event, 256),
	}
}

func (a *Adapter) SetEnv(env []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.env = append([]string(nil), env...)
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

func (a *Adapter) ModelList(ctx context.Context, input ModelListInput) (ModelListResult, error) {
	result, err := a.request(ctx, "model/list", modelListParams(input))
	if err != nil {
		return ModelListResult{}, err
	}
	var out ModelListResult
	if err := json.Unmarshal(result, &out); err != nil {
		return ModelListResult{}, err
	}
	applyConfiguredModelDefaults(&out)
	return out, nil
}

func (a *Adapter) TurnStart(ctx context.Context, threadID string, input []UserInput, options TurnOptions) (string, error) {
	params := turnStartParams(threadID, input, options)
	result, err := a.request(ctx, "turn/start", params)
	if err != nil {
		return "", err
	}
	return nestedString(result, "turn", "id")
}

func (a *Adapter) TurnSteer(ctx context.Context, threadID, turnID string, input []UserInput) (string, error) {
	params := turnSteerParams(threadID, turnID, input)
	result, err := a.request(ctx, "turn/steer", params)
	if err != nil {
		return "", err
	}
	return nestedString(result, "turnId")
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
	if len(a.env) > 0 {
		a.cmd.Env = mergeEnv(os.Environ(), a.env)
	}
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

func mergeEnv(base, overrides []string) []string {
	merged := append([]string(nil), base...)
	index := map[string]int{}
	for i, item := range merged {
		index[envKey(item)] = i
	}
	for _, item := range overrides {
		key := envKey(item)
		if key == "" {
			continue
		}
		if i, ok := index[key]; ok {
			merged[i] = item
			continue
		}
		index[key] = len(merged)
		merged = append(merged, item)
	}
	return merged
}

func envKey(item string) string {
	key, _, _ := strings.Cut(item, "=")
	return key
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
