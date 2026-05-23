package cli

import "context"

func (e commandEnv) runSystem(ctx context.Context, args []string) int {
	if len(args) == 0 {
		return e.fail("missing system command")
	}
	if args[0] == "status" || args[0] == "doctor" {
		return e.getSystemStatus(ctx, args[1:])
	}
	return e.fail("unknown system command: " + args[0])
}

func (e commandEnv) getSystemStatus(ctx context.Context, args []string) int {
	fs := newFlagSet("system status")
	addr, asJSON := e.addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	var status systemStatusDTO
	if err := getJSON(ctx, e.client, *addr, "/api/system/status", &status); err != nil {
		return e.fail(err.Error())
	}
	if err := writeSystemStatus(e.out, status, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}
