package handler

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"nats-explorer/internal/connection"
)

// What a stream needs beyond create, read, update and delete: its
// configuration the way the nats CLI reads it, sealing, a backup that the
// CLI could restore as well, a restore of such a backup, the last message
// on a subject, and a page of messages narrowed to a subject.

// Config answers GET /api/streams/{name}/config with the configuration in
// the server's own JSON -- `nats stream add --config` reads exactly this.
func (h *StreamsHandler) Config(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	s, err := js.Stream(ctx, urlParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, info.Config)
}

// Seal answers POST /api/streams/{name}/seal. A sealed stream takes no
// more messages and loses none; there is no way back, which is why it is
// its own call rather than a checkbox.
func (h *StreamsHandler) Seal(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	s, err := js.Stream(ctx, urlParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	cfg := info.Config
	cfg.Sealed = true
	updated, err := js.UpdateStream(ctx, cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	ui, err := updated.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, streamInfoToMap(ui))
}

// LastMessage answers GET /api/streams/{name}/last?subject=…: the newest
// message on a subject, wildcards included, straight from the stream.
func (h *StreamsHandler) LastMessage(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	subject := strings.TrimSpace(r.URL.Query().Get("subject"))
	if subject == "" {
		writeError(w, http.StatusBadRequest, "subject required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	s, err := js.Stream(ctx, urlParam(r, "name"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	msg, err := s.GetLastMsgForSubject(ctx, subject)
	if err != nil {
		if errors.Is(err, jetstream.ErrMsgNotFound) {
			writeError(w, http.StatusNotFound, "no message on "+subject)
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, rawStreamMsgToMap(msg))
}

// The widest a scan for the newest matching messages goes before it gives
// up and starts at the first sequence: a filter on a rare subject in a
// busy stream has its matches far apart.
const filteredScanCap = 50_000

// filteredMessages is the page of GET /api/streams/{name}/messages with a
// subject. The server does the skipping -- an ordered consumer with the
// filter delivers only what matches -- so a page is the next `limit`
// matches from startSeq. Without a startSeq the newest matches are wanted,
// and a consumer cannot run backwards: the scan starts a span before the
// end and widens until it has a page or reaches the first sequence.
func (h *StreamsHandler) filteredMessages(w http.ResponseWriter, ctx context.Context, js jetstream.JetStream, name string, info *jetstream.StreamInfo, subject string, startSeq uint64, limit int) {
	first, last := info.State.FirstSeq, info.State.LastSeq
	empty := func() {
		writeJSON(w, map[string]interface{}{
			"messages": []map[string]interface{}{}, "total": info.State.Msgs, "firstSeq": first, "lastSeq": last,
			"pageStart": 0, "pageEnd": 0, "subject": subject,
		})
	}
	if info.State.Msgs == 0 || last == 0 {
		empty()
		return
	}
	var page []map[string]interface{}
	var err error
	pageStart := startSeq
	if startSeq == 0 {
		span := uint64(limit) * 20
		for {
			from := first
			if last > span && last-span > first {
				from = last - span
			}
			page, err = fetchFiltered(ctx, js, name, subject, from, last, filteredScanCap)
			if err != nil {
				writeError(w, http.StatusBadGateway, err.Error())
				return
			}
			if len(page) >= limit || from == first {
				break
			}
			span *= 20
		}
		if len(page) > limit {
			page = page[len(page)-limit:]
		}
		if len(page) > 0 {
			pageStart, _ = page[0]["seq"].(uint64)
		}
	} else {
		if startSeq < first {
			pageStart = first
		}
		page, err = fetchFiltered(ctx, js, name, subject, pageStart, last, limit)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
	}
	if len(page) == 0 {
		empty()
		return
	}
	// A page shorter than asked for ran to the end of the stream: there is
	// nothing newer to page to.
	pageEnd := last
	if len(page) >= limit {
		pageEnd, _ = page[len(page)-1]["seq"].(uint64)
	}
	writeJSON(w, map[string]interface{}{
		"messages": page, "total": info.State.Msgs, "firstSeq": first, "lastSeq": last,
		"pageStart": pageStart, "pageEnd": pageEnd, "subject": subject,
	})
}

// fetchFiltered reads up to max matching messages from startSeq to end.
func fetchFiltered(ctx context.Context, js jetstream.JetStream, stream, subject string, startSeq, end uint64, max int) ([]map[string]interface{}, error) {
	oc, err := js.OrderedConsumer(ctx, stream, jetstream.OrderedConsumerConfig{
		FilterSubjects:    []string{subject},
		DeliverPolicy:     jetstream.DeliverByStartSequencePolicy,
		OptStartSeq:       startSeq,
		InactiveThreshold: 5 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	defer func() {
		if ci := oc.CachedInfo(); ci != nil {
			dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Second)
			js.DeleteConsumer(dctx, stream, ci.Name)
			dcancel()
		}
	}()
	out := make([]map[string]interface{}, 0, min(max, 256))
	next := startSeq
	for len(out) < max {
		want := max - len(out)
		if want > 500 {
			want = 500
		}
		batch, err := oc.FetchNoWait(want)
		if err != nil {
			return nil, err
		}
		added := 0
		for msg := range batch.Messages() {
			item, seq := StreamMsgToMap(msg)
			if seq > end {
				return out, nil
			}
			if seq < next {
				continue
			}
			out = append(out, item)
			next = seq + 1
			added++
		}
		if batch.Error() != nil {
			return nil, batch.Error()
		}
		if added == 0 {
			break
		}
	}
	return out, nil
}

// jsAPIFor is the raw API prefix of the request's connection, for the
// calls the client library has no method for. It follows the same choice
// as jetStreamFor: a domain from the query, else the connection's prefix
// or domain, else the default.
func jsAPIFor(store *connection.Store, r *http.Request) (*nats.Conn, string, error) {
	m, ok := store.Get(connIDFromRequest(r))
	if !ok || m.NC == nil {
		return nil, "", fmt.Errorf("connection not found")
	}
	if !m.NC.IsConnected() {
		return nil, "", fmt.Errorf("not connected")
	}
	domain := strings.TrimSpace(r.URL.Query().Get("domain"))
	switch {
	case domain != "":
		return m.NC, "$JS." + domain + ".API", nil
	case m.Config.JSAPIPrefix != "":
		return m.NC, strings.TrimSuffix(m.Config.JSAPIPrefix, "."), nil
	case m.Config.JSDomain != "":
		return m.NC, "$JS." + m.Config.JSDomain + ".API", nil
	default:
		return m.NC, "$JS.API", nil
	}
}

// apiError reads the error of a JetStream API answer, or nil.
func apiError(data []byte) error {
	var resp struct {
		Error *struct {
			Code        int    `json:"code"`
			ErrCode     int    `json:"err_code"`
			Description string `json:"description"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &resp) != nil || resp.Error == nil {
		return nil
	}
	return fmt.Errorf("%s (%d)", resp.Error.Description, resp.Error.Code)
}

const (
	// The names the nats CLI writes and reads, so a backup unzips into a
	// directory `nats stream restore` accepts as it is.
	backupMetaFile       = "backup.json"
	backupDataFile       = "stream.arc.s2"
	backupLegacyDataFile = "stream.tar.s2"
	backupChunk          = 128 * 1024
	restoreChunk         = 64 * 1024
	// restoreMaxBytes bounds an upload; a snapshot is the stream's storage,
	// so it can be large.
	restoreMaxBytes = 8 << 30
)

// backupDataName picks the archive name by the server's version: servers
// from 2.15 send their own archive format, older ones a tar.
func backupDataName(version string) string {
	parts := strings.SplitN(strings.TrimPrefix(version, "v"), ".", 3)
	if len(parts) >= 2 {
		major, _ := strconv.Atoi(parts[0])
		minor, _ := strconv.Atoi(parts[1])
		if major > 2 || (major == 2 && minor >= 15) {
			return backupDataFile
		}
	}
	return backupLegacyDataFile
}

// Backup answers GET /api/streams/{name}/backup[?consumers=1] with a zip
// of the stream's snapshot: backup.json beside the archive, the way the
// nats CLI lays a backup out, so either tool can restore it. The chunks
// are spooled to a file first: an error halfway through must not become a
// truncated download that looks whole.
func (h *StreamsHandler) Backup(w http.ResponseWriter, r *http.Request) {
	nc, prefix, err := jsAPIFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := urlParam(r, "name")
	tmp, err := os.CreateTemp("", "nats-explorer-backup-*.zip")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	ctx, cancel := context.WithTimeout(r.Context(), time.Hour)
	defer cancel()
	if err := snapshotToZip(ctx, nc, prefix, name, r.URL.Query().Get("consumers") == "1", tmp); err != nil {
		status := http.StatusBadGateway
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		}
		writeError(w, status, err.Error())
		return
	}
	size, err := tmp.Seek(0, io.SeekEnd)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	tmp.Seek(0, io.SeekStart)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name+"-backup.zip"))
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	io.Copy(w, tmp)
}

// snapshotToZip runs the snapshot protocol: ask for the chunks on an inbox,
// acknowledge each so the server keeps sending, and stop at the empty one
// that ends it.
func snapshotToZip(ctx context.Context, nc *nats.Conn, prefix, name string, consumers bool, out io.Writer) error {
	inbox := nc.NewRespInbox()
	ch := make(chan *nats.Msg, 256)
	sub, err := nc.ChanSubscribe(inbox, ch)
	if err != nil {
		return err
	}
	defer sub.Unsubscribe()
	sub.SetPendingLimits(-1, -1)

	req, _ := json.Marshal(map[string]interface{}{"deliver_subject": inbox, "no_consumers": !consumers, "chunk_size": backupChunk})
	resp, err := nc.RequestWithContext(ctx, prefix+".STREAM.SNAPSHOT."+name, req)
	if err != nil {
		return fmt.Errorf("snapshot request: %w", err)
	}
	if err := apiError(resp.Data); err != nil {
		return fmt.Errorf("snapshot: %w", err)
	}
	var meta struct {
		Config json.RawMessage `json:"config"`
		State  json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal(resp.Data, &meta); err != nil {
		return err
	}

	zw := zip.NewWriter(out)
	mf, err := zw.Create(backupMetaFile)
	if err != nil {
		return err
	}
	metaJSON, _ := json.MarshalIndent(map[string]json.RawMessage{"config": meta.Config, "state": meta.State}, "", "  ")
	if _, err := mf.Write(metaJSON); err != nil {
		return err
	}
	df, err := zw.Create(backupDataName(nc.ConnectedServerVersion()))
	if err != nil {
		return err
	}
	for {
		var msg *nats.Msg
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg = <-ch:
		case <-time.After(60 * time.Second):
			return errors.New("snapshot: the server stopped sending chunks")
		}
		if len(msg.Data) == 0 {
			if st := msg.Header.Get("Status"); st != "" && !strings.Contains(st, "204") {
				return fmt.Errorf("snapshot: %s %s", st, msg.Header.Get("Description"))
			}
			break
		}
		// The ack is what lets the server send the next chunk.
		if msg.Reply != "" {
			msg.Respond(nil)
		}
		if _, err := df.Write(msg.Data); err != nil {
			return err
		}
	}
	return zw.Close()
}

// Restore answers POST /api/streams-restore with a zip as the body: the
// stream named in backup.json is recreated from the archive. The name
// cannot change on the way -- the server checksums every message -- and a
// stream of that name must not exist yet.
func (h *StreamsHandler) Restore(w http.ResponseWriter, r *http.Request) {
	nc, prefix, err := jsAPIFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tmp, err := os.CreateTemp("", "nats-explorer-restore-*.zip")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	size, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, restoreMaxBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	zr, err := zip.NewReader(tmp, size)
	if err != nil {
		writeError(w, http.StatusBadRequest, "not a zip file: "+err.Error())
		return
	}
	var meta, data *zip.File
	for _, f := range zr.File {
		switch f.Name {
		case backupMetaFile:
			meta = f
		case backupDataFile, backupLegacyDataFile:
			if data != nil {
				writeError(w, http.StatusBadRequest, "the backup holds both "+backupDataFile+" and "+backupLegacyDataFile)
				return
			}
			data = f
		}
	}
	if meta == nil || data == nil {
		writeError(w, http.StatusBadRequest, "a backup is a zip with "+backupMetaFile+" and "+backupDataFile+" or "+backupLegacyDataFile)
		return
	}
	mr, err := meta.Open()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	metaJSON, err := io.ReadAll(io.LimitReader(mr, 1<<20))
	mr.Close()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var cfg struct {
		Config struct {
			Name string `json:"name"`
		} `json:"config"`
	}
	if err := json.Unmarshal(metaJSON, &cfg); err != nil || cfg.Config.Name == "" {
		writeError(w, http.StatusBadRequest, backupMetaFile+" names no stream")
		return
	}
	name := cfg.Config.Name

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Hour)
	defer cancel()
	resp, err := nc.RequestWithContext(ctx, prefix+".STREAM.RESTORE."+name, metaJSON)
	if err != nil {
		writeError(w, http.StatusBadGateway, "restore request: "+err.Error())
		return
	}
	if err := apiError(resp.Data); err != nil {
		writeError(w, http.StatusBadGateway, "restore: "+err.Error())
		return
	}
	var started struct {
		DeliverSubject string `json:"deliver_subject"`
	}
	if err := json.Unmarshal(resp.Data, &started); err != nil || started.DeliverSubject == "" {
		writeError(w, http.StatusBadGateway, "restore: the server named no subject for the chunks")
		return
	}
	dr, err := data.Open()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer dr.Close()
	chunk := make([]byte, restoreChunk)
	for {
		n, err := io.ReadFull(dr, chunk)
		if n > 0 {
			ack, rerr := nc.RequestWithContext(ctx, started.DeliverSubject, chunk[:n])
			if rerr != nil {
				writeError(w, http.StatusBadGateway, "restore: sending a chunk: "+rerr.Error())
				return
			}
			if aerr := apiError(ack.Data); aerr != nil {
				writeError(w, http.StatusBadGateway, "restore: "+aerr.Error())
				return
			}
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	// The empty message ends the upload; the server then rebuilds the
	// stream, which can take a while for a large one.
	final, err := nc.RequestWithContext(ctx, started.DeliverSubject, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "restore: "+err.Error())
		return
	}
	if err := apiError(final.Data); err != nil {
		writeError(w, http.StatusBadGateway, "restore: "+err.Error())
		return
	}
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, streamInfoToMap(info))
}
