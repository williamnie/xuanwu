package api

import (
	"bufio"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultRuntimeLogLines = 120
	maxRuntimeLogLines     = 500
)

type runtimeLogsSummary struct {
	GeneratedAt    string           `json:"generated_at"`
	LineLimit      int              `json:"line_limit"`
	Logs           []runtimeLogFile `json:"logs"`
	RecentErrors   []runtimeLogLine `json:"recent_errors"`
	RecentWarnings []runtimeLogLine `json:"recent_warnings"`
}

type runtimeLogFile struct {
	Source    string           `json:"source"`
	Path      string           `json:"path"`
	Available bool             `json:"available"`
	Error     string           `json:"error,omitempty"`
	Lines     []runtimeLogLine `json:"lines,omitempty"`
}

type runtimeLogLine struct {
	Source string `json:"source"`
	Path   string `json:"path"`
	Time   string `json:"time,omitempty"`
	Level  string `json:"level"`
	Text   string `json:"text"`
}

var (
	secretAssignmentPattern = regexp.MustCompile(`(?i)([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)[^\s,;]+`)
	authHeaderPattern       = regexp.MustCompile(`(?i)authorization:\s*[^\r\n]+`)
	bearerPattern           = regexp.MustCompile(`(?i)bearer\s+[^\s,;]+`)
)

func (s *Server) handleSystemLogs(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, s.buildRuntimeLogs(runtimeLogLineLimit(r)))
}

func (s *Server) buildRuntimeLogs(limit int) runtimeLogsSummary {
	logs := runtimeLogPaths(s.systemConfig)
	result := runtimeLogsSummary{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		LineLimit:   limit,
		Logs:        make([]runtimeLogFile, 0, len(logs)),
	}
	for _, logPath := range logs {
		file := readRuntimeLog(logPath, limit)
		result.Logs = append(result.Logs, file)
		result.RecentErrors = append(result.RecentErrors, filterLogLines(file.Lines, "error")...)
		result.RecentWarnings = append(result.RecentWarnings, filterLogLines(file.Lines, "warning")...)
	}
	return result
}

func runtimeLogLineLimit(r *http.Request) int {
	value, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("lines")))
	if err != nil || value <= 0 {
		return defaultRuntimeLogLines
	}
	if value > maxRuntimeLogLines {
		return maxRuntimeLogLines
	}
	return value
}

func runtimeLogPaths(cfg SystemConfig) []runtimeLogPath {
	if len(cfg.LogPaths) > 0 {
		return logPathsFromConfig(cfg.LogPaths)
	}
	base := runtimeLogDir(cfg.DBPath)
	return []runtimeLogPath{
		{Source: "server", Path: filepath.Join(base, "launchd.out.log")},
		{Source: "runner", Path: filepath.Join(base, "launchd.err.log")},
	}
}

func logPathsFromConfig(paths []string) []runtimeLogPath {
	out := make([]runtimeLogPath, 0, len(paths))
	for _, path := range cleanLogPaths(paths) {
		out = append(out, runtimeLogPath{Source: sourceFromLogPath(path), Path: path})
	}
	return out
}

func runtimeLogDir(dbPath string) string {
	dbPath = strings.TrimSpace(dbPath)
	if dbPath == "" {
		return filepath.Join("data", "logs")
	}
	return filepath.Join(filepath.Dir(dbPath), "logs")
}

type runtimeLogPath struct {
	Source string
	Path   string
}

func sourceFromLogPath(path string) string {
	lower := strings.ToLower(filepath.Base(path))
	if strings.Contains(lower, "err") {
		return "runner"
	}
	return "server"
}

func readRuntimeLog(logPath runtimeLogPath, limit int) runtimeLogFile {
	file := runtimeLogFile{Source: logPath.Source, Path: logPath.Path}
	lines, err := tailRuntimeFile(logPath.Path, limit)
	if err != nil {
		file.Error = runtimeLogError(err)
		return file
	}
	file.Available = true
	file.Lines = normalizeRuntimeLogLines(logPath, lines)
	return file
}

func tailRuntimeFile(path string, limit int) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return tailRuntimeReader(file, limit), nil
}

func tailRuntimeReader(r io.Reader, limit int) []string {
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

func normalizeRuntimeLogLines(logPath runtimeLogPath, lines []string) []runtimeLogLine {
	out := make([]runtimeLogLine, 0, len(lines))
	for _, line := range lines {
		if isSensitiveRuntimeLogLine(line) {
			line = "[redacted sensitive log line]"
		}
		redacted := redactRuntimeLogLine(line)
		out = append(out, runtimeLogLine{
			Source: logPath.Source,
			Path:   logPath.Path,
			Time:   detectLogTime(redacted),
			Level:  detectLogLevel(redacted),
			Text:   redacted,
		})
	}
	return out
}

func redactRuntimeLogLine(line string) string {
	line = authHeaderPattern.ReplaceAllString(line, "Authorization: [redacted]")
	line = bearerPattern.ReplaceAllString(line, "Bearer [redacted]")
	return secretAssignmentPattern.ReplaceAllString(line, "${1}[redacted]")
}

func isSensitiveRuntimeLogLine(line string) bool {
	lower := strings.ToLower(line)
	markers := []string{
		"auth_token", "auth-token", "authorization:",
		"codex_runner_auth_token", "bearer ",
	}
	for _, marker := range markers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func detectLogTime(line string) string {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	first := strings.Trim(fields[0], "[]")
	if _, err := time.Parse(time.RFC3339, first); err == nil {
		return first
	}
	if len(fields) > 1 {
		candidate := strings.Trim(fields[0]+" "+fields[1], "[]")
		if _, err := time.Parse("2006/01/02 15:04:05", candidate); err == nil {
			return candidate
		}
	}
	return ""
}

func detectLogLevel(line string) string {
	lower := strings.ToLower(line)
	if strings.Contains(lower, "panic") || strings.Contains(lower, "fatal") || strings.Contains(lower, "error") || strings.Contains(lower, "failed") {
		return "error"
	}
	if strings.Contains(lower, "warn") {
		return "warning"
	}
	return "info"
}

func filterLogLines(lines []runtimeLogLine, level string) []runtimeLogLine {
	out := []runtimeLogLine{}
	for _, line := range lines {
		if line.Level == level {
			out = append(out, line)
		}
	}
	return out
}

func runtimeLogError(err error) string {
	if os.IsNotExist(err) {
		return "log file does not exist"
	}
	if os.IsPermission(err) {
		return "permission denied reading log file"
	}
	return err.Error()
}
