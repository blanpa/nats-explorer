package handler

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
)

// LiveHandler serves browser-initiated subscriptions over the websocket:
// KV bucket watches and stream tails. Every watch is scoped to the client
// that asked for it and torn down when the client disconnects.
type LiveHandler struct {
	Store *connection.Store

	mu       sync.Mutex
	watchers map[any]map[string]*watch
	seq      uint64
}

type watch struct {
	id     uint64
	cancel context.CancelFunc
}

// Sender delivers an event to exactly one client.
type Sender func(event interface{})

type liveCommand struct {
	Type   string `json:"type"`
	ConnID string `json:"connId"`
	Bucket string `json:"bucket,omitempty"`
	Stream string `json:"stream,omitempty"`
	// JetStream domain override; empty uses the connection's configured domain.
	Domain string `json:"domain,omitempty"`
}

func NewLiveHandler(store *connection.Store) *LiveHandler {
	return &LiveHandler{Store: store, watchers: make(map[any]map[string]*watch)}
}

// HandleCommand parses one websocket frame from a client.
func (h *LiveHandler) HandleCommand(client any, data []byte, send Sender) {
	var cmd liveCommand
	if err := json.Unmarshal(data, &cmd); err != nil {
		return
	}
	switch cmd.Type {
	case "kv-watch":
		key := "kv:" + cmd.ConnID + ":" + cmd.Bucket
		h.start(client, key, func(ctx context.Context) { h.watchKV(ctx, cmd, send) })
	case "kv-unwatch":
		h.stop(client, "kv:"+cmd.ConnID+":"+cmd.Bucket)
	case "stream-tail":
		key := "stream:" + cmd.ConnID + ":" + cmd.Stream
		h.start(client, key, func(ctx context.Context) { h.tailStream(ctx, cmd, send) })
	case "stream-untail":
		h.stop(client, "stream:"+cmd.ConnID+":"+cmd.Stream)
	}
}

// StopAll cancels every watch of a client; called when it disconnects.
func (h *LiveHandler) StopAll(client any) {
	h.mu.Lock()
	ws := h.watchers[client]
	delete(h.watchers, client)
	h.mu.Unlock()
	for _, w := range ws {
		w.cancel()
	}
}

func (h *LiveHandler) start(client any, key string, run func(ctx context.Context)) {
	ctx, cancel := context.WithCancel(context.Background())
	h.mu.Lock()
	ws := h.watchers[client]
	if ws == nil {
		ws = make(map[string]*watch)
		h.watchers[client] = ws
	}
	if old, ok := ws[key]; ok {
		old.cancel()
	}
	h.seq++
	w := &watch{id: h.seq, cancel: cancel}
	ws[key] = w
	h.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			h.mu.Lock()
			if cur, ok := h.watchers[client][key]; ok && cur.id == w.id {
				delete(h.watchers[client], key)
			}
			h.mu.Unlock()
		}()
		run(ctx)
	}()
}

func (h *LiveHandler) stop(client any, key string) {
	h.mu.Lock()
	w, ok := h.watchers[client][key]
	if ok {
		delete(h.watchers[client], key)
	}
	h.mu.Unlock()
	if ok {
		w.cancel()
	}
}

func (h *LiveHandler) sendError(send Sender, cmd liveCommand, err error) {
	send(map[string]interface{}{
		"type":   "live-error",
		"connId": cmd.ConnID,
		"bucket": cmd.Bucket,
		"stream": cmd.Stream,
		"error":  err.Error(),
	})
}

func (h *LiveHandler) watchKV(ctx context.Context, cmd liveCommand, send Sender) {
	js, err := jetStreamForConn(h.Store, cmd.ConnID, cmd.Domain)
	if err != nil {
		h.sendError(send, cmd, err)
		return
	}
	octx, ocancel := context.WithTimeout(ctx, 10*time.Second)
	kv, err := js.KeyValue(octx, cmd.Bucket)
	ocancel()
	if err != nil {
		h.sendError(send, cmd, err)
		return
	}
	w, err := kv.WatchAll(ctx, jetstream.UpdatesOnly())
	if err != nil {
		h.sendError(send, cmd, err)
		return
	}
	defer w.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case e, ok := <-w.Updates():
			if !ok {
				return
			}
			if e == nil {
				continue
			}
			send(map[string]interface{}{
				"type":   "kv-update",
				"connId": cmd.ConnID,
				"bucket": cmd.Bucket,
				"entry":  KvEntryToMap(cmd.Bucket, e),
			})
		}
	}
}

func (h *LiveHandler) tailStream(ctx context.Context, cmd liveCommand, send Sender) {
	js, err := jetStreamForConn(h.Store, cmd.ConnID, cmd.Domain)
	if err != nil {
		h.sendError(send, cmd, err)
		return
	}
	octx, ocancel := context.WithTimeout(ctx, 10*time.Second)
	oc, err := js.OrderedConsumer(octx, cmd.Stream, jetstream.OrderedConsumerConfig{
		DeliverPolicy:     jetstream.DeliverNewPolicy,
		InactiveThreshold: 30 * time.Second,
	})
	ocancel()
	if err != nil {
		h.sendError(send, cmd, err)
		return
	}
	defer func() {
		if ci := oc.CachedInfo(); ci != nil {
			dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
			js.DeleteConsumer(dctx, cmd.Stream, ci.Name)
			dcancel()
		}
	}()

	cc, err := oc.Consume(func(msg jetstream.Msg) {
		item, _ := StreamMsgToMap(msg)
		send(map[string]interface{}{
			"type":    "stream-msg",
			"connId":  cmd.ConnID,
			"stream":  cmd.Stream,
			"message": item,
		})
	}, jetstream.ConsumeErrHandler(func(_ jetstream.ConsumeContext, err error) {
		if ctx.Err() == nil {
			log.Printf("stream tail %s/%s: %v", cmd.ConnID, cmd.Stream, err)
		}
	}))
	if err != nil {
		h.sendError(send, cmd, err)
		return
	}
	defer cc.Stop()

	<-ctx.Done()
}
