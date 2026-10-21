package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReleaseKeyParses(t *testing.T) {
	if _, err := releaseKey(); err != nil {
		t.Fatal(err)
	}
}

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"1.10.0", "1.9.2", true},
		{"v0.6.0", "0.5.0", true},
		{"0.5.0", "0.5.0", false},
		{"0.5.0", "0.5.1", false},
		{"0.6", "0.5.9", true},
		{"0.7.0", "0.0.0-main.abc1234", true},
	}
	for _, c := range cases {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestDetect(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	none := env(nil)
	cases := []struct {
		name               string
		goos, goarch, exe  string
		getenv             func(string) string
		kind               Kind
		path, asset, errIs string
	}{
		{"AppImage", "linux", "amd64", "/tmp/.mount_natsXY/usr/bin/nats-explorer", env(map[string]string{"APPIMAGE": "/home/u/Apps/nats.AppImage"}),
			AppImage, "/home/u/Apps/nats.AppImage", "nats-explorer-desktop-0.7.0-linux-x64.AppImage", ""},
		{"tarball", "linux", "amd64", "/home/u/bin/nats-explorer", none,
			Tarball, "/home/u/bin/nats-explorer", "nats-explorer-desktop-0.7.0-linux-x64.tar.gz", ""},
		{".deb", "linux", "amd64", "/usr/bin/nats-explorer", none, "", "", "", "package manager"},
		{"linux arm", "linux", "arm64", "/home/u/bin/nats-explorer", none, "", "", "", "no desktop build"},
		{"windows", "windows", "amd64", `C:\Users\u\AppData\Local\Programs\NATS Explorer\NATS Explorer.exe`, none,
			Windows, `C:\Users\u\AppData\Local\Programs\NATS Explorer\NATS Explorer.exe`, "nats-explorer-desktop-0.7.0-windows-x64.zip", ""},
		{"macOS", "darwin", "arm64", "/Applications/NATS Explorer.app/Contents/MacOS/nats-explorer", none,
			MacApp, "/Applications/NATS Explorer.app", "nats-explorer-desktop-0.7.0-macos-universal.zip", ""},
		{"macOS translocated", "darwin", "arm64", "/private/var/folders/x/AppTranslocation/ABC/d/NATS Explorer.app/Contents/MacOS/nats-explorer", none,
			"", "", "", "Applications"},
		{"macOS bare binary", "darwin", "amd64", "/usr/local/bin/nats-explorer", none, "", "", "", "app bundle"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Detect(c.goos, c.goarch, c.exe, c.getenv)
			if c.errIs != "" {
				if err == nil || !strings.Contains(err.Error(), c.errIs) {
					t.Fatalf("err = %v, want one about %q", err, c.errIs)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Kind != c.kind || got.Path != c.path || got.Asset("0.7.0") != c.asset {
				t.Fatalf("got %s %q %q", got.Kind, got.Path, got.Asset("0.7.0"))
			}
		})
	}
}

func TestParseSums(t *testing.T) {
	a, b := strings.Repeat("a", 64), strings.Repeat("B", 64)
	got := parseSums([]byte(a + "  one.tar.gz\n" + b + " *two.zip\nnot a line\n"))
	if got["one.tar.gz"] != a || got["two.zip"] != strings.ToLower(b) || len(got) != 2 {
		t.Fatalf("parseSums = %v", got)
	}
}

// fakeRelease serves a GitHub release with the given files, SHA256SUMS.txt
// over them signed with key, and the release listing.
type fakeRelease struct {
	tag   string
	files map[string][]byte
	// sums overrides the checksum file; sig the signature over it.
	sums, sig []byte
}

func (f fakeRelease) serve(t *testing.T, key ed25519.PrivateKey) *httptest.Server {
	t.Helper()
	files := map[string][]byte{}
	for name, data := range f.files {
		files[name] = data
	}
	files[sumsName] = sumsOf(f.files)
	if f.sums != nil {
		files[sumsName] = f.sums
	}
	files[sigName] = ed25519.Sign(key, files[sumsName])
	if f.sig != nil {
		files[sigName] = f.sig
	}
	var ts *httptest.Server
	ts = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/latest" {
			type asset struct {
				Name string `json:"name"`
				URL  string `json:"browser_download_url"`
			}
			body := struct {
				Tag    string  `json:"tag_name"`
				Assets []asset `json:"assets"`
			}{Tag: f.tag}
			for name := range files {
				body.Assets = append(body.Assets, asset{name, ts.URL + "/download/" + name})
			}
			json.NewEncoder(w).Encode(body)
			return
		}
		data, ok := files[strings.TrimPrefix(r.URL.Path, "/download/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(data)
	}))
	t.Cleanup(ts.Close)
	return ts
}

