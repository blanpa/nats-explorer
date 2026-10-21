// Package update replaces the running desktop app with the newest release
// when the user asks for it: it fetches the release, checks the signature
// over its checksums and the checksum of the one file this installation
// needs, puts the new version where the old one is, and starts it once the
// old one has shut down.
package update

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// State is where an update stands.
type State string

const (
	Idle        State = "idle"
	Downloading State = "downloading"
	// Ready: the new version is in place and runs from the next start on.
	Ready  State = "ready"
	Failed State = "failed"
)

// Status is what the UI is told.
type Status struct {
	// Supported is false where this copy cannot replace itself; Reason says why.
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	Kind      Kind   `json:"kind,omitempty"`
	State     State  `json:"state"`
	// Version is the release being installed, or installed.
	Version string `json:"version,omitempty"`
	// Done and Total are the bytes of the download; Total is 0 while unknown.
	Done  int64  `json:"done,omitempty"`
	Total int64  `json:"total,omitempty"`
	Error string `json:"error,omitempty"`
	// Asset names the release file this installation is updated with, for
	// someone who brings it along: "<version>" stands for the version.
	Asset string `json:"asset,omitempty"`
	// Previous is the version the last update replaced, kept to go back to.
	Previous string `json:"previous,omitempty"`
}

// Updater is the one update of a running desktop app.
type Updater struct {
	current string
	target  Target
	// reason is why this copy cannot update itself; empty when it can.
	reason string
	key    ed25519.PublicKey
	api    string
	client *http.Client

	// Restart closes the app once the user asked for the new version;
	// Relaunch starts it after the old one has let go of its files.
	Restart func()

	mu       sync.Mutex
	state    Status
	relaunch bool
	// previous is the version kept next to the installation, or "".
	previous string
}

// New looks at how the running copy was installed. A development build, a
// package the system manages or a place the user cannot write to gets an
// Updater that only says why it cannot.
func New(current string) *Updater {
	u := &Updater{current: current, api: LatestURL, client: &http.Client{}, state: Status{State: Idle}}
	key, err := releaseKey()
	if err != nil {
		log.Printf("update: %v", err)
	}
	u.key = key
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	switch {
	case current == "" || current == "dev":
		u.reason = "a development build is not replaced by a release"
	case err != nil:
		u.reason = "where this copy runs from is unknown: " + err.Error()
	default:
		u.setTarget(Detect(runtime.GOOS, runtime.GOARCH, exe, os.Getenv))
	}
	if u.reason == "" {
		u.previous = u.target.previousVersion()
		go u.cleanup()
	}
	return u
}

func (u *Updater) setTarget(t Target, err error) {
	if err != nil {
		u.reason = err.Error()
		return
	}
	if err := writable(filepath.Dir(t.Path)); err != nil {
		u.reason = fmt.Sprintf("%s cannot be written to by this user", filepath.Dir(t.Path))
		return
	}
	u.target = t
}

// cleanup removes what an interrupted update left next to the
// installation. The previous version stays: it is what going back needs.
func (u *Updater) cleanup() {
	stale, _ := filepath.Glob(filepath.Join(filepath.Dir(u.target.Path), ".nats-explorer-update-*"))
	for _, p := range stale {
		os.RemoveAll(p)
	}
}

// Status is the state of the update, and whether there can be one.
func (u *Updater) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.statusLocked()
}

func (u *Updater) statusLocked() Status {
	s := u.state
	s.Supported = u.reason == ""
	s.Reason = u.reason
	s.Kind = u.target.Kind
	if s.Supported {
		s.Asset = u.target.Asset("<version>")
		s.Previous = u.previous
	}
	return s
}

// Start fetches and puts in place the newest release in the background;
// Status follows it. While one runs, or once one is in place, it does
// nothing more.
func (u *Updater) Start() (Status, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.reason != "" {
		return u.statusLocked(), errors.New(u.reason)
	}
	if u.state.State == Idle || u.state.State == Failed {
		u.state = Status{State: Downloading}
		go u.run()
	}
	return u.statusLocked(), nil
}

