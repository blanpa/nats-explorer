package history

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"nats-explorer/internal/message"
)

func TestNumericFields(t *testing.T) {
	got := numericFields([]byte(`{"temp": 21.5, "ok": true, "name": "x", "nested": {"a": 1, "b": "no"}, "list": [1,2]}`))
	want := map[string]float64{"temp": 21.5, "nested.a": 1}
	if len(got) != len(want) {
		t.Fatalf("fields = %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if numericFields([]byte(`not json`)) != nil || numericFields(nil) != nil {
		t.Error("non-JSON payloads contribute nothing")
	}
	// Two levels deep is out of scope, and the field cap holds.
	if f := numericFields([]byte(`{"a":{"b":{"c":1}}}`)); len(f) != 0 {
		t.Errorf("third level = %v", f)
	}
	var big []byte
	big = append(big, '{')
	for i := 0; i < 40; i++ {
		if i > 0 {
			big = append(big, ',')
		}
		big = append(big, fmt.Sprintf(`"f%02d": %d`, i, i)...)
	}
	big = append(big, '}')
	if f := numericFields(big); len(f) != rollupMaxFields {
		t.Errorf("capped fields = %d, want %d", len(f), rollupMaxFields)
	}
}

func TestRollupsAggregatePerMinute(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "h.db"), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	base := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC).UnixMilli()
	// three messages in the first minute, one in the second
	for i, spec := range []struct {
		off  int64
		temp float64
	}{{0, 20}, {1000, 24}, {2000, 22}, {61000, 30}} {
		rec := &message.Record{Subject: "plant.temp", Data: []byte(fmt.Sprintf(`{"temp": %v, "n": %d}`, spec.temp, i)), Timestamp: base + spec.off, Sequence: uint64(i + 1)}
		db.Enqueue("c1", rec)
	}
	db.Flush()

	points, err := db.SeriesRollup(context.Background(), "c1", "plant.temp", "temp", base-60000, base+120000)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 2 {
		t.Fatalf("points = %+v", points)
	}
	first := points[0]
	if first.Min != 20 || first.Max != 24 || first.Count != 3 || first.Avg != 22 {
		t.Errorf("first minute = %+v, want min 20 max 24 avg 22 count 3", first)
	}
	if first.T%60000 != 0 {
		t.Errorf("bucket %d is not aligned to a minute", first.T)
	}
	if points[1].Count != 1 || points[1].Min != 30 {
		t.Errorf("second minute = %+v", points[1])
	}

	// A later message in the same minute folds into the existing bucket.
	db.Enqueue("c1", &message.Record{Subject: "plant.temp", Data: []byte(`{"temp": 10}`), Timestamp: base + 3000, Sequence: 9})
	db.Flush()
	points, _ = db.SeriesRollup(context.Background(), "c1", "plant.temp", "temp", base-60000, base+120000)
	if points[0].Min != 10 || points[0].Count != 4 {
		t.Fatalf("after the upsert = %+v", points[0])
	}

	fields, err := db.RollupFields(context.Background(), "c1", "plant.temp")
	if err != nil {
		t.Fatal(err)
	}
	if len(fields) != 2 || fields[0] != "n" || fields[1] != "temp" {
		t.Fatalf("fields = %v", fields)
	}
	if other, _ := db.RollupFields(context.Background(), "c1", "nothing"); len(other) != 0 {
		t.Errorf("unknown subject = %v", other)
	}
}

func TestRollupRetentionEnv(t *testing.T) {
	if got := rollupRetention(func(string) string { return "" }); got != rollupRetentionDefault {
		t.Errorf("default = %v", got)
	}
	if got := rollupRetention(func(string) string { return "48h" }); got != 48*time.Hour {
		t.Errorf("48h = %v", got)
	}
	if got := rollupRetention(func(string) string { return "nonsense" }); got != rollupRetentionDefault {
		t.Errorf("bad value should fall back, got %v", got)
	}
}
