package history

import (
	"fmt"
	"testing"

	"nats-explorer/internal/message"
)

func msg(subject string, seq uint64, ts int64) *message.Record {
	return &message.Record{Subject: subject, Data: []byte(fmt.Sprintf("p%06d", seq)), Timestamp: ts, Sequence: seq}
}

// one shard: the eviction tests reason about a single FIFO
func single(maxBytes, maxPerSubject int) *MemStore {
	return NewMemStoreShards(maxBytes, maxPerSubject, 1)
}

func TestSubjectCapAndPaging(t *testing.T) {
	s := single(0, 3)
	for i := uint64(1); i <= 5; i++ {
		s.Append("c", msg("a.b", i, int64(i)))
	}
	got := s.Subject("c", "a.b", 10, 0)
	if len(got) != 3 || got[0].Sequence != 3 || got[2].Sequence != 5 {
		t.Fatalf("subject history = %+v", got)
	}
	if got[0].ConnID != "c" {
		t.Errorf("history messages must carry their connection")
	}
	if page := s.Subject("c", "a.b", 10, 5); len(page) != 2 || page[1].Sequence != 4 {
		t.Fatalf("page before seq 5 = %+v", page)
	}
	if page := s.Subject("c", "a.b", 1, 0); len(page) != 1 || page[0].Sequence != 5 {
		t.Fatalf("limit 1 must return the newest, got %+v", page)
	}
	if st := s.Stats("c"); st.Messages != 3 || st.Subjects != 1 {
		t.Fatalf("stats = %+v", st)
	}
	if s.Subject("nope", "a.b", 10, 0) != nil || s.Subject("c", "zzz", 10, 0) != nil {
		t.Fatal("unknown connection or subject must return nil")
	}
}

func TestByteBudgetEvictsOldestAcrossSubjects(t *testing.T) {
	one := msg("x", 1, 1).Bytes()
	s := single(one*4, 100)
	s.Append("c", msg("x", 1, 1))
	s.Append("c", msg("y", 2, 2))
	s.Append("c", msg("x", 3, 3))
	s.Append("c", msg("y", 4, 4))
	if st := s.Stats(""); st.Messages != 4 || st.Bytes != one*4 {
		t.Fatalf("stats before eviction = %+v", st)
	}
	s.Append("c", msg("x", 5, 5)) // evicts seq 1 (oldest overall)
	if got := s.Subject("c", "x", 10, 0); len(got) != 2 || got[0].Sequence != 3 {
		t.Fatalf("x after eviction = %+v", got)
	}
	s.Append("c", msg("x", 6, 6)) // evicts seq 2, which lives on y
	if got := s.Subject("c", "y", 10, 0); len(got) != 1 || got[0].Sequence != 4 {
		t.Fatalf("y after eviction = %+v", got)
	}
	if st := s.Stats(""); st.Messages != 4 || st.Bytes > one*4 {
		t.Fatalf("stats after eviction = %+v", st)
	}
}

func TestPerSubjectEvictionLeavesFifoConsistent(t *testing.T) {
	one := msg("x", 1, 1).Bytes()
	s := single(one*3, 1)
	// The subject cap kills seq 1 and 2 before the byte budget ever sees them.
	s.Append("c", msg("x", 1, 1))
	s.Append("c", msg("x", 2, 2))
	s.Append("c", msg("x", 3, 3))
	s.Append("c", msg("y", 4, 4))
	s.Append("c", msg("z", 5, 5))
	s.Append("c", msg("w", 6, 6)) // budget: skips dead 1 and 2, evicts 3
	if got := s.Subject("c", "x", 10, 0); len(got) != 0 {
		t.Fatalf("x should be evicted, got %+v", got)
	}
	if st := s.Stats(""); st.Messages != 3 || st.Bytes != one*3 {
		t.Fatalf("stats = %+v", st)
	}
}

func TestBranchMergesNewestFirst(t *testing.T) {
	s := NewMemStore(0, 0) // several shards: the branch merge spans them
	s.Append("c", msg("a.x", 1, 10))
	s.Append("c", msg("a.y", 2, 30))
	s.Append("c", msg("a.x", 3, 20))
	s.Append("c", msg("a", 4, 40))    // the branch itself is not below it
	s.Append("c", msg("ab.q", 5, 50)) // shares a prefix but not a segment
	got := s.Branch("c", "a", 10)
	if len(got) != 3 || got[0].Sequence != 2 || got[1].Sequence != 3 || got[2].Sequence != 1 {
		t.Fatalf("branch = %+v", got)
	}
	if got := s.Branch("c", "a", 2); len(got) != 2 || got[1].Sequence != 3 {
		t.Fatalf("limited branch = %+v", got)
	}
	if s.Branch("c", "nothing", 5) != nil && len(s.Branch("c", "nothing", 5)) != 0 {
		t.Fatal("unknown branch must be empty")
	}
}

