package runner

import (
	"github.com/xiaobei/codex-issue-runner/backend/internal/agent"
	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

func (r *Runner) ensureCodexEventPump() {
	r.eventOnce.Do(func() { go r.dispatchCodexEvents() })
}

func (r *Runner) subscribeCodexEvents() (<-chan agent.Event, func()) {
	r.ensureCodexEventPump()
	r.eventMu.Lock()
	defer r.eventMu.Unlock()
	r.nextEventSub++
	id := r.nextEventSub
	ch := make(chan agent.Event, 128)
	r.eventSubs[id] = ch
	return ch, func() { r.unsubscribeCodexEvents(id) }
}

func (r *Runner) unsubscribeCodexEvents(id int) {
	r.eventMu.Lock()
	defer r.eventMu.Unlock()
	if ch, ok := r.eventSubs[id]; ok {
		delete(r.eventSubs, id)
		close(ch)
	}
}

func (r *Runner) dispatchCodexEvents() {
	for event := range r.agent.Events() {
		r.publishCodexEvent(event)
		r.fanoutCodexEvent(event)
	}
}

func (r *Runner) fanoutCodexEvent(event agent.Event) {
	r.eventMu.Lock()
	defer r.eventMu.Unlock()
	for _, ch := range r.eventSubs {
		select {
		case ch <- event:
		default:
		}
	}
}

func (r *Runner) publishCodexEvent(event agent.Event) {
	r.bus.Publish(events.AppEvent{
		Type: "agent.event", ThreadID: event.ThreadID, TurnID: event.TurnID, Method: event.Method,
		AgentEventType: event.NormalizedType(), Provider: event.Provider, RawMethod: event.ProviderMethod(),
		RawPayload: event.ProviderPayload(), Command: event.Command, Path: event.Path,
		Status: event.Status, Text: event.Text, Error: event.Error, Payload: event.Payload,
	})
}
