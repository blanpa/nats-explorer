package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// put replaces the installation with the verified download and keeps what
// it replaces as the previous version. Every new file is written next to the
// one it replaces and renamed over it, so an update that fails halfway leaves
// the old version as it was.
func put(t Target, download string) error {
	switch t.Kind {
	case AppImage:
		f, err := os.Open(download)
		if err != nil {
			return err
		}
		defer f.Close()
		return replaceFile(t, f)
	case Tarball:
		r, closeFn, err := tarMember(download, t.member)
		if err != nil {
			return err
		}
		defer closeFn()
		return replaceFile(t, r)
	case Windows:
		r, closeFn, err := zipMember(download, t.member)
		if err != nil {
			return err
		}
		defer closeFn()
		return replaceRunning(t, r)
	case MacApp:
		return replaceBundle(t, download)
	}
	return fmt.Errorf("no way to update a %s installation", t.Kind)
}

// writeBeside writes r to a new executable file in path's directory.
func writeBeside(path string, r io.Reader) (string, error) {
	f, err := os.CreateTemp(filepath.Dir(path), ".nats-explorer-update-*")
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, io.LimitReader(r, maxAsset))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(f.Name(), 0o755)
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// replaceFile puts r in place of the file, on Linux, where the running
// process keeps the old file open and is not disturbed. The old file stays
// as the previous version through a second name for it, so the file itself
// is never missing; a file system without hard links gets a copy.
func replaceFile(t Target, r io.Reader) error {
	tmp, err := writeBeside(t.Path, r)
	if err != nil {
		return err
	}
	old := t.previous()
	os.Remove(old)
	if err := os.Link(t.Path, old); err != nil {
		if src, err := os.Open(t.Path); err == nil {
			if kept, err := writeBeside(old, src); err != nil || os.Rename(kept, old) != nil {
				os.Remove(kept)
			}
			src.Close()
		}
	}
	if err := os.Rename(tmp, t.Path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// replaceRunning is replaceFile for Windows, which does not let a running
// .exe be overwritten but does let it be renamed: the old one steps aside
// as the previous version.
func replaceRunning(t Target, r io.Reader) error {
	tmp, err := writeBeside(t.Path, r)
	if err != nil {
		return err
	}
	old := t.previous()
	os.Remove(old)
	if err := os.Rename(t.Path, old); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, t.Path); err != nil {
		os.Rename(old, t.Path)
		os.Remove(tmp)
		return err
	}
	return nil
}

// replaceBundle unpacks the .app of the zip next to the installed one and
// swaps the two. The old bundle stays under a hidden name as the previous
// version, so nothing is pulled away from under the running app.
func replaceBundle(t Target, download string) error {
	parent := filepath.Dir(t.Path)
	stage, err := os.MkdirTemp(parent, ".nats-explorer-update-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	app, err := unzipBundle(download, stage)
	if err != nil {
		return err
	}
	old := t.previous()
	if err := os.RemoveAll(old); err != nil {
		return err
	}
	if err := os.Rename(t.Path, old); err != nil {
		return err
	}
	if err := os.Rename(app, t.Path); err != nil {
		os.Rename(old, t.Path)
		return err
	}
	return nil
}

// swapPrevious exchanges the installation and the previous version: three
// renames, which every platform allows on a running .exe or bundle. When the
// second fails the first is undone; a failed third leaves the installation
// in place and the other version under a name the next start cleans up.
func swapPrevious(t Target) error {
	old := t.previous()
	tmp := filepath.Join(filepath.Dir(t.Path), ".nats-explorer-update-swap")
	os.RemoveAll(tmp)
	if err := os.Rename(t.Path, tmp); err != nil {
		return err
	}
	if err := os.Rename(old, t.Path); err != nil {
		os.Rename(tmp, t.Path)
		return err
	}
	return os.Rename(tmp, old)
}

// tarMember finds one file in a .tar.gz.
func tarMember(archive, name string) (io.Reader, func(), error) {
	f, err := os.Open(archive)
	if err != nil {
		return nil, nil, err
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	closeFn := func() { gz.Close(); f.Close() }
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			closeFn()
			return nil, nil, err
		}
		if h.FileInfo().Mode().IsRegular() && path.Clean(h.Name) == name {
			return tr, closeFn, nil
		}
	}
	closeFn()
	return nil, nil, fmt.Errorf("%s is not in %s", name, filepath.Base(archive))
}

// zipMember finds one file in a .zip.
func zipMember(archive, name string) (io.Reader, func(), error) {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return nil, nil, err
	}
	for _, f := range zr.File {
		if path.Clean(f.Name) == name && f.Mode().IsRegular() {
			rc, err := f.Open()
			if err != nil {
				zr.Close()
				return nil, nil, err
			}
			return rc, func() { rc.Close(); zr.Close() }, nil
		}
	}
	zr.Close()
	return nil, nil, fmt.Errorf("%s is not in %s", name, filepath.Base(archive))
}

// unzipBundle writes the .app directory of a zip below dir and returns its
// path. Every name has to stay below dir, links included.
func unzipBundle(archive, dir string) (string, error) {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return "", err
	}
	defer zr.Close()
	app := ""
	for _, f := range zr.File {
		name := path.Clean(f.Name)
		if !filepath.IsLocal(name) {
			return "", fmt.Errorf("%s: %q points outside of the archive", filepath.Base(archive), f.Name)
		}
		top, _, _ := strings.Cut(name, "/")
		if !strings.HasSuffix(top, ".app") {
			continue
		}
		if app == "" {
			app = top
		} else if top != app {
			continue
		}
		dst := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return "", err
		}
		mode := f.Mode()
		switch {
		case mode.IsDir():
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return "", err
			}
		case mode&fs.ModeSymlink != 0:
			if err := unzipLink(f, app, name, dst); err != nil {
				return "", err
			}
		case mode.IsRegular():
			if err := unzipFile(f, dst, mode.Perm()|0o644); err != nil {
				return "", err
			}
		}
	}
	if app == "" {
		return "", fmt.Errorf("%s has no app bundle", filepath.Base(archive))
	}
	return filepath.Join(dir, app), nil
}

func unzipFile(f *zip.File, dst string, perm fs.FileMode) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, io.LimitReader(rc, maxAsset))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// unzipLink recreates a symbolic link, which a framework inside a bundle
// would carry; one that leads out of the bundle is refused.
func unzipLink(f *zip.File, app, name, dst string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	target, err := io.ReadAll(io.LimitReader(rc, 4096))
	rc.Close()
	if err != nil {
		return err
	}
	link := string(target)
	resolved := path.Join(path.Dir(name), link)
	if path.IsAbs(link) || !filepath.IsLocal(resolved) || !strings.HasPrefix(resolved, app+"/") {
		return errors.New("the app bundle links outside of itself: " + f.Name + " -> " + link)
	}
	return os.Symlink(link, dst)
}
