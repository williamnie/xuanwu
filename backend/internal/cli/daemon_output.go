package cli

import (
	"fmt"
	"io"
)

func writeDaemonStatus(out io.Writer, status daemonStatusDTO, asJSON bool) error {
	if asJSON {
		return writeJSON(out, status)
	}
	if _, err := fmt.Fprintf(out, "launchd label=%s loaded=%t running=%t",
		status.Label, status.Loaded, status.Running); err != nil {
		return err
	}
	if status.PID > 0 {
		if _, err := fmt.Fprintf(out, " pid=%d", status.PID); err != nil {
			return err
		}
	}
	if status.ListenAddr != "" {
		if _, err := fmt.Fprintf(out, " addr=%s", status.ListenAddr); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintln(out); err != nil {
		return err
	}
	if status.Version != "" || status.BuildStamp != "" {
		if _, err := fmt.Fprintf(out, "version=%s build_stamp=%s\n",
			status.Version, status.BuildStamp); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(out, "http_ok=%t db_ok=%t\n", status.HTTPOK, status.DBOK); err != nil {
		return err
	}
	for _, path := range status.LogPaths {
		if _, err := fmt.Fprintf(out, "log=%s\n", path); err != nil {
			return err
		}
	}
	if status.Error != "" {
		_, err := fmt.Fprintf(out, "error=%s\n", status.Error)
		return err
	}
	return nil
}
