package history

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"nats-explorer/internal/message"
)

// Where the write cost of the persistent history actually goes. The writer
// drops rather than blocks, so these numbers are the rates above which a
// burst stops reaching the disk. Run with
//
//	go test -run xxx -bench BenchmarkTuning -benchtime 200000x ./internal/history/
//
// Measured on an i7-1165G7 with a 200-byte payload over 1000 subjects:
// as shipped 26k msg/s, without the full-text index 97k, additionally
// without the ts index 106k, and 153k with no index at all -- which is not
// an option, the subject index is what every read uses. synchronous=OFF
// changes nothing: WAL already batches the fsyncs.
func benchTuning(b *testing.B, tweak func(*sql.DB) error) {
	b.Helper()
	db, err := OpenDB(filepath.Join(b.TempDir(), "history.db"), time.Hour)
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	if tweak != nil {
		if err := tweak(db.db); err != nil {
			b.Fatal(err)
		}
	}
	data := make([]byte, 200)
	for i := range data {
		data[i] = byte('a' + i%26)
	}
	b.ResetTimer()
	start := time.Now()
	for i := 0; i < b.N; i++ {
		db.Enqueue("c1", &message.Record{Subject: fmt.Sprintf("bench.s%d.v", i%1000), Data: data, Timestamp: time.Now().UnixMilli(), Sequence: uint64(i + 1)})
	}
	db.Flush()
	b.StopTimer()
	b.ReportMetric(float64(db.Written())/time.Since(start).Seconds(), "msg/s")
}

func exec(stmts ...string) func(*sql.DB) error {
	return func(db *sql.DB) error {
		for _, s := range stmts {
			if _, err := db.Exec(s); err != nil {
				return err
			}
		}
		return nil
	}
}

func BenchmarkTuningAsShipped(b *testing.B) { benchTuning(b, nil) }
func BenchmarkTuningNoFTS(b *testing.B) {
	benchTuning(b, exec(`DROP TRIGGER IF EXISTS messages_ai`, `DROP TRIGGER IF EXISTS messages_ad`))
}
func BenchmarkTuningNoFTSNoTsIndex(b *testing.B) {
	benchTuning(b, exec(`DROP TRIGGER IF EXISTS messages_ai`, `DROP TRIGGER IF EXISTS messages_ad`, `DROP INDEX IF EXISTS messages_ts`))
}
func BenchmarkTuningNoFTSNoTsIndexSyncOff(b *testing.B) {
	benchTuning(b, exec(`DROP TRIGGER IF EXISTS messages_ai`, `DROP TRIGGER IF EXISTS messages_ad`, `DROP INDEX IF EXISTS messages_ts`, `PRAGMA synchronous=OFF`))
}
func BenchmarkTuningNoIndexesAtAll(b *testing.B) {
	benchTuning(b, exec(`DROP TRIGGER IF EXISTS messages_ai`, `DROP TRIGGER IF EXISTS messages_ad`, `DROP INDEX IF EXISTS messages_ts`, `DROP INDEX IF EXISTS messages_subject_ts`, `PRAGMA synchronous=OFF`))
}
