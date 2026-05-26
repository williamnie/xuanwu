package cli

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

var daemonGOOS = runtime.GOOS

func loadLaunchdInfo(ctx context.Context, label string) (launchdInfo, error) {
	info := launchdInfo{Label: label, Domain: launchdDomain()}
	if daemonGOOS != "darwin" {
		return info, fmt.Errorf("unsupported platform %s; daemon lifecycle v1 supports macOS launchd only", daemonGOOS)
	}
	if _, err := exec.LookPath("launchctl"); err != nil {
		return info, fmt.Errorf("launchctl not found; daemon lifecycle v1 supports macOS launchd only")
	}
	out, err := exec.CommandContext(ctx, "launchctl", "print", info.Domain+"/"+label).Output()
	if err != nil {
		return info, fmt.Errorf("launchd service is not loaded: %s/%s", info.Domain, label)
	}
	parseLaunchdPrint(&info, string(out))
	return info, nil
}

func parseLaunchdPrint(info *launchdInfo, text string) {
	scanner := bufio.NewScanner(strings.NewReader(text))
	inArgs := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "arguments = {" {
			inArgs = true
			continue
		}
		if inArgs {
			inArgs = parseLaunchdArgumentLine(info, line)
			continue
		}
		parseLaunchdFieldLine(info, line)
	}
	info.ListenAddr = valueAfterFlag(info.Args, "--addr")
	info.AuthTokenFile = valueAfterFlag(info.Args, "--auth-token-file")
}

func parseLaunchdArgumentLine(info *launchdInfo, line string) bool {
	if line == "}" {
		return false
	}
	if line != "" {
		info.Args = append(info.Args, line)
	}
	return true
}

func parseLaunchdFieldLine(info *launchdInfo, line string) {
	switch {
	case strings.HasPrefix(line, "state ="):
		info.State = strings.TrimSpace(strings.TrimPrefix(line, "state ="))
	case strings.HasPrefix(line, "pid ="):
		info.PID, _ = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "pid =")))
	case strings.HasPrefix(line, "stdout path ="):
		info.LogPaths = append(info.LogPaths, strings.TrimSpace(strings.TrimPrefix(line, "stdout path =")))
	case strings.HasPrefix(line, "stderr path ="):
		info.LogPaths = append(info.LogPaths, strings.TrimSpace(strings.TrimPrefix(line, "stderr path =")))
	}
}

func valueAfterFlag(args []string, name string) string {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == name {
			return strings.TrimSpace(args[i+1])
		}
	}
	return ""
}

func launchdDomain() string {
	return "gui/" + strconv.Itoa(os.Getuid())
}

func kickstartLaunchd(ctx context.Context, info launchdInfo) error {
	service := info.Domain + "/" + info.Label
	cmd := exec.CommandContext(ctx, "launchctl", "kickstart", "-k", service)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("launchctl kickstart failed for %s", service)
	}
	return nil
}

func launchdListenAddrToHTTPAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	host, port, err := net.SplitHostPort(addr)
	if err == nil {
		return normalizedHTTPAddr(host, port)
	}
	if strings.HasPrefix(addr, ":") {
		return "127.0.0.1" + addr
	}
	return addr
}

func normalizedHTTPAddr(host, port string) string {
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, port)
}
