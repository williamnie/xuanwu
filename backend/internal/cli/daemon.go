package cli

import (
	"context"
	"flag"
	"fmt"
	"strings"
	"time"
)

const (
	defaultDaemonLabel    = "com.xiaobei.codex-issue-runner"
	defaultDaemonLogLines = 80
	restartCheckAttempts  = 60
	restartCheckInterval  = 500 * time.Millisecond
)

type daemonStatusDTO struct {
	Label      string   `json:"label"`
	Loaded     bool     `json:"loaded"`
	Running    bool     `json:"running"`
	PID        int      `json:"pid"`
	ListenAddr string   `json:"listen_addr"`
	Version    string   `json:"version"`
	BuildStamp string   `json:"build_stamp"`
	HTTPOK     bool     `json:"http_ok"`
	DBOK       bool     `json:"db_ok"`
	LogPaths   []string `json:"log_paths"`
	Error      string   `json:"error,omitempty"`
}

type launchdInfo struct {
	Label         string
	Domain        string
	State         string
	PID           int
	LogPaths      []string
	Args          []string
	AuthTokenFile string
	ListenAddr    string
}

func (e commandEnv) runDaemon(ctx context.Context, args []string) int {
	if len(args) == 0 {
		return e.fail("missing daemon command")
	}
	switch args[0] {
	case "status":
		return e.daemonStatus(ctx, args[1:])
	case "logs":
		return e.daemonLogs(args[1:])
	case "restart":
		return e.daemonRestart(ctx, args[1:])
	case "start", "stop":
		return e.fail("daemon " + args[0] + " is not supported in v1; use deploy.sh or scripts/uninstall-launchd.sh")
	default:
		return e.fail("unknown daemon command: " + args[0])
	}
}

func (e commandEnv) daemonStatus(ctx context.Context, args []string) int {
	fs := newFlagSet("daemon status")
	addr, asJSON := e.addCommonFlags(fs)
	label := daemonLabelFlag(fs, e)
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	status, err := e.collectDaemonStatus(ctx, fs, *addr, *label)
	if writeErr := writeDaemonStatus(e.out, status, *asJSON); writeErr != nil {
		return e.fail(writeErr.Error())
	}
	if err != nil {
		_, _ = fmt.Fprintln(e.errOut, err)
		return 1
	}
	return 0
}

func (e commandEnv) daemonRestart(ctx context.Context, args []string) int {
	fs := newFlagSet("daemon restart")
	addr, asJSON := e.addCommonFlags(fs)
	label := daemonLabelFlag(fs, e)
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	info, err := loadLaunchdInfo(ctx, *label)
	if err != nil {
		return e.fail(err.Error())
	}
	if err := kickstartLaunchd(ctx, info); err != nil {
		return e.fail(err.Error())
	}
	status, err := e.waitDaemonStatus(ctx, fs, *addr, *label)
	if writeErr := writeDaemonStatus(e.out, status, *asJSON); writeErr != nil {
		return e.fail(writeErr.Error())
	}
	if err != nil {
		_, _ = fmt.Fprintln(e.errOut, err)
		return 1
	}
	return 0
}

func (e commandEnv) daemonLogs(args []string) int {
	fs := newFlagSet("daemon logs")
	asJSON := fs.Bool("json", false, "print JSON output")
	lines := fs.Int("lines", defaultDaemonLogLines, "tail line count per log file")
	label := daemonLabelFlag(fs, e)
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	info, err := loadLaunchdInfo(context.Background(), *label)
	if err != nil {
		return e.fail(err.Error())
	}
	logs := readDaemonLogs(info.LogPaths, sanitizeLineCount(*lines))
	if len(logs) == 0 {
		return e.fail("launchd log paths not found")
	}
	if err := writeDaemonLogs(e.out, logs, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}

func daemonLabelFlag(fs *flag.FlagSet, e commandEnv) *string {
	label := strings.TrimSpace(e.env("CODEX_RUNNER_LAUNCHD_LABEL"))
	if label == "" {
		label = defaultDaemonLabel
	}
	return fs.String("label", label, "launchd service label")
}

func (e commandEnv) collectDaemonStatus(
	ctx context.Context, fs *flag.FlagSet, addr, label string,
) (daemonStatusDTO, error) {
	status := daemonStatusDTO{Label: label}
	info, err := loadLaunchdInfo(ctx, label)
	if err != nil {
		status.Error = err.Error()
		return status, err
	}
	status = statusFromLaunchd(info)
	if !flagWasSet(fs, "addr") && info.ListenAddr != "" {
		addr = launchdListenAddrToHTTPAddr(info.ListenAddr)
	}
	token := daemonAuthToken(fs, info)
	httpStatus, err := e.fetchDaemonHTTPStatus(ctx, addr, token)
	if err != nil {
		status.Error = err.Error()
		return status, err
	}
	mergeHTTPStatus(&status, httpStatus)
	return status, nil
}

func (e commandEnv) waitDaemonStatus(
	ctx context.Context, fs *flag.FlagSet, addr, label string,
) (daemonStatusDTO, error) {
	var status daemonStatusDTO
	var err error
	for attempt := 0; attempt < restartCheckAttempts; attempt++ {
		status, err = e.collectDaemonStatus(ctx, fs, addr, label)
		if err == nil && status.HTTPOK && status.DBOK {
			return status, nil
		}
		if attempt < restartCheckAttempts-1 {
			time.Sleep(restartCheckInterval)
		}
	}
	if err == nil {
		err = fmt.Errorf("HTTP status verification did not become healthy")
	}
	return status, err
}

func (e commandEnv) fetchDaemonHTTPStatus(
	ctx context.Context, addr, token string,
) (systemStatusDTO, error) {
	if token != "" {
		ctx = context.WithValue(ctx, authTokenKey{}, token)
	}
	var status systemStatusDTO
	if err := getJSON(ctx, e.client, addr, "/api/system/status", &status); err != nil {
		return status, err
	}
	return status, nil
}

func daemonAuthToken(fs *flag.FlagSet, info launchdInfo) string {
	if token := parsedAuthToken(fs); token != "" {
		return token
	}
	return tokenFromFlagFile(info.AuthTokenFile)
}

func statusFromLaunchd(info launchdInfo) daemonStatusDTO {
	return daemonStatusDTO{
		Label: info.Label, Loaded: true, Running: info.Running(), PID: info.PID,
		ListenAddr: info.ListenAddr, LogPaths: info.LogPaths,
	}
}

func mergeHTTPStatus(status *daemonStatusDTO, httpStatus systemStatusDTO) {
	status.HTTPOK = httpStatus.Service.Alive
	status.DBOK = httpStatus.DB.OK
	if httpStatus.Config.Addr != "" {
		status.ListenAddr = httpStatus.Config.Addr
	}
	status.Version = httpStatus.Service.Version
	status.BuildStamp = stringMapValue(httpStatus.Service.Build, "stamp")
}

func (i launchdInfo) Running() bool {
	return strings.EqualFold(i.State, "running") || i.PID > 0
}

func stringMapValue(values map[string]any, key string) string {
	if raw, ok := values[key]; ok {
		return strings.TrimSpace(fmt.Sprint(raw))
	}
	return ""
}

func flagWasSet(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(flag *flag.Flag) {
		if flag.Name == name {
			found = true
		}
	})
	return found
}
