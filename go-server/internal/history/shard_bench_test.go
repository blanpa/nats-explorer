package history

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"nats-explorer/internal/message"
)

// Would parallel writers help? SQLite serialises writers within one file, so
// the way to find out is to shard: N databases, N writer goroutines, the
// same total number of messages. If the throughput scales, the single writer
// is the limit; if it does not, the machine is.
//
//	go test -run xxx -bench BenchmarkShards -benchtime 200000x ./internal/history/
func benchShards(b *testing.B, shards int, fts bool) {
	b.Helper()
	dir := b.TempDir()
	dbs := make([]*DB, shards)
	for i := range dbs {
		db, err := OpenDB(filepath.Join(dir, fmt.Sprintf("h%d.db", i)), time.Hour)
		if err != nil {
			b.Fatal(err)
		}
		if !fts {
			if err := db.SetFullText(false); err != nil {
				b.Fatal(err)
			}
		}
		defer db.Close()
		dbs[i] = db
	}
	data := make([]byte, 200)
	for i := range data {
		data[i] = byte('a' + i%26)
	}

	b.ResetTimer()
	start := time.Now()
	per := b.N / shards
	var wg sync.WaitGroup
	for s := 0; s < shards; s++ {
		wg.Add(1)
		go func(s int) {
			defer wg.Done()
			for i := 0; i < per; i++ {
				dbs[s].Enqueue("c1", &message.Record{
					Subject:   fmt.Sprintf("bench.s%d.v", (s*per+i)%1000),
					Data:      data,
					Timestamp: time.Now().UnixMilli(),
					Sequence:  uint64(i + 1),
				})
			}
		}(s)
	}
	wg.Wait()
	var written int64
	for _, db := range dbs {
		db.Flush()
		written += db.Written()
	}
	b.StopTimer()
	b.ReportMetric(float64(written)/time.Since(start).Seconds(), "msg/s")
}

func BenchmarkShards1(b *testing.B)        { benchShards(b, 1, false) }
func BenchmarkShards2(b *testing.B)        { benchShards(b, 2, false) }
func BenchmarkShards4(b *testing.B)        { benchShards(b, 4, false) }
func BenchmarkShards8(b *testing.B)        { benchShards(b, 8, false) }
func BenchmarkShards4WithFTS(b *testing.B) { benchShards(b, 4, true) }
