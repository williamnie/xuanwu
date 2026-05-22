//go:build release

package web

import (
	"embed"
	"io/fs"
)

//go:embed dist
var dist embed.FS

func EmbeddedFS() (fs.FS, bool) {
	sub, err := fs.Sub(dist, "dist")
	return sub, err == nil
}
