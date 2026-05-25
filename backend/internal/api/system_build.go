package api

import (
	"os"
	"runtime/debug"
	"strings"
)

type systemBuildStatus struct {
	Version         string `json:"version"`
	Stamp           string `json:"stamp,omitempty"`
	GoVersion       string `json:"go_version,omitempty"`
	VCSRevision     string `json:"vcs_revision,omitempty"`
	VCSTime         string `json:"vcs_time,omitempty"`
	VCSModified     string `json:"vcs_modified,omitempty"`
	DistStamp       string `json:"dist_stamp,omitempty"`
	DistStampPath   string `json:"dist_stamp_path,omitempty"`
	DistStampStatus string `json:"dist_stamp_status"`
	DistStampError  string `json:"dist_stamp_error,omitempty"`
}

var buildStamp = ""

func buildStatus() systemBuildStatus {
	status := systemBuildStatus{
		Version: normalizedAppVersion(""),
		Stamp:   strings.TrimSpace(buildStamp),
	}
	info, ok := debug.ReadBuildInfo()
	if ok {
		applyBuildInfo(&status, info)
	}
	attachDistStamp(&status)
	return status
}

func applyBuildInfo(status *systemBuildStatus, info *debug.BuildInfo) {
	status.Version = normalizedAppVersion(info.Main.Version)
	status.GoVersion = info.GoVersion
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			status.VCSRevision = setting.Value
		case "vcs.time":
			status.VCSTime = setting.Value
		case "vcs.modified":
			status.VCSModified = setting.Value
		}
	}
}

func attachDistStamp(status *systemBuildStatus) {
	path, err := distStampPath()
	if err != nil {
		status.DistStampStatus = "not_checked"
		status.DistStampError = err.Error()
		return
	}
	status.DistStampPath = path
	stamp, err := readDistStamp(path)
	status.DistStamp = stamp
	status.DistStampStatus = compareDistStamp(status.Stamp, stamp, err)
	if err != nil && !os.IsNotExist(err) {
		status.DistStampError = err.Error()
	}
}

func distStampPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return exe + ".build.stamp", nil
}

func readDistStamp(path string) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}

func compareDistStamp(runtimeStamp, distStamp string, err error) string {
	if strings.TrimSpace(runtimeStamp) == "" {
		return "runtime_stamp_missing"
	}
	if err != nil {
		if os.IsNotExist(err) {
			return "dist_stamp_missing"
		}
		return "dist_stamp_error"
	}
	if strings.TrimSpace(distStamp) == "" {
		return "dist_stamp_missing"
	}
	if strings.TrimSpace(runtimeStamp) != strings.TrimSpace(distStamp) {
		return "mismatch"
	}
	return "match"
}

func normalizedAppVersion(moduleVersion string) string {
	if version := strings.TrimSpace(appVersion); version != "" {
		return version
	}
	if version := strings.TrimSpace(moduleVersion); version != "" && version != "(devel)" {
		return version
	}
	return "0.0.0-dev"
}
