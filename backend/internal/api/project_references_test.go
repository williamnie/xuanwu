package api

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectReferenceSearchListsSafeFilesAndFolders(t *testing.T) {
	srv := newTestServer(t)
	root := t.TempDir()
	writeProjectFile(t, root, "frontend/src/pages/Sessions.jsx", "export default function Sessions() {}\n")
	writeProjectFile(t, root, "frontend/src/pages/Other.jsx", "export default function Other() {}\n")
	writeProjectFile(t, root, "node_modules/pkg/index.js", "ignored\n")
	writeProjectFile(t, root, "ignored.log", "ignored\n")
	writeProjectFile(t, root, ".env", "SECRET=ignored\n")
	writeProjectFile(t, root, ".gitignore", "ignored.log\n")
	postJSON[map[string]any](t, srv, "/api/projects", map[string]any{
		"id": "demo", "cwd": root, "auto_run": 0,
	})

	files := getJSON[map[string][]map[string]any](t, srv, "/api/projects/demo/references/search?type=file&query=Sessions")
	folders := getJSON[map[string][]map[string]any](t, srv, "/api/projects/demo/references/search?type=folder&query=pages")

	if len(files["files"]) != 1 || files["files"][0]["path"] != "frontend/src/pages/Sessions.jsx" {
		t.Fatalf("files = %+v", files["files"])
	}
	if len(folders["folders"]) == 0 || folders["folders"][0]["path"] != "frontend/src/pages" {
		t.Fatalf("folders = %+v", folders["folders"])
	}
	all := getJSON[map[string][]map[string]any](t, srv, "/api/projects/demo/references/search?limit=200")
	for _, item := range append(all["files"], all["folders"]...) {
		path, _ := item["path"].(string)
		if path == ".env" || path == "ignored.log" || path == "node_modules/pkg/index.js" {
			t.Fatalf("unsafe or ignored path leaked: %+v", item)
		}
	}
}

func writeProjectFile(t *testing.T, root, rel, body string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", rel, err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}
