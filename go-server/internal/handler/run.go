package handler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	mrand "math/rand"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/filter"
	"nats-explorer/internal/message"
)

const (
	runMaxCount       = 10_000
	runMaxConcurrency = 64
	runMaxDuration    = 120 * time.Second
	runSampleReplies  = 5
	runSampleErrors   = 5
)

// runBody describes a repeated publish or request. Subject, payload and
// header values may contain {{i}}, {{ts}}, {{uuid}} and {{rand:MIN-MAX}}.
type runBody struct {
	publishBody
	Mode        string `json:"mode"` // "publish" | "request"
	Count       int    `json:"count"`
	Concurrency int    `json:"concurrency"`
	IntervalMs  int    `json:"intervalMs"`
}

// Expect is what a run, or a single request, has to live up to: an
// expression every reply must satisfy, and a latency the replies must stay
// under. With it a saved template is a test, and a run a verdict.
type Expect struct {
	// Expr is CEL over the reply: payload, subject, headers, size.
	Expr string `json:"expr,omitempty"`
	// MaxLatencyMs bounds the p95 of a run, or the one reply of a request.
	MaxLatencyMs float64 `json:"maxLatencyMs,omitempty"`
}

// Verdict is the answer: how many were checked, how many failed, and why,
// in a few words each.
type Verdict struct {
	Passed  bool     `json:"passed"`
	Checked int      `json:"checked"`
	Failed  int      `json:"failed"`
	Reasons []string `json:"reasons,omitempty"`
}

const verdictReasons = 5

// RunSpec is a repeated send as the HTTP body or a collection file
// describes it, with the limits already applied by Normalize.
type RunSpec struct {
	Mode        string
	Subject     string
	Payload     string
	PayloadType string
	Headers     map[string][]string
	Timeout     time.Duration
	Count       int
	Concurrency int
	Interval    time.Duration
	Expect      *Expect
}

// Normalize applies the limits: a count of at least one and at most the
// maximum, a concurrency no larger than the count, a timeout and an
// interval within bounds. It answers with what a bad request would say.
func (spec *RunSpec) Normalize() error {
	if spec.Subject == "" {
		return errors.New("subject required")
	}
	if spec.Mode != "request" {
		spec.Mode = "publish"
	}
	if spec.Count < 1 {
		spec.Count = 1
	}
	if spec.Count > runMaxCount {
		return fmt.Errorf("count must be at most %d", runMaxCount)
	}
	if spec.Concurrency < 1 {
		spec.Concurrency = 1
	}
	if spec.Concurrency > runMaxConcurrency {
		spec.Concurrency = runMaxConcurrency
	}
	if spec.Concurrency > spec.Count {
		spec.Concurrency = spec.Count
	}
	if spec.Timeout <= 0 {
		spec.Timeout = 5 * time.Second
	}
	if spec.Timeout > 60*time.Second {
		spec.Timeout = 60 * time.Second
	}
	if spec.Interval < 0 {
		spec.Interval = 0
	}
	if spec.Interval > 10*time.Second {
		spec.Interval = 10 * time.Second
	}
	// An encoded payload is the same bytes for every message of the run, so
	// it is decoded once, before anything is sent: a run that cannot send is
	// a bad request, not a thousand failures.
	if spec.PayloadType == "binary" {
		if _, err := payloadBytes(spec.Payload, spec.PayloadType, 1, time.Now(), mrand.New(mrand.NewSource(1))); err != nil {
			return err
		}
	}
	if _, err := compileExpect(spec.Expect); err != nil {
		return err
	}
	return nil
}

// compileExpect readies the expression; an empty one checks nothing.
func compileExpect(e *Expect) (*filter.Program, error) {
	if e == nil || strings.TrimSpace(e.Expr) == "" {
		return nil, nil
	}
	prog, err := filter.Compile(e.Expr)
	if err != nil {
		return nil, fmt.Errorf("expect: %w", err)
	}
	return prog, nil
}

