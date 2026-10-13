//go:build !desktop

package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/handler"
)

// `nats-explorer run collection.json`: the request templates the Requests
// module exports, run from a terminal and judged, so the same checks a
// debugger clicks through can fail a build. Every template is sent the way
// the module sends it -- the same executor, the same verdict -- and the
// exit code is 1 as soon as one of them fails.

// collectionItem is one template of the export file (shared/src and
// client/src/lib/savedRequests.ts write it).
type collectionItem struct {
	Name        string                        `json:"name"`
	Mode        string                        `json:"mode"`
	Subject     string                        `json:"subject"`
	Payload     string                        `json:"payload"`
	Format      string                        `json:"format"`
	Headers     []struct{ Key, Value string } `json:"headers"`
	Timeout     int                           `json:"timeout"`
	Count       int                           `json:"count"`
	Concurrency int                           `json:"concurrency"`
	IntervalMs  int                           `json:"intervalMs"`
	Expect      *handler.Expect               `json:"expect"`
}

// runOutcome is one line of the report, and one entry of the JSON file.
type runOutcome struct {
	Name   string            `json:"name"`
	Result handler.RunResult `json:"result"`
	Error  string            `json:"error,omitempty"`
}

func runCollection(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	server := fs.String("server", envOr("NATS_URL", nats.DefaultURL), "NATS server URL(s), comma separated (NATS_URL)")
	user := fs.String("user", os.Getenv("NATS_USER"), "user name (NATS_USER)")
	password := fs.String("password", os.Getenv("NATS_PASSWORD"), "password (NATS_PASSWORD)")
	token := fs.String("token", os.Getenv("NATS_TOKEN"), "token (NATS_TOKEN)")
	creds := fs.String("creds", os.Getenv("NATS_CREDS"), "credentials file (NATS_CREDS)")
	nkey := fs.String("nkey", os.Getenv("NATS_NKEY"), "NKey seed file (NATS_NKEY)")
	tlsCA := fs.String("tls-ca", os.Getenv("NATS_CA"), "CA certificate file (NATS_CA)")
	tlsCert := fs.String("tls-cert", os.Getenv("NATS_CERT"), "client certificate file (NATS_CERT)")
	tlsKey := fs.String("tls-key", os.Getenv("NATS_KEY"), "client key file (NATS_KEY)")
	only := fs.String("only", "", "run only the templates whose name contains this")
	jsonOut := fs.String("json", "", "write every result as JSON to this file ('-' for stdout)")
	quiet := fs.Bool("quiet", false, "print only the failures")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: nats-explorer run [flags] collection.json\n\nRuns the request templates of a collection exported from the Requests module and judges each one. Exit code 1 when a template fails.\n\n")
		fs.PrintDefaults()
	}
	fs.Parse(args)
	if fs.NArg() != 1 {
		fs.Usage()
		os.Exit(2)
	}
	items, err := loadCollection(fs.Arg(0))
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", fs.Arg(0), err)
		os.Exit(2)
	}
	if *only != "" {
		kept := items[:0]
		for _, it := range items {
			if strings.Contains(strings.ToLower(it.Name), strings.ToLower(*only)) {
				kept = append(kept, it)
			}
		}
		items = kept
	}
	if len(items) == 0 {
		fmt.Fprintln(os.Stderr, "nothing to run")
		os.Exit(2)
	}

	opts := []nats.Option{nats.Name("nats-explorer run"), nats.Timeout(10 * time.Second)}
	switch {
	case *creds != "":
		opts = append(opts, nats.UserCredentials(*creds))
	case *nkey != "":
		opt, err := nats.NkeyOptionFromSeed(*nkey)
		if err != nil {
			fmt.Fprintf(os.Stderr, "nkey: %v\n", err)
			os.Exit(2)
		}
		opts = append(opts, opt)
	case *token != "":
		opts = append(opts, nats.Token(*token))
	case *user != "":
		opts = append(opts, nats.UserInfo(*user, *password))
	}
	if *tlsCA != "" {
		opts = append(opts, nats.RootCAs(*tlsCA))
	}
	if *tlsCert != "" {
		opts = append(opts, nats.ClientCert(*tlsCert, *tlsKey))
	}
	nc, err := nats.Connect(*server, opts...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect %s: %v\n", *server, err)
		os.Exit(2)
	}
	defer nc.Close()

	outcomes, failed := executeCollection(context.Background(), nc, items, func(o runOutcome) {
		if *quiet && o.Error == "" && o.Result.Verdict != nil && o.Result.Verdict.Passed {
			return
		}
		fmt.Println(formatOutcome(o))
	})
	if *jsonOut != "" {
		data, _ := json.MarshalIndent(outcomes, "", "  ")
		if *jsonOut == "-" {
			os.Stdout.Write(append(data, '\n'))
		} else if err := os.WriteFile(*jsonOut, data, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", *jsonOut, err)
			os.Exit(2)
		}
	}
	fmt.Printf("%d of %d passed\n", len(outcomes)-failed, len(outcomes))
	if failed > 0 {
		os.Exit(1)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// loadCollection reads the export envelope, or a bare list of templates.
func loadCollection(path string) ([]collectionItem, error) {
	var r io.Reader
	if path == "-" {
		r = os.Stdin
	} else {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = f
	}
	data, err := io.ReadAll(io.LimitReader(r, 64<<20))
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Items []collectionItem `json:"items"`
	}
	if err := json.Unmarshal(data, &envelope); err == nil && envelope.Items != nil {
		return envelope.Items, nil
	}
	var list []collectionItem
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, errors.New("not a collection: expected {\"items\": [...]} or a list of templates")
	}
	return list, nil
}