func TestSearchMatchesSubjectOrPayload(t *testing.T) {
	s := NewMemStore(0, 0)
	s.Append("c", &message.Record{Subject: "plant.line1.temp", Data: []byte(`{"value":21,"unit":"Celsius"}`), Timestamp: 1, Sequence: 1})
	s.Append("c", &message.Record{Subject: "plant.line1.speed", Data: []byte(`{"value":1.2}`), Timestamp: 2, Sequence: 2})
	s.Append("c", &message.Record{Subject: "plant.line2.temp", Data: []byte(`{"value":19,"unit":"celsius"}`), Timestamp: 3, Sequence: 3})
	s.Append("c", &message.Record{Subject: "plant.line2.raw", Data: []byte{0xff, 'c', 'e', 'l'}, Timestamp: 4, Sequence: 4})
	s.Append("c", &message.Record{Subject: "other.celsius", Data: []byte("x"), Timestamp: 5, Sequence: 5})
	got := s.Search("c", "plant", "CELSIUS", 10)
	if len(got) != 2 || got[0].Sequence != 3 || got[1].Sequence != 1 {
		t.Fatalf("payload search = %+v", got)
	}
	if got := s.Search("c", "plant", "line1", 10); len(got) != 2 {
		t.Fatalf("subject search = %+v", got)
	}
	if got := s.Search("c", "plant.line2.temp", "", 10); len(got) != 1 || got[0].Sequence != 3 {
		t.Fatalf("exact subject with empty query = %+v", got)
	}
	if got := s.Search("c", "plant", "value", 2); len(got) != 2 || got[0].Sequence != 3 {
		t.Fatalf("limit keeps the newest: %+v", got)
	}
}

func TestDropAndClear(t *testing.T) {
	s := NewMemStore(0, 0)
	s.Append("c1", msg("a", 1, 1))
	s.Append("c2", msg("a", 1, 1))
	s.Drop("c1")
	if st := s.Stats(""); st.Messages != 1 || st.Subjects != 1 {
		t.Fatalf("after drop = %+v", st)
	}
	if s.Subject("c1", "a", 5, 0) != nil {
		t.Fatal("dropped connection still answers")
	}
	s.Append("c2", msg("b", 2, 2))
	s.Clear()
	if st := s.Stats(""); st.Messages != 0 || st.Bytes != 0 || st.Subjects != 0 {
		t.Fatalf("after clear = %+v", st)
	}
}

func TestFifoCompaction(t *testing.T) {
	one := msg("s", 1, 1).Bytes()
	s := single(one*10, 0)
	for i := uint64(1); i <= 20000; i++ {
		s.Append("c", msg("s", i, int64(i)))
	}
	if sh := s.shards[0]; len(sh.fifo)-sh.fifoHead > 4096*2 {
		t.Fatalf("fifo not compacted: len %d head %d", len(sh.fifo), sh.fifoHead)
	}
	if buf := s.shards[0].conns["c"].subjects["s"]; len(buf.items) > 64 {
		t.Fatalf("ring not shrunk after eviction: cap %d for %d live", len(buf.items), buf.len())
	}
	if got := s.Subject("c", "s", 100, 0); len(got) != 10 || got[9].Sequence != 20000 {
		t.Fatalf("history after compaction = %d entries", len(got))
	}
}

func TestShardsSplitBudgetAndAggregate(t *testing.T) {
	s := NewMemStoreShards(0, 0, 4)
	for i := uint64(1); i <= 400; i++ {
		s.Append("c", msg(fmt.Sprintf("s.%d", i%40), i, int64(i)))
	}
	if st := s.Stats(""); st.Messages != 400 || st.Subjects != 40 {
		t.Fatalf("stats over shards = %+v", st)
	}
	if got := s.Subject("c", "s.7", 5, 0); len(got) != 5 || got[4].Sequence != 367 {
		t.Fatalf("subject across shards = %+v", got)
	}
	if got := s.Branch("c", "s", 3); len(got) != 3 || got[0].Sequence != 400 || got[2].Sequence != 398 {
		t.Fatalf("branch across shards = %+v", got)
	}
	s.Drop("c")
	if st := s.Stats(""); st.Messages != 0 {
		t.Fatalf("drop over shards = %+v", st)
	}
}

func BenchmarkAppend(b *testing.B) {
	s := NewMemStore(64<<20, 1000)
	subjects := make([]string, 5000)
	for i := range subjects {
		subjects[i] = fmt.Sprintf("bench.%d", i)
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s.Append("c", &message.Record{Subject: subjects[i%5000], Data: []byte("p"), Sequence: uint64(i)})
	}
}
