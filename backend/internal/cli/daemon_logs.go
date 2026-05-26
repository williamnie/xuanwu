package cli

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

type daemonLogDTO struct {
	Path  string   `json:"path"`
	Lines []string `json:"lines"`
	Error string   `json:"error,omitempty"`
}

func sanitizeLineCount(lines int) int {
	if lines <= 0 {
		return defaultDaemonLogLines
	}
	if lines > 500 {
		return 500
	}
	return lines
}

func readDaemonLogs(paths []string, lines int) []daemonLogDTO {
	out := make([]daemonLogDTO, 0, len(paths))
	for _, path := range uniqueNonEmpty(paths) {
		log := daemonLogDTO{Path: path}
		body, err := tailFile(path, lines)
		if err != nil {
			log.Error = err.Error()
		} else {
			log.Lines = redactLogLines(body)
		}
		out = append(out, log)
	}
	return out
}

func tailFile(path string, limit int) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return tailReader(file, limit), nil
}

func tailReader(r io.Reader, limit int) []string {
	if limit <= 0 {
		return nil
	}
	lines := make([]string, 0, limit)
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		if len(lines) == limit {
			copy(lines, lines[1:])
			lines[limit-1] = line
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func redactLogLines(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if isSensitiveLogLine(line) {
			out = append(out, "[redacted sensitive log line]")
			continue
		}
		out = append(out, line)
	}
	return out
}

func isSensitiveLogLine(line string) bool {
	lower := strings.ToLower(line)
	sensitive := []string{
		"authorization:", "bearer ", "auth_token", "auth-token",
		"codex_runner_auth_token", "token=", "token:",
	}
	for _, marker := range sensitive {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func writeDaemonLogs(out io.Writer, logs []daemonLogDTO, asJSON bool) error {
	if asJSON {
		return writeJSON(out, logs)
	}
	for _, log := range logs {
		if _, err := fmt.Fprintf(out, "==> %s <==\n", log.Path); err != nil {
			return err
		}
		if log.Error != "" {
			if _, err := fmt.Fprintf(out, "[error] %s\n", log.Error); err != nil {
				return err
			}
			continue
		}
		for _, line := range log.Lines {
			if _, err := fmt.Fprintln(out, line); err != nil {
				return err
			}
		}
	}
	return nil
}

func uniqueNonEmpty(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
