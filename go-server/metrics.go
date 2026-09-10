package main

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"nats-explorer/internal/connection"
	"nats-explorer/internal/history"
	"nats-explorer/internal/subscription"
)

// writeMetrics renders the explorer's counters in the Prometheus text
// format. No client library: the set is small and the format is plain.
func writeMetrics(w http.ResponseWriter, statuses []connection.Status, managers map[string]*subscription.Manager, wsClients int, db *history.DB) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	var b strings.Builder
	metric := func(name, help, typ string, rows ...string) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, typ)
		for _, r := range rows {
			b.WriteString(r)
			b.WriteByte('\n')
		}
	}
	label := func(s string) string { return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(s) }

	sort.Slice(statuses, func(i, j int) bool { return statuses[i].ID < statuses[j].ID })
	connected := 0
	var received, throttled, subjects, histMsgs, histBytes, rate []string
	for _, st := range statuses {
		if st.Connected {
			connected++
		}
		mgr := managers[st.ID]
		if mgr == nil {
			continue
		}
		s := mgr.GetStats()
		l := fmt.Sprintf(`{conn="%s",name="%s"}`, label(st.ID), label(st.Name))
		received = append(received, fmt.Sprintf("nats_explorer_messages_received_total%s %d", l, s.Received))
		throttled = append(throttled, fmt.Sprintf("nats_explorer_messages_throttled_total%s %d", l, s.Throttled))
		rate = append(rate, fmt.Sprintf("nats_explorer_message_rate%s %g", l, s.Rate))
		subjects = append(subjects, fmt.Sprintf("nats_explorer_subjects%s %d", l, s.Subjects))
		histMsgs = append(histMsgs, fmt.Sprintf("nats_explorer_history_messages%s %d", l, s.History.Messages))
		histBytes = append(histBytes, fmt.Sprintf("nats_explorer_history_bytes%s %d", l, s.History.Bytes))
	}
	metric("nats_explorer_build_info", "Build information.", "gauge", fmt.Sprintf(`nats_explorer_build_info{version="%s"} 1`, label(version)))
	metric("nats_explorer_connections", "NATS connections by state.", "gauge",
		fmt.Sprintf(`nats_explorer_connections{state="connected"} %d`, connected),
		fmt.Sprintf(`nats_explorer_connections{state="disconnected"} %d`, len(statuses)-connected))
	metric("nats_explorer_ws_clients", "Browser tabs connected to the websocket.", "gauge", fmt.Sprintf("nats_explorer_ws_clients %d", wsClients))
	metric("nats_explorer_messages_received_total", "Messages received per connection since it was opened.", "counter", received...)
	metric("nats_explorer_messages_throttled_total", "Focused messages that did not fit a tab's feed budget.", "counter", throttled...)
	metric("nats_explorer_message_rate", "Messages per second received, averaged over the last seconds.", "gauge", rate...)
	metric("nats_explorer_subjects", "Distinct subjects seen per connection.", "gauge", subjects...)
	metric("nats_explorer_history_messages", "Messages held in the in-memory history.", "gauge", histMsgs...)
	metric("nats_explorer_history_bytes", "Estimated bytes of the in-memory history.", "gauge", histBytes...)
	if db != nil {
		st := db.Stats()
		metric("nats_explorer_history_db_messages", "Messages in the SQLite history.", "gauge", fmt.Sprintf("nats_explorer_history_db_messages %d", st.Messages))
		metric("nats_explorer_history_db_bytes", "Size of the SQLite history on disk.", "gauge", fmt.Sprintf("nats_explorer_history_db_bytes %d", st.Bytes))
		metric("nats_explorer_history_db_dropped_total", "Messages not persisted because the writer fell behind.", "counter", fmt.Sprintf("nats_explorer_history_db_dropped_total %d", st.Dropped))
		// Apart from dropped: what the persist filter left out is a choice,
		// not a loss, and an alert on the two together would fire on both.
		metric("nats_explorer_history_db_filtered_total", "Messages not persisted because the persist filter excluded them.", "counter", fmt.Sprintf("nats_explorer_history_db_filtered_total %d", st.Filtered))
		metric("nats_explorer_history_db_queued_bytes", "Bytes waiting to be written to the SQLite history.", "gauge", fmt.Sprintf("nats_explorer_history_db_queued_bytes %d", st.Queued))
	}
	io.WriteString(w, b.String())
}
