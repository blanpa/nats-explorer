//go:build !desktop

package main

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"nats-explorer/internal/auth"
	"nats-explorer/internal/history"
	"nats-explorer/internal/settings"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		hashPassword(os.Args[2:])
		return
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3002"
	}

	publicPath := os.Getenv("PUBLIC_PATH")
	if publicPath == "" {
		// Release archives ship the UI as public/ next to the binary; a source
		// checkout has it in client/dist.
		exe, _ := os.Executable()
		for _, candidate := range []string{filepath.Join(filepath.Dir(exe), "public"), filepath.Join(filepath.Dir(exe), "..", "client", "dist")} {
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				publicPath = candidate
				break
			}
		}
	}

	var staticFS fs.FS
	if info, err := os.Stat(publicPath); err == nil && info.IsDir() {
		staticFS = os.DirFS(publicPath)
		log.Printf("Serving static files from %s", publicPath)
	}

	authToken := os.Getenv("AUTH_TOKEN")
	if authToken != "" {
		log.Printf("API token authentication enabled")
	}
	cfg := serverConfig{authToken: authToken, mode: "server", autoConnect: true}
	// AUTH_USERS names a file of name:role:bcrypt-hash lines; with it the UI
	// asks for a login and viewers get a read-only explorer.
	if path := os.Getenv("AUTH_USERS"); path != "" {
		users, err := auth.LoadUsers(path)
		if err != nil {
			log.Fatalf("AUTH_USERS: %v", err)
		}
		cfg.users = users
		log.Printf("User authentication enabled (%d accounts)", len(users))
	}
	// HISTORY_MB bounds the in-memory message history the UI pulls from. The
	// GC gets a soft limit of twice that plus headroom, so the process stays
	// near the budget instead of letting the heap grow to twice its live size.
	cfg.historyBytes = history.DefaultMaxBytes
	if mb, err := strconv.Atoi(os.Getenv("HISTORY_MB")); err == nil && mb > 0 {
		cfg.historyBytes = mb << 20
	}
	debug.SetMemoryLimit(int64(cfg.historyBytes)*2 + 128<<20)
	cfg.pprof = os.Getenv("PPROF") != ""
	// HISTORY_DB keeps a copy of every message in SQLite, HISTORY_RETENTION
	// (a Go duration, default 72h) bounds how far back it reaches.
	if path := os.Getenv("HISTORY_DB"); path != "" {
		cfg.historyDB = path
		cfg.historyRetention = 72 * time.Hour
		if r := os.Getenv("HISTORY_RETENTION"); r != "" {
			d, err := time.ParseDuration(r)
			if err != nil || d <= 0 {
				log.Fatalf("HISTORY_RETENTION: %q is not a duration", r)
			}
			cfg.historyRetention = d
		}
	}
	// STORAGE_DIR turns a single-user server into a persistent installation:
	// connections and templates live there instead of in the browser.
	if dir := os.Getenv("STORAGE_DIR"); dir != "" {
		store, err := settings.Open(dir, settings.NewSecretStore(dir, os.Getenv("NO_KEYRING") == ""))
		if err != nil {
			log.Fatalf("settings: %v", err)
		}
		log.Printf("UI settings stored in %s (secrets: %s)", store.Path(), store.SecretsName())
		cfg.settings = store
	}
	app := createServer(staticFS, cfg)
	defer app.Close()

	// A signal closes the listener first and the server afterwards, so the
	// persistent history flushes its last batch instead of being killed
	// mid-write.
	srv := &http.Server{Addr: fmt.Sprintf(":%s", port), Handler: app}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		log.Printf("shutting down")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	log.Printf("NATS Explorer running on http://localhost:%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// hashPassword prints a users-file hash for `nats-explorer hash-password
// [password]`; without an argument the password is read from stdin.
func hashPassword(args []string) {
	var password string
	if len(args) > 0 {
		password = args[0]
	} else {
		fmt.Fprint(os.Stderr, "Password: ")
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			log.Fatalf("read password: %v", err)
		}
		password = strings.TrimRight(line, "\r\n")
	}
	if password == "" {
		log.Fatal("empty password")
	}
	h, err := auth.HashPassword(password)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(h)
}
