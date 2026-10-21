package main

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"nats-explorer/internal/update"
)

// The desktop app replaces itself with the newest release when the user
// asks: the status bar offers it next to the hint that one is out. A
// server, a container or a .deb package is updated by whoever installed it,
// and the answer says so.

func init() {
	registerFeature(feature{
		name: "update",
		api: func(r chi.Router, d *deps) {
			u := d.cfg.updater
			r.Get("/update", func(w http.ResponseWriter, req *http.Request) {
				if u == nil {
					featureJSON(w, update.Status{State: update.Idle, Reason: "a server is updated by whoever runs it"})
					return
				}
				featureJSON(w, u.Status())
			})
			r.Post("/update", func(w http.ResponseWriter, req *http.Request) {
				if !updateAllowed(w, req, u) {
					return
				}
				s, err := u.Start()
				if err != nil {
					featureError(w, http.StatusConflict, err.Error())
					return
				}
				featureJSON(w, s)
			})
			// A release brought along, for a machine without internet.
			r.Post("/update/file", func(w http.ResponseWriter, req *http.Request) {
				if !updateAllowed(w, req, u) {
					return
				}
				req.Body = http.MaxBytesReader(w, req.Body, maxUpdateUpload)
				pkg, sums, sig, err := readUpdateFiles(req)
				if pkg != "" {
					defer os.Remove(pkg)
				}
				if err != nil {
					featureError(w, http.StatusBadRequest, err.Error())
					return
				}
				s, err := u.InstallFile(pkg, sums, sig)
				if err != nil {
					featureError(w, http.StatusUnprocessableEntity, err.Error())
					return
				}
				featureJSON(w, s)
			})
			// The version the last update replaced, back in place.
			r.Post("/update/rollback", func(w http.ResponseWriter, req *http.Request) {
				if !updateAllowed(w, req, u) {
					return
				}
				s, err := u.Rollback()
				if err != nil {
					featureError(w, http.StatusConflict, err.Error())
					return
				}
				featureJSON(w, s)
			})
			r.Post("/update/restart", func(w http.ResponseWriter, req *http.Request) {
				if !updateAllowed(w, req, u) {
					return
				}
				if err := u.RequestRestart(); err != nil {
					featureError(w, http.StatusConflict, err.Error())
					return
				}
				featureJSON(w, map[string]bool{"ok": true})
			})
		},
	})
}

// updateAllowed answers a write that does not get to start an update: on a
// server there is none, and a web page of another origin does not get to
// replace the app, which listens on loopback without a login.
func updateAllowed(w http.ResponseWriter, req *http.Request, u *update.Updater) bool {
	if u == nil {
		featureError(w, http.StatusNotFound, "a server is updated by whoever runs it")
		return false
	}
	if origin := req.Header.Get("Origin"); origin != "" {
		o, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(o.Host, req.Host) {
			featureError(w, http.StatusForbidden, "an update is started from the app itself")
			return false
		}
	}
	return true
}

// maxUpdateUpload bounds what the upload of a release takes in; the
// largest desktop package is ~30 MB.
const maxUpdateUpload = 600 << 20

// readUpdateFiles takes an upload of a release apart, by the names the
// release gives its files: the signature (.sig), the checksums (.txt) and
// the one package, which goes to a temporary file. A browser that renamed a
// second download to "SHA256SUMS (1).txt" keeps the suffix, which is all
// that counts.
func readUpdateFiles(req *http.Request) (pkg string, sums, sig []byte, err error) {
	mr, err := req.MultipartReader()
	if err != nil {
		return "", nil, nil, errors.New("expected the files of the release as multipart/form-data")
	}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return pkg, nil, nil, err
		}
		name := strings.ToLower(part.FileName())
		switch {
		case name == "":
		case strings.HasSuffix(name, ".sig"):
			sig, err = io.ReadAll(io.LimitReader(part, 1<<10))
		case strings.HasSuffix(name, ".txt"):
			sums, err = io.ReadAll(io.LimitReader(part, 1<<20))
		case pkg != "":
			err = errors.New("choose one package, not several")
		default:
			pkg, err = saveUpload(part)
		}
		part.Close()
		if err != nil {
			return pkg, nil, nil, err
		}
	}
	switch {
	case pkg == "":
		return "", nil, nil, errors.New("the package of the release is missing")
	case sums == nil:
		return pkg, nil, nil, errors.New("SHA256SUMS.txt of the release is missing")
	case sig == nil:
		return pkg, nil, nil, errors.New("SHA256SUMS.txt.sig of the release is missing")
	}
	return pkg, sums, sig, nil
}

func saveUpload(r io.Reader) (string, error) {
	f, err := os.CreateTemp("", "nats-explorer-upload-*")
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}
