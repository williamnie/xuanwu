package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func getJSON(ctx context.Context, client *http.Client, addr, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint(addr, path), nil)
	if err != nil {
		return err
	}
	setAuthHeader(req)
	return doJSON(client, req, out)
}

func postJSON(ctx context.Context, client *http.Client, addr, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint(addr, path), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	setAuthHeader(req)
	return doJSON(client, req, out)
}

func patchJSON(ctx context.Context, client *http.Client, addr, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, endpoint(addr, path), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	setAuthHeader(req)
	return doJSON(client, req, out)
}

func setAuthHeader(req *http.Request) {
	if value := req.Context().Value(authTokenKey{}); value != nil {
		if token, ok := value.(string); ok && strings.TrimSpace(token) != "" {
			req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
		}
	}
}

func doJSON(client *http.Client, req *http.Request, out any) error {
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return responseError(resp)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func responseError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	var payload struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Message != "" {
		return fmt.Errorf("%s: %s", resp.Status, payload.Message)
	}
	text := strings.TrimSpace(string(body))
	if text == "" {
		return fmt.Errorf("%s", resp.Status)
	}
	return fmt.Errorf("%s: %s", resp.Status, text)
}

func endpoint(addr, path string) string {
	addr = strings.TrimRight(strings.TrimSpace(addr), "/")
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") {
		addr = "http://" + addr
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return addr + path
}
