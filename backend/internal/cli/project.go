package cli

import (
	"context"
	"fmt"
	"strings"
)

func (e commandEnv) runProject(ctx context.Context, args []string) int {
	if len(args) == 0 {
		return e.fail("missing project command")
	}
	if args[0] == "create" {
		return e.createProject(ctx, args[1:])
	}
	return e.fail("unknown project command: " + args[0])
}

func (e commandEnv) createProject(ctx context.Context, args []string) int {
	fs := newFlagSet("project create")
	addr, asJSON := e.addCommonFlags(fs)
	id := fs.String("id", "", "project id")
	name := fs.String("name", "", "project name")
	cwd := fs.String("cwd", "", "project working directory")
	autoRun := fs.Bool("auto-run", false, "start runner automatically")
	model := fs.String("model", "", "Codex model")
	approval := fs.String("approval-policy", "never", "Codex approval policy")
	sandbox := fs.String("sandbox", "workspace-write", "Codex sandbox mode")
	if err := fs.Parse(args); err != nil {
		return e.fail(err.Error())
	}
	ctx = withFlagToken(ctx, fs)
	payload, err := projectPayload(*id, *name, *cwd, *autoRun, *model, *approval, *sandbox)
	if err != nil {
		return e.fail(err.Error())
	}
	var project projectDTO
	if err := postJSON(ctx, e.client, *addr, "/api/projects", payload, &project); err != nil {
		return e.fail(err.Error())
	}
	if err := writeProject(e.out, project, *asJSON); err != nil {
		return e.fail(err.Error())
	}
	return 0
}

func projectPayload(id, name, cwd string, autoRun bool, model string, approval string, sandbox string) (projectDTO, error) {
	project := projectDTO{ID: strings.TrimSpace(id), Name: strings.TrimSpace(name), CWD: strings.TrimSpace(cwd),
		Model: strings.TrimSpace(model), ApprovalPolicy: strings.TrimSpace(approval), Sandbox: strings.TrimSpace(sandbox)}
	if autoRun {
		project.AutoRun = 1
	}
	if project.ID == "" {
		return project, fmt.Errorf("--id is required")
	}
	if project.CWD == "" {
		return project, fmt.Errorf("--cwd is required")
	}
	return project, nil
}
