package handler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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

type runResult struct {
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
	if body.ConnID == "" || body.Subject == "" {
		writeError(w, http.StatusBadRequest, "connId and subject required")
		return
	}
	if body.Mode != "request" {
		body.Mode = "publish"
	}
	if body.Count < 1 {
		body.Count = 1
	}
	if body.Count > runMaxCount {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("count must be at most %d", runMaxCount))
		return
	}
	if body.Concurrency < 1 {
		body.Concurrency = 1
	}
	if body.Concurrency > runMaxConcurrency {
		body.Concurrency = runMaxConcurrency
	}
	if body.Concurrency > body.Count {
		body.Concurrency = body.Count
	}
	timeout := time.Duration(body.Timeout) * time.Millisecond
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if timeout > 60*time.Second {
		timeout = 60 * time.Second
	}
	interval := time.Duration(body.IntervalMs) * time.Millisecond
	if interval < 0 {
		interval = 0
	}
	if interval > 10*time.Second {
		interval = 10 * time.Second
	}

	nc, err := h.Store.GetNC(body.ConnID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), runMaxDuration)
	defer cancel()

	res := runResult{Mode: body.Mode, Replies: []runReply{}, ErrorSamples: []runError{}, ErrorCounts: map[string]int{}}
	var mu sync.Mutex
	var latencies []float64
	jobs := make(chan int)
	var wg sync.WaitGroup
	started := time.Now()

	worker := func(seed int64) {
		defer wg.Done()
		rnd := mrand.New(mrand.NewSource(seed))
		first := true
		for i := range jobs {
			if !first && interval > 0 {
				select {
				case <-time.After(interval):
				case <-ctx.Done():
					return
				}
			}
			first = false
			now := time.Now()
			msg := &nats.Msg{Subject: expandTemplate(body.Subject, i, now, rnd), Data: []byte(expandTemplate(body.Payload, i, now, rnd))}
			if len(body.Headers) > 0 {
				msg.Header = make(nats.Header)
				for k, vals := range body.Headers {
					for _, v := range vals {
						msg.Header.Add(k, expandTemplate(v, i, now, rnd))
					}
				}
			}

			var reply *nats.Msg
			var err error
			t0 := time.Now()
			if body.Mode == "request" {
				reply, err = nc.RequestMsgWithContext(withTimeout(ctx, timeout), msg)
			} else {
				err = nc.PublishMsg(msg)
			}
			elapsed := float64(time.Since(t0).Microseconds()) / 1000.0

			mu.Lock()
			res.Sent++
			if err != nil {
				res.Errors++
				res.ErrorCounts[err.Error()]++
				if len(res.ErrorSamples) < runSampleErrors {
					res.ErrorSamples = append(res.ErrorSamples, runError{I: i, Error: err.Error()})
				}
			} else {
				res.OK++
				if reply != nil {
					latencies = append(latencies, elapsed)
					if len(res.Replies) < runSampleReplies {
						payload, payloadType := message.EncodePayload(reply.Data)
						res.Replies = append(res.Replies, runReply{I: i, Subject: reply.Subject, Payload: payload, PayloadType: payloadType, Size: len(reply.Data), DurationMs: elapsed})
					}
				}
			}
			mu.Unlock()
		}
	}

	for c := 0; c < body.Concurrency; c++ {
		wg.Add(1)
		go worker(started.UnixNano() + int64(c))
	}
feed:
	for i := 1; i <= body.Count; i++ {
		select {
		case jobs <- i:
		case <-ctx.Done():
			res.Stopped = true
			break feed
		}
	}
	close(jobs)
	wg.Wait()

	if body.Mode == "publish" {
		if err := nc.FlushTimeout(5 * time.Second); err != nil {
			res.ErrorCounts["flush: "+err.Error()]++
		}
	}
	res.DurationMs = float64(time.Since(started).Microseconds()) / 1000.0
	if res.DurationMs > 0 {
		res.PerSecond = float64(res.Sent) / (res.DurationMs / 1000.0)
	}
	if len(latencies) > 0 {
		sort.Float64s(latencies)
		sum := 0.0
		for _, l := range latencies {
			sum += l
		}
		res.Latency = &latencyStats{
			Min:       latencies[0],
			Avg:       sum / float64(len(latencies)),
			P50:       percentile(latencies, 0.5),
			P95:       percentile(latencies, 0.95),
			P99:       percentile(latencies, 0.99),
			Max:       latencies[len(latencies)-1],
			Histogram: histogram(latencies),
		}
	}
	writeJSON(w, res)
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