// sumsOf is SHA256SUMS.txt over some files.
func sumsOf(files map[string][]byte) []byte {
	var sums bytes.Buffer
	for name, data := range files {
		h := sha256.Sum256(data)
		fmt.Fprintf(&sums, "%s  %s\n", hex.EncodeToString(h[:]), name)
	}
	return sums.Bytes()
}

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func testUpdater(ts *httptest.Server, pub ed25519.PublicKey, target Target) *Updater {
	return &Updater{current: "0.6.1", target: target, key: pub, api: ts.URL + "/latest", client: ts.Client(), state: Status{State: Idle}}
}

// finish starts the update and waits for it to end.
func finish(t *testing.T, u *Updater) Status {
	t.Helper()
	if _, err := u.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if s := u.Status(); s.State != Downloading {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the update did not finish")
	return Status{}
}

func tarGz(t *testing.T, name string, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(data)), Typeflag: tar.TypeReg})
	tw.Write(data)
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

type zipEntry struct {
	name, body string
	mode       os.FileMode
}

func zipOf(t *testing.T, entries ...zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		h.SetMode(e.mode)
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(e.body))
	}
	zw.Close()
	return buf.Bytes()
}

func installed(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestUpdateTarball(t *testing.T) {
	pub, priv := newKey(t)
	ts := fakeRelease{tag: "v0.7.0", files: map[string][]byte{
		"nats-explorer-desktop-0.7.0-linux-x64.tar.gz": tarGz(t, "nats-explorer", []byte("new")),
		"nats-explorer-desktop-0.7.0-windows-x64.zip":  []byte("not for this one"),
	}}.serve(t, priv)
	exe := installed(t, "nats-explorer", "old")
	target, _ := Detect("linux", "amd64", exe, func(string) string { return "" })
	u := testUpdater(ts, pub, target)

	s := finish(t, u)
	if s.State != Ready || s.Version != "0.7.0" {
		t.Fatalf("status = %+v", s)
	}
	if got := readFile(t, exe); got != "new" {
		t.Fatalf("binary = %q", got)
	}
	if st, _ := os.Stat(exe); st.Mode().Perm()&0o111 == 0 {
		t.Fatalf("the new binary is not executable: %v", st.Mode())
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), ".nats-explorer-update-*")); len(left) > 0 {
		t.Fatalf("left behind: %v", left)
	}
	if got := readFile(t, target.previous()); got != "old" {
		t.Fatalf("previous = %q", got)
	}
	if s := u.Status(); s.Previous != "0.6.1" {
		t.Fatalf("previous version = %q", s.Previous)
	}

	restarted := make(chan struct{})
	u.Restart = func() { close(restarted) }
	if err := u.RequestRestart(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-restarted:
	case <-time.After(2 * time.Second):
		t.Fatal("Restart was not called")
	}
}

func TestUpdateAppImage(t *testing.T) {
	pub, priv := newKey(t)
	ts := fakeRelease{tag: "v0.7.0", files: map[string][]byte{
		"nats-explorer-desktop-0.7.0-linux-x64.AppImage": []byte("new image"),
	}}.serve(t, priv)
	image := installed(t, "NATS.AppImage", "old image")
	target, _ := Detect("linux", "amd64", "/tmp/.mount_x/usr/bin/nats-explorer", func(k string) string {
		if k == "APPIMAGE" {
			return image
		}
		return ""
	})
	if s := finish(t, testUpdater(ts, pub, target)); s.State != Ready {
		t.Fatalf("status = %+v", s)
	}
	if got := readFile(t, image); got != "new image" {
		t.Fatalf("AppImage = %q", got)
	}
}

// The Windows path runs anywhere: rename the old .exe aside, put the new one.
func TestUpdateWindows(t *testing.T) {
	pub, priv := newKey(t)
	ts := fakeRelease{tag: "v0.7.0", files: map[string][]byte{
		"nats-explorer-desktop-0.7.0-windows-x64.zip": zipOf(t, zipEntry{"nats-explorer.exe", "new exe", 0o755}),
	}}.serve(t, priv)
	exe := installed(t, "NATS Explorer.exe", "old exe")
	target := Target{Kind: Windows, Path: exe, asset: "nats-explorer-desktop-%s-windows-x64.zip", member: "nats-explorer.exe"}
	if s := finish(t, testUpdater(ts, pub, target)); s.State != Ready {
		t.Fatalf("status = %+v", s)
	}
	if got := readFile(t, exe); got != "new exe" {
		t.Fatalf("exe = %q", got)
	}
	if got := readFile(t, exe+".previous"); got != "old exe" {
		t.Fatalf("previous exe = %q", got)
	}
}