// specOf turns a template into what the executor runs. Hex and base64
// payloads become bytes here, as the browser makes them; a protobuf
// payload needs the browser's decoder rules and is refused.
func specOf(it collectionItem) (handler.RunSpec, error) {
	spec := handler.RunSpec{
		Mode: it.Mode, Subject: strings.TrimSpace(it.Subject), Payload: it.Payload,
		Timeout: time.Duration(it.Timeout) * time.Millisecond, Count: it.Count, Concurrency: it.Concurrency,
		Interval: time.Duration(it.IntervalMs) * time.Millisecond, Expect: it.Expect,
	}
	switch it.Format {
	case "hex":
		clean := strings.NewReplacer(" ", "", "\n", "", "\t", "", ":", "", "0x", "").Replace(it.Payload)
		b, err := hex.DecodeString(clean)
		if err != nil {
			return spec, fmt.Errorf("hex payload: %w", err)
		}
		spec.Payload, spec.PayloadType = base64.StdEncoding.EncodeToString(b), "binary"
	case "base64":
		clean := strings.Join(strings.Fields(it.Payload), "")
		if _, err := base64.StdEncoding.DecodeString(clean); err != nil {
			return spec, fmt.Errorf("base64 payload: %w", err)
		}
		spec.Payload, spec.PayloadType = clean, "binary"
	case "protobuf":
		return spec, errors.New("a protobuf payload is encoded with the browser's decoder rules; run it from the module")
	}
	if len(it.Headers) > 0 {
		spec.Headers = map[string][]string{}
		for _, h := range it.Headers {
			if k := strings.TrimSpace(h.Key); k != "" {
				spec.Headers[k] = append(spec.Headers[k], h.Value)
			}
		}
	}
	return spec, spec.Normalize()
}

// executeCollection runs the templates one after the other and reports
// each as it finishes; it returns them all and how many failed.
func executeCollection(ctx context.Context, nc *nats.Conn, items []collectionItem, report func(runOutcome)) ([]runOutcome, int) {
	outcomes := make([]runOutcome, 0, len(items))
	failed := 0
	for i, it := range items {
		name := it.Name
		if name == "" {
			name = fmt.Sprintf("#%d %s", i+1, it.Subject)
		}
		o := runOutcome{Name: name}
		spec, err := specOf(it)
		if err != nil {
			o.Error = err.Error()
			failed++
		} else {
			o.Result = handler.Execute(ctx, nc, spec)
			if o.Result.Verdict == nil || !o.Result.Verdict.Passed {
				failed++
			}
		}
		report(o)
		outcomes = append(outcomes, o)
	}
	return outcomes, failed
}

// formatOutcome is one line: PASS or FAIL, the name, the counts, the p95
// where there is one, and the reasons.
func formatOutcome(o runOutcome) string {
	if o.Error != "" {
		return fmt.Sprintf("FAIL  %-32s %s", o.Name, o.Error)
	}
	r := o.Result
	status := "PASS"
	if r.Verdict == nil || !r.Verdict.Passed {
		status = "FAIL"
	}
	line := fmt.Sprintf("%s  %-32s %d sent, %d ok, %d errors", status, o.Name, r.Sent, r.OK, r.Errors)
	if r.Latency != nil {
		line += fmt.Sprintf(", p95 %.1f ms", r.Latency.P95)
	}
	if r.Verdict != nil && len(r.Verdict.Reasons) > 0 {
		line += "\n      " + strings.Join(r.Verdict.Reasons, "\n      ")
	}
	return line
}
