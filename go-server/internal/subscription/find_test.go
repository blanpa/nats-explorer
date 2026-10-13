package subscription

import (
	"reflect"
	"testing"
)

func TestFindSubjects(t *testing.T) {
	m := NewManager("c1")
	for _, s := range []string{"shop.orders.paid", "orders.paid", "$JS.API.CONSUMER.CREATE.ORDERS", "_INBOX.abc.orders", "plant.temp"} {
		sh := m.shardOf(s)
		sh.mu.Lock()
		sh.subjects[s] = &SubjectStats{}
		sh.mu.Unlock()
	}
	// The shortest first, case ignored, the system's own subjects left out.
	if got := m.FindSubjects("ORDERS", 10); !reflect.DeepEqual(got, []string{"orders.paid", "shop.orders.paid"}) {
		t.Errorf("orders = %v", got)
	}
	// Asked for, they are found.
	if got := m.FindSubjects("$js", 10); !reflect.DeepEqual(got, []string{"$JS.API.CONSUMER.CREATE.ORDERS"}) {
		t.Errorf("$js = %v", got)
	}
	if got := m.FindSubjects("orders", 1); len(got) != 1 {
		t.Errorf("limit = %v", got)
	}
}