func TestUpdateMacBundle(t *testing.T) {
	pub, priv := newKey(t)
	bundle := zipOf(t,
		zipEntry{"NATS Explorer.app/", "", os.ModeDir | 0o755},
		zipEntry{"NATS Explorer.app/Contents/Info.plist", "plist 0.7.0", 0o644},
		zipEntry{"NATS Explorer.app/Contents/MacOS/nats-explorer", "new mac", 0o755},
		zipEntry{"NATS Explorer.app/Contents/Current", "MacOS", os.ModeSymlink | 0o777},
	)
	ts := fakeRelease{tag: "v0.7.0", files: map[string][]byte{"nats-explorer-desktop-0.7.0-macos-universal.zip": bundle}}.serve(t, priv)
	apps := t.TempDir()
	app := filepath.Join(apps, "NATS Explorer.app")
	os.MkdirAll(filepath.Join(app, "Contents", "MacOS"), 0o755)
	os.WriteFile(filepath.Join(app, "Contents", "MacOS", "nats-explorer"), []byte("old mac"), 0o755)
	target, err := Detect("darwin", "arm64", filepath.Join(app, "Contents", "MacOS", "nats-explorer"), func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if s := finish(t, testUpdater(ts, pub, target)); s.State != Ready {
		t.Fatalf("status = %+v", s)
	}
	exe := filepath.Join(app, "Contents", "MacOS", "nats-explorer")
	if got := readFile(t, exe); got != "new mac" {
		t.Fatalf("binary = %q", got)
	}
	if st, _ := os.Stat(exe); st.Mode().Perm()&0o111 == 0 {
		t.Fatalf("the new binary is not executable: %v", st.Mode())
	}
	if got, _ := os.Readlink(filepath.Join(app, "Contents", "Current")); got != "MacOS" {
		t.Fatalf("link = %q", got)
	}
	if got := readFile(t, filepath.Join(target.previous(), "Contents", "MacOS", "nats-explorer")); got != "old mac" {
		t.Fatalf("previous bundle = %q", got)
	}
	var names []string
	entries, _ := os.ReadDir(apps)
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if want := []string{".NATS Explorer.app.previous", ".NATS Explorer.app.previous.version", "NATS Explorer.app"}; fmt.Sprint(names) != fmt.Sprint(want) {
		t.Fatalf("Applications holds %q, want %q", names, want)
	}
}

func TestUnzipBundleRefusesEscapes(t *testing.T) {
	for name, entries := range map[string][]zipEntry{
		"path":          {{"../NATS Explorer.app/x", "x", 0o644}},
		"absolute link": {{"NATS Explorer.app/Contents/l", "/etc", os.ModeSymlink | 0o777}},
		"relative link": {{"NATS Explorer.app/Contents/l", "../../elsewhere", os.ModeSymlink | 0o777}},
	} {
		t.Run(name, func(t *testing.T) {
			archive := filepath.Join(t.TempDir(), "a.zip")
			os.WriteFile(archive, zipOf(t, entries...), 0o644)
			if _, err := unzipBundle(archive, t.TempDir()); err == nil {
				t.Fatal("unpacked")
			}
		})
	}
}

// What is refused leaves the installed version alone.
func TestUpdateRefuses(t *testing.T) {
	asset := "nats-explorer-desktop-0.7.0-linux-x64.tar.gz"
	good := tarGz(t, "nats-explorer", []byte("new"))
	_, otherKey := newKey(t)
	cases := []struct {
		name    string
		release fakeRelease
		errIs   string
	}{
		{"signed by another key", fakeRelease{tag: "v0.7.0", files: map[string][]byte{asset: good},
			sig: ed25519.Sign(otherKey, []byte("whatever"))}, "signature"},
		{"file differs from the checksum", fakeRelease{tag: "v0.7.0", files: map[string][]byte{asset: good},
			sums: []byte(strings.Repeat("0", 64) + "  " + asset + "\n")}, "checksum"},
		{"not listed", fakeRelease{tag: "v0.7.0", files: map[string][]byte{asset: good},
			sums: []byte("")}, "do not list"},
		{"not newer", fakeRelease{tag: "v0.6.1", files: map[string][]byte{"nats-explorer-desktop-0.6.1-linux-x64.tar.gz": good}}, "newest release"},
		{"an older release passed off as the newest", fakeRelease{tag: "v0.7.0", files: map[string][]byte{"nats-explorer-desktop-0.6.0-linux-x64.tar.gz": good}}, "do not list"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pub, priv := newKey(t)
			ts := c.release.serve(t, priv)
			exe := installed(t, "nats-explorer", "old")
			u := testUpdater(ts, pub, Target{Kind: Tarball, Path: exe, asset: "nats-explorer-desktop-%s-linux-x64.tar.gz", member: "nats-explorer"})
			s := finish(t, u)
			if s.State != Failed || !strings.Contains(s.Error, c.errIs) {
				t.Fatalf("status = %+v, want a failure about %q", s, c.errIs)
			}
			if got := readFile(t, exe); got != "old" {
				t.Fatalf("binary = %q", got)
			}
			if err := u.RequestRestart(); err == nil {
				t.Fatal("restart offered without an update in place")
			}
		})
	}
}