func (u *Updater) run() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	version, err := u.install(ctx)
	u.finish(version, err)
}

func (u *Updater) finish(version string, err error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if err != nil {
		log.Printf("update: %v", err)
		u.state = Status{State: Failed, Version: u.state.Version, Error: err.Error()}
		return
	}
	log.Printf("update: %s is in place of %s and runs from the next start", version, u.current)
	u.state = Status{State: Ready, Version: version}
	u.previous = u.target.previousVersion()
}

// InstallFile puts in place a release the user brought along, for a machine
// without internet: this installation's package, with SHA256SUMS.txt and
// SHA256SUMS.txt.sig of the same release. The checks are the download's:
// the release key signed the checksums, they list the package under this
// installation's name, and it is newer than what runs. The package is
// recognised by its checksum, so a copy that was renamed on the way is fine.
func (u *Updater) InstallFile(pkg string, sums, sig []byte) (Status, error) {
	u.mu.Lock()
	if u.reason != "" {
		defer u.mu.Unlock()
		return u.statusLocked(), errors.New(u.reason)
	}
	switch u.state.State {
	case Downloading:
		defer u.mu.Unlock()
		return u.statusLocked(), errors.New("an update is already on its way")
	case Ready:
		defer u.mu.Unlock()
		return u.statusLocked(), fmt.Errorf("%s is already in place: restart first", u.state.Version)
	}
	u.state = Status{State: Downloading}
	u.mu.Unlock()
	version, err := u.installFile(pkg, sums, sig)
	u.finish(version, err)
	return u.Status(), err
}

func (u *Updater) installFile(pkg string, sums, sig []byte) (string, error) {
	listed, err := u.verify(sums, sig, "these checksums")
	if err != nil {
		return "", err
	}
	sum, err := fileSum(pkg)
	if err != nil {
		return "", err
	}
	version := ""
	for name, s := range listed {
		if v, ok := u.target.versionOf(name); ok && s == sum {
			version = v
			break
		}
	}
	if version == "" {
		return "", fmt.Errorf("the package is not %s of the release these checksums belong to", u.target.Asset("<version>"))
	}
	if !Newer(version, u.current) {
		return "", fmt.Errorf("%s is not newer than %s, which runs here", version, u.current)
	}
	return version, u.place(pkg, version)
}

func (u *Updater) install(ctx context.Context) (string, error) {
	rel, err := u.latest(ctx)
	if err != nil {
		return "", err
	}
	if !Newer(rel.Version, u.current) {
		return "", fmt.Errorf("%s is the newest release", u.current)
	}
	u.progress(rel.Version, 0, 0)
	sums, err := u.verifiedSums(ctx, rel)
	if err != nil {
		return "", err
	}
	name := u.target.Asset(rel.Version)
	want, ok := sums[name]
	if !ok {
		return "", fmt.Errorf("the checksums of release %s do not list %s", rel.Tag, name)
	}
	url, ok := rel.Assets[name]
	if !ok {
		return "", fmt.Errorf("release %s has no %s", rel.Tag, name)
	}
	file, err := u.download(ctx, url, want, func(done, total int64) { u.progress(rel.Version, done, total) })
	if err != nil {
		return "", err
	}
	defer os.Remove(file)
	return rel.Version, u.place(file, rel.Version)
}

// place puts a verified package in place of this installation, which is
// the running version: an update waiting for its restart takes no other.
func (u *Updater) place(file, version string) error {
	if err := put(u.target, file); err != nil {
		return fmt.Errorf("putting %s in place: %w", version, err)
	}
	u.notePrevious(u.current)
	if u.target.Kind == Windows {
		setDisplayVersion(u.target.Path, version)
	}
	return nil
}