// replyMatches evaluates the expectation against one reply.
func replyMatches(prog *filter.Program, reply *nats.Msg, now time.Time) bool {
	if prog == nil {
		return true
	}
	rec := message.NewRecord(reply, 0, now.UnixMilli())
	ok, err := prog.Eval(filter.VarsOf(rec))
	return err == nil && ok
}

// judge fills the verdict from what was counted: every error, every reply
// the expression refused, a p95 over the bound, a run cut short.
func (res *RunResult) judge(spec RunSpec, mismatched int, p95 float64) {
	v := &Verdict{Checked: res.Sent}
	addReason := func(r string) {
		if len(v.Reasons) < verdictReasons {
			v.Reasons = append(v.Reasons, r)
		}
	}
	if res.Errors > 0 {
		v.Failed += res.Errors
		labels := make([]string, 0, len(res.ErrorCounts))
		for label := range res.ErrorCounts {
			labels = append(labels, label)
		}
		sort.Strings(labels)
		for _, label := range labels {
			addReason(fmt.Sprintf("%d× %s", res.ErrorCounts[label], label))
		}
	}
	if mismatched > 0 {
		v.Failed += mismatched
		addReason(fmt.Sprintf("%d of %d replies do not satisfy %s", mismatched, res.OK, spec.Expect.Expr))
	}
	if spec.Expect != nil && spec.Expect.MaxLatencyMs > 0 && res.Mode == "request" && res.OK > 0 && p95 > spec.Expect.MaxLatencyMs {
		v.Failed++
		addReason(fmt.Sprintf("p95 %.1f ms over the %.0f ms allowed", p95, spec.Expect.MaxLatencyMs))
	}
	if spec.Expect != nil && strings.TrimSpace(spec.Expect.Expr) != "" && res.Mode != "request" {
		v.Failed++
		addReason("an expression judges replies, and a publish gets none")
	}
	if res.Stopped {
		v.Failed++
		addReason("the run was stopped before it was done")
	}
	v.Passed = v.Failed == 0
	res.Verdict = v
}

type runReply struct {
	I           int     `json:"i"`
	Subject     string  `json:"subject"`
	Payload     string  `json:"payload"`
	PayloadType string  `json:"payloadType"`
	Size        int     `json:"size"`
	DurationMs  float64 `json:"durationMs"`
}

type runError struct {
	I     int    `json:"i"`
	Error string `json:"error"`
}

type latencyStats struct {
	Min float64 `json:"min"`
	Avg float64 `json:"avg"`
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
	// Histogram counts the replies per bucket, so the shape of the
	// distribution survives the summary. Le is the upper bound in ms; the
	// last bucket collects everything above it.
	Histogram []latencyBucket `json:"histogram,omitempty"`
}

// latencyBucket is one bar: how many replies were at most Le milliseconds.
type latencyBucket struct {
	Le    float64 `json:"le"`
	Count int     `json:"count"`
}

// latencyBounds are log-spaced from half a millisecond to four seconds,
// which covers a local reply and a timing out service in twelve bars.
var latencyBounds = []float64{0.5, 1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 4000}

// histogram buckets sorted latencies; the final bucket has Le 0 and means
// "slower than the last bound".
func histogram(sorted []float64) []latencyBucket {
	out := make([]latencyBucket, 0, len(latencyBounds)+1)
	i := 0
	for _, le := range latencyBounds {
		n := 0
		for i < len(sorted) && sorted[i] <= le {
			n++
			i++
		}
		out = append(out, latencyBucket{Le: le, Count: n})
	}
	if rest := len(sorted) - i; rest > 0 {
		out = append(out, latencyBucket{Count: rest})
	}
	return out
}

