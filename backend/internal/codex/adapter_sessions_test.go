package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

func TestThreadSetNameUsesCurrentRPCMethod(t *testing.T) {
	adapter := NewAdapter("", nil)
	reader, writer := io.Pipe()
	adapter.stdin = writer
	t.Cleanup(func() {
		_ = reader.Close()
		_ = writer.Close()
	})

	errCh := make(chan error, 1)
	go func() {
		errCh <- adapter.ThreadSetName(context.Background(), "thread-1", "Issue title")
	}()

	line := readAdapterRequestLine(t, reader)
	var got struct {
		ID     int64          `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if got.Method != "thread/name/set" {
		t.Fatalf("method = %q, want thread/name/set", got.Method)
	}
	if got.Params["threadId"] != "thread-1" || got.Params["name"] != "Issue title" {
		t.Fatalf("params = %+v, want thread id and name", got.Params)
	}

	adapter.handleLine([]byte(`{"id":1,"result":{}}`))
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("ThreadSetName returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ThreadSetName did not receive response")
	}
}

func readAdapterRequestLine(t *testing.T, reader io.Reader) string {
	t.Helper()
	lines := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(reader)
		if scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	select {
	case line := <-lines:
		return line
	case <-time.After(time.Second):
		t.Fatal("adapter did not write request")
		return ""
	}
}