// notePrevious writes down which version is kept as the previous one.
func (u *Updater) notePrevious(version string) {
	if _, err := os.Lstat(u.target.previous()); err != nil {
		return
	}
	if err := os.WriteFile(u.target.previous()+".version", []byte(version+"\n"), 0o644); err != nil {
		log.Printf("update: the previous version cannot be noted: %v", err)
	}
}

// Rollback puts the previous version back, for a release that does not
// work out, and keeps the one it replaces as the previous in turn: a second
// Rollback goes forward again. Data stays where it is; an older version
// reads what a newer one wrote as far as it knows it. Like an update, it
// runs from the next start. Done while an update waits for its restart, it
// takes the update back and nothing is left to restart for.
func (u *Updater) Rollback() (Status, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.reason != "" {
		return u.statusLocked(), errors.New(u.reason)
	}
	if u.state.State == Downloading {
		return u.statusLocked(), errors.New("an update is on its way")
	}
	back := u.previous
	if back == "" {
		return u.statusLocked(), errors.New("no previous version is kept here")
	}
	inPlace := u.current
	if u.state.State == Ready {
		inPlace = u.state.Version
	}
	if err := swapPrevious(u.target); err != nil {
		return u.statusLocked(), fmt.Errorf("going back to %s: %w", back, err)
	}
	u.notePrevious(inPlace)
	if u.target.Kind == Windows {
		setDisplayVersion(u.target.Path, back)
	}
	u.previous = u.target.previousVersion()
	log.Printf("update: %s is in place of %s and runs from the next start", back, inPlace)
	if back == u.current {
		u.state = Status{State: Idle}
	} else {
		u.state = Status{State: Ready, Version: back}
	}
	return u.statusLocked(), nil
}

// Relaunching says whether the app closes to start another version, which
// is when it notes what it had open.
func (u *Updater) Relaunching() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.relaunch
}

func (u *Updater) progress(version string, done, total int64) {
	u.mu.Lock()
	u.state = Status{State: Downloading, Version: version, Done: done, Total: total}
	u.mu.Unlock()
}

// RequestRestart is the user's go-ahead once the new version is in place.
// The app closes a moment later, so the answer still reaches the UI.
func (u *Updater) RequestRestart() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.state.State != Ready {
		return errors.New("no update is waiting for a restart")
	}
	if u.Restart == nil {
		return errors.New("this app cannot restart itself")
	}
	u.relaunch = true
	time.AfterFunc(300*time.Millisecond, u.Restart)
	return nil
}

// Relaunch starts the new version, when a restart was asked for. The
// desktop app calls it after its window closed and the server let go of
// the history database, so the new process finds everything free.
func (u *Updater) Relaunch() error {
	u.mu.Lock()
	relaunch := u.relaunch
	u.mu.Unlock()
	if !relaunch {
		return nil
	}
	cmd := exec.Command(u.target.Path)
	if u.target.Kind == MacApp {
		// -n: a new instance, even while this one is still on its way out.
		cmd = exec.Command("open", "-n", u.target.Path)
	}
	cmd.SysProcAttr = detached()
	return cmd.Start()
}

// Newer compares versions the way the UI does (lib/updateCheck.ts): 1.10.0
// is newer than 1.9.2.
func Newer(candidate, current string) bool {
	a, b := versionParts(candidate), versionParts(current)
	for i := 0; i < max(len(a), len(b)); i++ {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// versionParts splits at dots and dashes and reads the leading digits of
// each part, as parseInt does; a part without any counts as 0.
func versionParts(v string) []int {
	parts := strings.FieldsFunc(strings.TrimPrefix(v, "v"), func(r rune) bool { return r == '.' || r == '-' })
	out := make([]int, len(parts))
	for i, p := range parts {
		end := 0
		for end < len(p) && p[end] >= '0' && p[end] <= '9' {
			end++
		}
		out[i], _ = strconv.Atoi(p[:end])
	}
	return out
}
