package runner

import (
	"context"
	"sync"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/codex"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type Runner struct {
	store  *store.Store
	bus    *events.Bus
	codex  codex.Client
	execMu sync.Mutex

	eventOnce    sync.Once
	eventMu      sync.Mutex
	nextEventSub int
	eventSubs    map[int]chan codex.Event

	mu       sync.Mutex
	loops    map[string]chan struct{}
	running  map[int64]*runState
	sessions map[string]*runState
}

type runState struct {
	cancel   context.CancelFunc
	threadID string
	turnID   string
}

func New(st *store.Store, bus *events.Bus, client codex.Client) *Runner {
	return &Runner{
		store: st, bus: bus, codex: client, eventSubs: map[int]chan codex.Event{},
		loops: map[string]chan struct{}{}, running: map[int64]*runState{}, sessions: map[string]*runState{},
	}
}

func (r *Runner) StartProject(projectID string) error {
	if _, err := r.store.GetProject(context.Background(), projectID); err != nil {
		return err
	}
	r.mu.Lock()
	if _, ok := r.loops[projectID]; ok {
		r.mu.Unlock()
		return nil
	}
	stop := make(chan struct{})
	r.loops[projectID] = stop
	r.mu.Unlock()
	go r.loop(projectID, stop)
	r.bus.Publish(events.AppEvent{Type: "runner.started", ProjectID: projectID})
	return nil
}

func (r *Runner) StopProject(projectID string) {
	r.mu.Lock()
	stop := r.loops[projectID]
	delete(r.loops, projectID)
	r.mu.Unlock()
	if stop != nil {
		close(stop)
		r.bus.Publish(events.AppEvent{Type: "runner.stopped", ProjectID: projectID})
	}
}

func (r *Runner) LoopStatus(projectID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.loops[projectID]; ok {
		return "running"
	}
	return "stopped"
}

func (r *Runner) StartAutoProjects(ctx context.Context) error {
	projects, err := r.store.ListProjects(ctx)
	if err != nil {
		return err
	}
	for _, p := range projects {
		if p.AutoRun == 1 {
			_ = r.StartProject(p.ID)
		}
	}
	return nil
}

func (r *Runner) CancelIssue(issueID int64) {
	r.mu.Lock()
	state := r.running[issueID]
	r.mu.Unlock()
	if state == nil {
		return
	}
	state.cancel()
	if state.threadID != "" && state.turnID != "" {
		go r.codex.InterruptTurn(context.Background(), state.threadID, state.turnID)
	}
}

func (r *Runner) loop(projectID string, stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		default:
		}
		issue, ok, err := r.store.ClaimNextIssue(context.Background(), projectID)
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		if !ok {
			if waitForWork(stop) {
				return
			}
			continue
		}
		r.runIssue(issue)
	}
}

func waitForWork(stop <-chan struct{}) bool {
	select {
	case <-stop:
		return true
	case <-time.After(2 * time.Second):
		return false
	}
}