func TestUnsupportedSaysWhy(t *testing.T) {
	u := New("dev")
	if _, err := u.Start(); err == nil {
		t.Fatal("a development build started an update")
	}
	if s := u.Status(); s.Supported || s.Reason == "" {
		t.Fatalf("status = %+v", s)
	}
}

// A release brought along without internet: the package, renamed on the way,
// with the checksums of its release and their signature.
func TestInstallFile(t *testing.T) {
	pub, priv := newKey(t)
	pkg := tarGz(t, "nats-explorer", []byte("new"))
	release := map[string][]byte{
		"nats-explorer-desktop-0.7.0-linux-x64.tar.gz": pkg,
		"nats-explorer-desktop-linux-x64.tar.gz":       pkg,
		"nats-explorer-desktop-0.7.0-windows-x64.zip":  []byte("the Windows package"),
	}
	sums := sumsOf(release)
	_, otherKey := newKey(t)
	cases := []struct {
		name      string
		pkg       []byte
		sums, sig []byte
		errIs     string
	}{
		{"in place", pkg, sums, ed25519.Sign(priv, sums), ""},
		{"signed by another key", pkg, sums, ed25519.Sign(otherKey, sums), "signature"},
		{"no signature at all", pkg, sums, []byte{}, "signature"},
		{"the package of another platform", release["nats-explorer-desktop-0.7.0-windows-x64.zip"], sums, ed25519.Sign(priv, sums),
			"nats-explorer-desktop-<version>-linux-x64.tar.gz"},
		{"a file the checksums do not list", []byte("something else"), sums, ed25519.Sign(priv, sums), "is not"},
		{"listed only under the name without a version", pkg, sumsOf(map[string][]byte{"nats-explorer-desktop-linux-x64.tar.gz": pkg}),
			nil, "is not"},
		{"not newer", pkg, sumsOf(map[string][]byte{"nats-explorer-desktop-0.6.1-linux-x64.tar.gz": pkg}), nil, "not newer"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sig := c.sig
			if sig == nil {
				sig = ed25519.Sign(priv, c.sums)
			}
			exe := installed(t, "nats-explorer", "old")
			file := filepath.Join(t.TempDir(), "Download (1).tar.gz")
			os.WriteFile(file, c.pkg, 0o644)
			u := &Updater{current: "0.6.1", key: pub, state: Status{State: Idle},
				target: Target{Kind: Tarball, Path: exe, asset: "nats-explorer-desktop-%s-linux-x64.tar.gz", member: "nats-explorer"}}
			s, err := u.InstallFile(file, c.sums, sig)
			if c.errIs == "" {
				if err != nil || s.State != Ready || s.Version != "0.7.0" {
					t.Fatalf("status = %+v, err = %v", s, err)
				}
				if got := readFile(t, exe); got != "new" {
					t.Fatalf("binary = %q", got)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.errIs) || s.State != Failed {
				t.Fatalf("status = %+v, err = %v, want a failure about %q", s, err, c.errIs)
			}
			if got := readFile(t, exe); got != "old" {
				t.Fatalf("binary = %q", got)
			}
		})
	}
}

