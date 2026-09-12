package handler

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/nats-io/nats.go/jetstream"
)

// maxGapDetails is how many missing sequences are worth listing. Past it the
// count is the answer: a reader looking for the hole in their stream is not
// helped by ten thousand of them, and the server would have to send the lot.
const maxGapDetails = 5000

// GapRange is a run of sequences that are not in the stream, inclusive.
type GapRange struct {
	From uint64 `json:"from"`
	To   uint64 `json:"to"`
}

// GapsResponse says where a stream's sequences are missing.
//
// A stream counts sequences without promising to keep every one: a delete, a
// purge with a sequence bound, or a per-subject limit leaves a hole. "My
// consumer skipped a message" and "the stream never had it" look identical
// from the outside, and this is the difference.
type GapsResponse struct {
	Stream   string `json:"stream"`
	FirstSeq uint64 `json:"firstSeq"`
	LastSeq  uint64 `json:"lastSeq"`
	Messages uint64 `json:"messages"`
	// Missing is how many sequences between first and last are not stored.
	Missing uint64 `json:"missing"`
	// Ranges are those sequences as runs, newest run last; empty when there
	// are none, or when there were too many to list.
	Ranges []GapRange `json:"ranges"`
	// Listed says whether Ranges covers all of them.
	Listed bool `json:"listed"`
}

// Gaps answers GET /api/streams/{name}/gaps?connId=.
func (h *StreamsHandler) Gaps(w http.ResponseWriter, r *http.Request) {
	js, err := jetStreamFor(h.Store, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := chi.URLParam(r, "name")
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	s, err := js.Stream(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	// Ask without the details first: the list of deleted sequences is one
	// number per hole, and a stream that has dropped millions would send
	// them all before anyone could decide not to look.
	info, err := s.Info(ctx)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	resp := GapsResponse{
		Stream:   name,
		FirstSeq: info.State.FirstSeq,
		LastSeq:  info.State.LastSeq,
		Messages: info.State.Msgs,
		Missing:  uint64(info.State.NumDeleted),
		Ranges:   []GapRange{},
	}
	if resp.Missing == 0 || resp.Missing > maxGapDetails {
		writeJSON(w, resp)
		return
	}
	detail, err := s.Info(ctx, jetstream.WithDeletedDetails(true))
	if err != nil {
		writeJSON(w, resp)
		return
	}
	resp.Ranges = gapRanges(detail.State.Deleted)
	resp.Listed = true
	writeJSON(w, resp)
}

// gapRanges turns single sequences into the runs a reader can take in: a
// thousand deleted messages in a row are one hole, not a thousand of them.
func gapRanges(deleted []uint64) []GapRange {
	if len(deleted) == 0 {
		return []GapRange{}
	}
	seqs := append([]uint64(nil), deleted...)
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
	out := []GapRange{{From: seqs[0], To: seqs[0]}}
	for _, s := range seqs[1:] {
		last := &out[len(out)-1]
		if s == last.To+1 {
			last.To = s
			continue
		}
		if s == last.To {
			continue
		}
		out = append(out, GapRange{From: s, To: s})
	}
	return out
}