// RunResult is what a run reports instead of every reply.
type RunResult struct {
	Mode         string         `json:"mode"`
	Sent         int            `json:"sent"`
	OK           int            `json:"ok"`
	Errors       int            `json:"errors"`
	DurationMs   float64        `json:"durationMs"`
	PerSecond    float64        `json:"perSecond"`
	Latency      *latencyStats  `json:"latency,omitempty"`
	Replies      []runReply     `json:"replies"`
	ErrorSamples []runError     `json:"errorSamples"`
	ErrorCounts  map[string]int `json:"errorCounts"`
	Stopped      bool           `json:"stopped"`
	// Verdict is how the run did against what it was asked to live up to.
	Verdict *Verdict `json:"verdict,omitempty"`
}

// errLabel names a failure the way a single request does. A deadline on
// the context is what the reader calls a timeout, and one module must not
// have two words for the same thing: "28x context deadline exceeded" and
// "nats: timeout" were the same run against the same service.
func errLabel(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return nats.ErrTimeout.Error()
	}
	return err.Error()
}

// payloadBytes turns a body's payload into the bytes to send. A payload
// written as hex, base64 or protobuf arrives base64-encoded -- JSON cannot
// carry bytes -- and is decoded here. The placeholders are expanded only in
// text: a {{uuid}} inside an encoded message is not a placeholder, it is
// whatever those bytes happen to spell.
func payloadBytes(payload, payloadType string, i int, now time.Time, rnd *mrand.Rand) ([]byte, error) {
	if payloadType == "binary" {
		data, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			return nil, fmt.Errorf("payload is not base64: %w", err)
		}
		return data, nil
	}
	return []byte(expandTemplate(payload, i, now, rnd)), nil
}

var templateVar = regexp.MustCompile(`\{\{\s*(i|ts|uuid|rand:(-?\d+)-(-?\d+))\s*\}\}`)

// expandTemplate substitutes the run variables. i is 1-based.
func expandTemplate(s string, i int, now time.Time, rnd *mrand.Rand) string {
	if !strings.Contains(s, "{{") {
		return s
	}
	return templateVar.ReplaceAllStringFunc(s, func(m string) string {
		sub := templateVar.FindStringSubmatch(m)
		switch {
		case sub[1] == "i":
			return strconv.Itoa(i)
		case sub[1] == "ts":
			return strconv.FormatInt(now.UnixMilli(), 10)
		case sub[1] == "uuid":
			return newUUID()
		default: // rand:MIN-MAX
			lo, _ := strconv.Atoi(sub[2])
			hi, _ := strconv.Atoi(sub[3])
			if hi < lo {
				lo, hi = hi, lo
			}
			return strconv.Itoa(lo + rnd.Intn(hi-lo+1))
		}
	})
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// percentile picks the value at the nearest rank, rounded down: with ten
// samples p99 is the ninth, not an interpolation.
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(float64(len(sorted)-1) * p)
	return sorted[idx]
}

