package events

import "sync"

type AppEvent struct {
	ID             int64  `json:"id,omitempty"`
	Type           string `json:"type"`
	IssueID        int64  `json:"issueId,omitempty"`
	ProjectID      string `json:"projectId,omitempty"`
	ThreadID       string `json:"threadId,omitempty"`
	TurnID         string `json:"turnId,omitempty"`
	Method         string `json:"method,omitempty"`
	AgentEventType string `json:"agent_event_type,omitempty"`
	Provider       string `json:"provider,omitempty"`
	RawMethod      string `json:"raw_method,omitempty"`
	RawPayload     string `json:"raw_payload,omitempty"`
	Command        string `json:"command,omitempty"`
	Path           string `json:"path,omitempty"`
	Status         string `json:"status,omitempty"`
	Text           string `json:"text,omitempty"`
	Error          string `json:"error,omitempty"`
	Payload        string `json:"payload,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
}

type Bus struct {
	mu   sync.Mutex
	next int
	subs map[int]chan AppEvent
}

func NewBus() *Bus {
	return &Bus{subs: map[int]chan AppEvent{}}
}

func (b *Bus) Subscribe() (<-chan AppEvent, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	id := b.next
	b.next++
	ch := make(chan AppEvent, 64)
	b.subs[id] = ch
	return ch, func() { b.unsubscribe(id) }
}

func (b *Bus) Publish(event AppEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.subs {
		select {
		case ch <- event:
		default:
		}
	}
}

func (b *Bus) unsubscribe(id int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if ch, ok := b.subs[id]; ok {
		delete(b.subs, id)
		close(ch)
	}
}
