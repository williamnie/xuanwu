package runner

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
	"github.com/xiaobei/codex-issue-runner/backend/internal/store"
)

type Runner struct {
	store               *store.Store
	bus                 *events.Bus
	agent               agent.AgentProvider
	notifier            IssueNotifier
	execMu              sync.Mutex
	healthCheckInterval time.Duration
	healthCheckWait     time.Duration
	autoRetryDelay      time.Duration

	eventOnce    sync.Once
	eventMu      sync.Mutex
	nextEventSub int
	eventSubs    map[int]chan agent.Event

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

type IssueNotifier interface {
	NotifyIssueStatus(context.Context, store.Issue)
}

func (r *Runner) SetIssueNotifier(notifier IssueNotifier) {
	r.notifier = notifier
}

func New(st *store.Store, bus *events.Bus, provider agent.AgentProvider) *Runner {
	return &Runner{
		store: st, bus: bus, agent: provider, eventSubs: map[int]chan agent.Event{},
		healthCheckInterval: defaultHoldCheckInterval, healthCheckWait: 20 * time.Second,
		autoRetryDelay: defaultAutoRetryDelay,
		loops:          map[string]chan struct{}{}, running: map[int64]*runState{}, sessions: map[string]*runState{},
	}
}

func (r *Runner) StartProject(projectID string) error {
	project, err := r.store.GetProject(context.Background(), projectID)
	if err != nil {
		return err
	}
	if project.Hold != nil {
		r.bus.Publish(events.AppEvent{
			Type: "runner.hold_active", ProjectID: projectID,
			Error: project.Hold.Message, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		})
		return nil
	}
	if err := ensureCodexProjectProvider(project); err != nil {
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

func ensureCodexProjectProvider(project store.Project) error {
	if project.Provider == "" || project.Provider == store.ProviderCodex {
		return nil
	}
	return fmt.Errorf("project %s provider %q 暂不支持，当前只支持 codex", project.ID, project.Provider)
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

func (r *Runner) Snapshot() (runningLoops int, runningIssues int, runningSessions int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.loops), len(r.running), len(r.sessions)
}

func (r *Runner) StartAutoProjects(ctx context.Context) error {
	projects, err := r.store.ListProjects(ctx)
	if err != nil {
		return err
	}
	for _, p := range projects {
		if p.AutoRun == 1 && p.Hold == nil {
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
		go r.interruptTurn(context.Background(), state.threadID, state.turnID)
	}
}

func (r *Runner) loop(projectID string, stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		default:
		}
		project, err := r.store.GetProject(context.Background(), projectID)
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		if project.Hold != nil {
			return
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