// Execute runs the spec against a connection: the workers, the timing, the
// summary and the verdict. The HTTP handler and the command line both come
// here, so a collection run in CI measures exactly what the module shows.
func Execute(ctx context.Context, nc *nats.Conn, spec RunSpec) RunResult {
	prog, _ := compileExpect(spec.Expect)
	ctx, cancel := context.WithTimeout(ctx, runMaxDuration)
	defer cancel()

	res := RunResult{Mode: spec.Mode, Replies: []runReply{}, ErrorSamples: []runError{}, ErrorCounts: map[string]int{}}
	var mu sync.Mutex
	var latencies []float64
	mismatched := 0
	jobs := make(chan int)
	var wg sync.WaitGroup
	started := time.Now()

	worker := func(seed int64) {
		defer wg.Done()
		rnd := mrand.New(mrand.NewSource(seed))
		first := true
		for i := range jobs {
			if !first && spec.Interval > 0 {
				select {
				case <-time.After(spec.Interval):
				case <-ctx.Done():
					return
				}
			}
			first = false
			now := time.Now()
			data, _ := payloadBytes(spec.Payload, spec.PayloadType, i, now, rnd)
			msg := &nats.Msg{Subject: expandTemplate(spec.Subject, i, now, rnd), Data: data}
			if len(spec.Headers) > 0 {
				msg.Header = make(nats.Header)
				for k, vals := range spec.Headers {
					for _, v := range vals {
						msg.Header.Add(k, expandTemplate(v, i, now, rnd))
					}
				}
			}

			var reply *nats.Msg
			var err error
			t0 := time.Now()
			if spec.Mode == "request" {
				reply, err = nc.RequestMsgWithContext(withTimeout(ctx, spec.Timeout), msg)
			} else {
				err = nc.PublishMsg(msg)
			}
			elapsed := float64(time.Since(t0).Microseconds()) / 1000.0

			mu.Lock()
			res.Sent++
			if err != nil {
				res.Errors++
				res.ErrorCounts[errLabel(err)]++
				if len(res.ErrorSamples) < runSampleErrors {
					res.ErrorSamples = append(res.ErrorSamples, runError{I: i, Error: errLabel(err)})
				}
			} else {
				res.OK++
				if reply != nil {
					latencies = append(latencies, elapsed)
					if !replyMatches(prog, reply, now) {
						mismatched++
					}
					if len(res.Replies) < runSampleReplies {
						payload, payloadType := message.EncodePayload(reply.Data)
						res.Replies = append(res.Replies, runReply{I: i, Subject: reply.Subject, Payload: payload, PayloadType: payloadType, Size: len(reply.Data), DurationMs: elapsed})
					}
				}
			}
			mu.Unlock()
		}
	}

	for c := 0; c < spec.Concurrency; c++ {
		wg.Add(1)
		go worker(started.UnixNano() + int64(c))
	}
feed:
	for i := 1; i <= spec.Count; i++ {
		select {
		case jobs <- i:
		case <-ctx.Done():
			res.Stopped = true
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	if spec.Mode == "publish" {
		nc.FlushTimeout(2 * time.Second)
	}

	res.DurationMs = float64(time.Since(started).Microseconds()) / 1000.0
	if res.DurationMs > 0 {
		res.PerSecond = float64(res.Sent) / (res.DurationMs / 1000.0)
	}
	var p95 float64
	if len(latencies) > 0 {
		sort.Float64s(latencies)
		var sum float64
		for _, l := range latencies {
			sum += l
		}
		p95 = percentile(latencies, 0.95)
		res.Latency = &latencyStats{
			Min: latencies[0], Avg: sum / float64(len(latencies)),
			P50: percentile(latencies, 0.50), P95: p95, P99: percentile(latencies, 0.99),
			Max: latencies[len(latencies)-1], Histogram: histogram(latencies),
		}
	}
	res.judge(spec, mismatched, p95)
	return res
}

// Run repeats a publish or request count times with the given concurrency
// and returns a summary instead of every reply.
func (h *PublishHandler) Run(w http.ResponseWriter, r *http.Request) {
	var body runBody
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.ConnID == "" {
		body.ConnID = connIDFromRequest(r)
	}
	if body.ConnID == "" {
		writeError(w, http.StatusBadRequest, "connId and subject required")
		return
	}
	spec := RunSpec{
		Mode: body.Mode, Subject: body.Subject, Payload: body.Payload, PayloadType: body.PayloadType, Headers: body.Headers,
		Timeout: time.Duration(body.Timeout) * time.Millisecond, Count: body.Count, Concurrency: body.Concurrency,
		Interval: time.Duration(body.IntervalMs) * time.Millisecond, Expect: body.Expect,
	}
	if err := spec.Normalize(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	nc, err := h.Store.GetNC(body.ConnID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, Execute(r.Context(), nc, spec))
}

// withTimeout derives a per-request context; the returned cancel is dropped
// on purpose because the request either returns or the parent expires.
func withTimeout(parent context.Context, d time.Duration) context.Context {
	ctx, cancel := context.WithTimeout(parent, d)
	go func() {
		<-ctx.Done()
		cancel()
	}()
	return ctx
}
