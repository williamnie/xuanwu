package codex

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/xiaobei/codex-issue-runner/backend/internal/events"
)

type wireMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *wireError      `json:"error,omitempty"`
}

type wireError struct {
	Code    int64  `json:"code"`
	Message string `json:"message"`
}

func (a *Adapter) readLoop(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 10*1024*1024)
	for scanner.Scan() {
		a.handleLine(append([]byte(nil), scanner.Bytes()...))
	}
	if err := scanner.Err(); err != nil {
		a.failPending(err)
	}
}

func (a *Adapter) stderrLoop(r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		text := scanner.Text()
		a.emit(Event{
			Method: "process/stderr", AgentEventType: events.AgentError,
			Provider: events.ProviderCodex, RawMethod: "process/stderr", Text: text, Error: text,
		})
	}
}

func (a *Adapter) handleLine(line []byte) {
	var msg wireMessage
	if err := json.Unmarshal(line, &msg); err != nil {
		a.emit(Event{
			Method: "protocol/error", AgentEventType: events.AgentError,
			Provider: events.ProviderCodex, RawMethod: "protocol/error", RawPayload: string(line),
			Error: err.Error(), Text: string(line),
		})
		return
	}
	if len(msg.ID) > 0 && msg.Method == "" {
		a.deliverResponse(msg)
		return
	}
	if len(msg.ID) > 0 && msg.Method != "" {
		a.handleServerRequest(msg)
		return
	}
	if msg.Method != "" {
		a.emit(normalizeEvent(msg.Method, msg.Params))
	}
}

func (a *Adapter) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.stdin == nil {
		return fmt.Errorf("codex app-server stdin is not ready")
	}
	_, err = a.stdin.Write(append(b, '\n'))
	return err
}

func (a *Adapter) registerRequest() (int64, chan rpcResponse) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nextID++
	id := a.nextID
	ch := make(chan rpcResponse, 1)
	a.pending[id] = ch
	return id, ch
}

func (a *Adapter) unregister(id int64) {
	a.mu.Lock()
	delete(a.pending, id)
	a.mu.Unlock()
}

func (a *Adapter) deliverResponse(msg wireMessage) {
	id, err := decodeID(msg.ID)
	if err != nil {
		a.emit(Event{Method: "protocol/error", Error: err.Error()})
		return
	}
	a.mu.Lock()
	ch := a.pending[id]
	delete(a.pending, id)
	a.mu.Unlock()
	if ch == nil {
		return
	}
	if msg.Error != nil {
		ch <- rpcResponse{Err: fmt.Errorf("codex rpc %d: %s", msg.Error.Code, msg.Error.Message)}
		return
	}
	ch <- rpcResponse{Result: msg.Result}
}

func (a *Adapter) failPending(err error) {
	a.mu.Lock()
	pending := a.pending
	a.pending = map[int64]chan rpcResponse{}
	a.started = false
	a.mu.Unlock()
	for _, ch := range pending {
		ch <- rpcResponse{Err: err}
	}
}

func (a *Adapter) emit(event Event) {
	select {
	case a.events <- event:
	default:
	}
}

func execErrSignal() os.Signal {
	return os.Interrupt
}
