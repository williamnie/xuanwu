package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
)

const defaultAddr = "127.0.0.1:3008"

type commandEnv struct {
	client *http.Client
	env    func(string) string
	out    io.Writer
	errOut io.Writer
}

func Run(ctx context.Context, args []string, out, errOut io.Writer, opts Options) int {
	env := commandEnv{client: opts.HTTPClient, env: opts.Env, out: out, errOut: errOut}
	if env.client == nil {
		env.client = http.DefaultClient
	}
	if env.env == nil {
		env.env = os.Getenv
	}
	if len(args) == 0 {
		return env.fail("missing command")
	}
	if args[0] == "issue" {
		return env.runIssue(ctx, args[1:])
	}
	if args[0] == "project" {
		return env.runProject(ctx, args[1:])
	}
	return env.fail("unknown command: " + args[0])
}

func (e commandEnv) runIssue(ctx context.Context, args []string) int {
	if len(args) == 0 {
		return e.fail("missing issue command")
	}
	switch args[0] {
	case "create":
		return e.createIssue(ctx, args[1:])
	case "status":
		return e.getIssue(ctx, args[1:])
	case "logs":
		return e.getIssueLogs(ctx, args[1:])
	case "enqueue", "retry", "cancel":
		return e.issueAction(ctx, args[0], args[1:])
	default:
		return e.fail("unknown issue command: " + args[0])
	}
}

func (e commandEnv) fail(message string) int {
	_, _ = fmt.Fprintln(e.errOut, message)
	return 1
}

func (e commandEnv) addCommonFlags(fs *flag.FlagSet) (*string, *bool) {
	addr := fs.String("addr", e.defaultAddr(), "Codex Issue Runner API address")
	asJSON := fs.Bool("json", false, "print JSON output")
	return addr, asJSON
}

func (e commandEnv) defaultAddr() string {
	if value := e.env("CODEX_RUNNER_ADDR"); value != "" {
		return value
	}
	return defaultAddr
}

func parseID(raw string) (int64, error) {
	if raw == "" {
		return 0, fmt.Errorf("--id is required")
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("--id must be a positive integer")
	}
	return id, nil
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}