func TestStatusNamesTheFileToBring(t *testing.T) {
	u := &Updater{current: "0.6.1", state: Status{State: Idle},
		target: Target{Kind: MacApp, Path: "/Applications/NATS Explorer.app", asset: "nats-explorer-desktop-%s-macos-universal.zip"}}
	if s := u.Status(); s.Asset != "nats-explorer-desktop-<version>-macos-universal.zip" {
		t.Fatalf("asset = %q", s.Asset)
	}
	if _, err := New("dev").InstallFile("x", nil, nil); err == nil {
		t.Fatal("a development build installed a file")
	}
}

// Going back and forth between the version in place and the one before,
// for every way the files are swapped.
func TestRollback(t *testing.T) {
	file := func(t *testing.T, kind Kind) (Target, func() string) {
		exe := installed(t, "nats-explorer", "0.7.0")
		tg := Target{Kind: kind, Path: exe}
		os.WriteFile(tg.previous(), []byte("0.6.1"), 0o755)
		return tg, func() string { return readFile(t, exe) }
	}
	bundle := func(t *testing.T, kind Kind) (Target, func() string) {
		app := filepath.Join(t.TempDir(), "NATS Explorer.app")
		tg := Target{Kind: kind, Path: app}
		for dir, content := range map[string]string{app: "0.7.0", tg.previous(): "0.6.1"} {
			os.MkdirAll(filepath.Join(dir, "Contents"), 0o755)
			os.WriteFile(filepath.Join(dir, "Contents", "v"), []byte(content), 0o644)
		}
		return tg, func() string { return readFile(t, filepath.Join(app, "Contents", "v")) }
	}
	for name, setup := range map[string]func(*testing.T, Kind) (Target, func() string){"tarball": file, "windows": file, "macos": bundle} {
		t.Run(name, func(t *testing.T) {
			tg, inPlace := setup(t, Kind(name))
			os.WriteFile(tg.previous()+".version", []byte("0.6.1\n"), 0o644)
			u := &Updater{current: "0.7.0", target: tg, previous: tg.previousVersion(), state: Status{State: Idle}}
			if s := u.Status(); s.Previous != "0.6.1" {
				t.Fatalf("previous = %q", s.Previous)
			}

			s, err := u.Rollback()
			if err != nil || s.State != Ready || s.Version != "0.6.1" || s.Previous != "0.7.0" || inPlace() != "0.6.1" {
				t.Fatalf("back: %+v, %v, in place %q", s, err, inPlace())
			}
			// And forward again, which is the running version: nothing to restart for.
			s, err = u.Rollback()
			if err != nil || s.State != Idle || s.Previous != "0.6.1" || inPlace() != "0.7.0" {
				t.Fatalf("forward: %+v, %v, in place %q", s, err, inPlace())
			}
			if left, _ := filepath.Glob(filepath.Join(filepath.Dir(tg.Path), ".nats-explorer-update-*")); len(left) > 0 {
				t.Fatalf("left behind: %v", left)
			}
		})
	}
}

// An update waiting for its restart is taken back by a rollback, and an
// installation that never was updated has nothing to go back to.
func TestRollbackOfAnUpdateInPlace(t *testing.T) {
	pub, priv := newKey(t)
	ts := fakeRelease{tag: "v0.7.0", files: map[string][]byte{
		"nats-explorer-desktop-0.7.0-linux-x64.tar.gz": tarGz(t, "nats-explorer", []byte("new")),
	}}.serve(t, priv)
	exe := installed(t, "nats-explorer", "old")
	target := Target{Kind: Tarball, Path: exe, asset: "nats-explorer-desktop-%s-linux-x64.tar.gz", member: "nats-explorer"}
	u := testUpdater(ts, pub, target)
	if _, err := u.Rollback(); err == nil {
		t.Fatal("went back to a version that is not there")
	}
	if s := finish(t, u); s.State != Ready {
		t.Fatalf("status = %+v", s)
	}
	file := filepath.Join(t.TempDir(), "pkg")
	os.WriteFile(file, []byte("x"), 0o644)
	if _, err := u.InstallFile(file, nil, nil); err == nil || !strings.Contains(err.Error(), "restart first") {
		t.Fatalf("a second update over one waiting for its restart: %v", err)
	}
	s, err := u.Rollback()
	if err != nil || s.State != Idle || s.Previous != "0.7.0" || readFile(t, exe) != "old" {
		t.Fatalf("status = %+v, %v, binary %q", s, err, readFile(t, exe))
	}
	if err := u.RequestRestart(); err == nil {
		t.Fatal("a restart offered for the version that runs")
	}
}
