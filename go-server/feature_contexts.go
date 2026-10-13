package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
)

// The nats CLI keeps its connections as contexts, one JSON file each under
// ~/.config/nats/context. Someone who has them should not type them again:
// the desktop app offers them in the connection dialog, read from the
// machine it runs on. A server does not, unless NATS_CONTEXTS_DIR names a
// directory: an admin of a shared explorer must not be able to read files
// off the server by naming them in a context.

// cliContext is a context file as the nats CLI writes it; the fields that
// name files are read here, so the connection carries their content.
type cliContext struct {
	Description string `json:"description"`
	URL         string `json:"url"`
	Token       string `json:"token"`
	User        string `json:"user"`
	Password    string `json:"password"`
	Creds       string `json:"creds"`
	NKey        string `json:"nkey"`
	Cert        string `json:"cert"`
	Key         string `json:"key"`
	CA          string `json:"ca"`
	JSDomain    string `json:"jetstream_domain"`
	JSAPIPrefix string `json:"jetstream_api_prefix"`
	UserJWT     string `json:"user_jwt"`
	UserSeed    string `json:"user_seed"`
	TLSFirst    bool   `json:"tls_first"`
}

// importedContext is what the connection dialog takes: the fields of a
// saved connection, filled from the context.
type importedContext struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Servers     []string `json:"servers"`
	AuthMethod  string   `json:"authMethod"`
	Token       string   `json:"token,omitempty"`
	User        string   `json:"user,omitempty"`
	Pass        string   `json:"pass,omitempty"`
	NKeySeed    string   `json:"nkeySeed,omitempty"`
	Creds       string   `json:"creds,omitempty"`
	TLS         bool     `json:"tls,omitempty"`
	TLSCA       string   `json:"tlsCa,omitempty"`
	TLSCert     string   `json:"tlsCert,omitempty"`
	TLSKey      string   `json:"tlsKey,omitempty"`
	TLSFirst    bool     `json:"tlsFirst,omitempty"`
	JSDomain    string   `json:"jsDomain,omitempty"`
	JSAPIPrefix string   `json:"jsApiPrefix,omitempty"`
	// Problems names what could not be read: a credentials file that is
	// not there is worth saying rather than silently dropping the auth.
	Problems []string `json:"problems,omitempty"`
}

// contextsDir is where the contexts live: NATS_CONTEXTS_DIR, else the
// CLI's own place under the user's config directory.
func contextsDir() string {
	if dir := os.Getenv("NATS_CONTEXTS_DIR"); dir != "" {
		return dir
	}
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "nats", "context")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "nats", "context")
}

// contextsOffered says whether this installation reads contexts at all.
func contextsOffered(cfg serverConfig) bool {
	return cfg.mode == "desktop" || os.Getenv("NATS_CONTEXTS_DIR") != ""
}

// readContexts lists the contexts of a directory, by name.
func readContexts(dir string) ([]importedContext, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]importedContext, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var c cliContext
		if json.Unmarshal(data, &c) != nil {
			continue
		}
		out = append(out, importContext(strings.TrimSuffix(e.Name(), ".json"), c, dir))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// importContext maps one context onto a connection. Files are read
// relative to the context directory when they are not absolute, which is
// where the CLI puts a credentials file it copied in.
func importContext(name string, c cliContext, dir string) importedContext {
	out := importedContext{Name: name, Description: c.Description, AuthMethod: "none", JSDomain: c.JSDomain, JSAPIPrefix: c.JSAPIPrefix, TLSFirst: c.TLSFirst}
	url := strings.TrimSpace(c.URL)
	if url == "" {
		url = "nats://localhost:4222"
	}
	for _, s := range strings.Split(url, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out.Servers = append(out.Servers, s)
			if strings.HasPrefix(s, "tls://") || strings.HasPrefix(s, "wss://") {
				out.TLS = true
			}
		}
	}
	read := func(path, what string) string {
		if path == "" {
			return ""
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(dir, path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			out.Problems = append(out.Problems, what+": "+err.Error())
			return ""
		}
		return string(data)
	}
	switch {
	case c.Creds != "":
		if content := read(c.Creds, "credentials file"); content != "" {
			out.AuthMethod, out.Creds = "jwt", content
		}
	case c.UserJWT != "" && c.UserSeed != "":
		out.AuthMethod = "jwt"
		out.Creds = "-----BEGIN NATS USER JWT-----\n" + c.UserJWT + "\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n" + c.UserSeed + "\n------END USER NKEY SEED------\n"
	case c.NKey != "":
		if content := read(c.NKey, "nkey seed file"); content != "" {
			// A seed file may hold the seed alone or the CLI's commented form.
			for _, line := range strings.Split(content, "\n") {
				if line = strings.TrimSpace(line); strings.HasPrefix(line, "SU") {
					out.AuthMethod, out.NKeySeed = "nkey", line
					break
				}
			}
			if out.NKeySeed == "" {
				out.Problems = append(out.Problems, "nkey seed file: no seed in it")
			}
		}
	case c.Token != "":
		out.AuthMethod, out.Token = "token", c.Token
	case c.User != "":
		out.AuthMethod, out.User, out.Pass = "userpass", c.User, c.Password
	}
	if c.CA != "" {
		out.TLSCA = read(c.CA, "CA certificate")
		out.TLS = out.TLS || out.TLSCA != ""
	}
	if c.Cert != "" {
		out.TLSCert = read(c.Cert, "client certificate")
		out.TLSKey = read(c.Key, "client key")
		out.TLS = out.TLS || out.TLSCert != ""
	}
	return out
}

func init() {
	registerFeature(feature{
		name: "contexts",
		api: func(r chi.Router, d *deps) {
			r.Get("/contexts", func(w http.ResponseWriter, req *http.Request) {
				if !contextsOffered(d.cfg) {
					featureJSON(w, map[string]interface{}{"available": false, "contexts": []importedContext{}})
					return
				}
				list, err := readContexts(contextsDir())
				if err != nil {
					// No directory is no contexts, not an error: the CLI was never used here.
					if os.IsNotExist(err) {
						list = []importedContext{}
					} else {
						featureError(w, http.StatusInternalServerError, err.Error())
						return
					}
				}
				featureJSON(w, map[string]interface{}{"available": true, "dir": contextsDir(), "contexts": list})
			})
		},
	})
}
