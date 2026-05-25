package api

import (
	"os"
	"testing"
)

func TestCompareDistStampReportsMatchAndMismatch(t *testing.T) {
	if got := compareDistStamp("stamp-a", "stamp-a", nil); got != "match" {
		t.Fatalf("match status = %q", got)
	}
	if got := compareDistStamp("stamp-a", "stamp-b", nil); got != "mismatch" {
		t.Fatalf("mismatch status = %q", got)
	}
}

func TestCompareDistStampReportsMissingRuntimeOrFile(t *testing.T) {
	if got := compareDistStamp("", "stamp-a", nil); got != "runtime_stamp_missing" {
		t.Fatalf("runtime missing status = %q", got)
	}
	if got := compareDistStamp("stamp-a", "", os.ErrNotExist); got != "dist_stamp_missing" {
		t.Fatalf("dist missing status = %q", got)
	}
}
