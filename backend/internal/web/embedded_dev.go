//go:build !release

package web

import "io/fs"

func EmbeddedFS() (fs.FS, bool) {
	return nil, false
}
