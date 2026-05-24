package agent

// RawEvent preserves provider-native event identity/payload while callers move
// to the normalized Event envelope.
type RawEvent struct {
	Method  string
	Payload string
}

// Event is the normalized provider event envelope. Provider-specific payloads
// remain in Raw/RawPayload for now so v1 can be behavior-preserving.
type Event struct {
	Type     string
	Provider string
	ThreadID string
	TurnID   string

	Text    string
	Command string
	Path    string
	Status  string
	Error   string
	Payload string
	Raw     RawEvent

	// Compatibility fields kept while runner/API payloads are migrated.
	Method         string
	AgentEventType string
	RawMethod      string
	RawPayload     string
}

func (e Event) NormalizedType() string {
	if e.Type != "" {
		return e.Type
	}
	return e.AgentEventType
}

func (e Event) ProviderMethod() string {
	if e.Raw.Method != "" {
		return e.Raw.Method
	}
	if e.RawMethod != "" {
		return e.RawMethod
	}
	return e.Method
}

func (e Event) ProviderPayload() string {
	if e.Raw.Payload != "" {
		return e.Raw.Payload
	}
	if e.RawPayload != "" {
		return e.RawPayload
	}
	return e.Payload
}
