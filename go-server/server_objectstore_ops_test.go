package main

import (
	"bytes"
	"net/http"
	"testing"
)

// Many objects go at once, with what failed named; a sealed store takes no
// more uploads.
func TestServerObjectStoreSealAndBulkDelete(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "t1", "name": "t", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	q := "?connId=t1"
	if st := api.do("POST", "/api/objectstore"+q, map[string]interface{}{"bucket": "files"}, nil); st != 200 {
		t.Fatalf("create store: %d", st)
	}
	put := func(name string) int {
		req, _ := http.NewRequest("PUT", srv.URL+"/api/objectstore/files/"+name+q, bytes.NewReader([]byte("data of "+name)))
		req.Header.Set("Content-Type", "application/octet-stream")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for _, n := range []string{"a.txt", "b.txt", "c.txt"} {
		if st := put(n); st != 200 {
			t.Fatalf("put %s: %d", n, st)
		}
	}
	var res struct {
		Deleted int               `json:"deleted"`
		Failed  map[string]string `json:"failed"`
	}
	if st := api.do("POST", "/api/objectstore-bulk-delete/files"+q, map[string]interface{}{"names": []string{"a.txt", "b.txt", "nope.txt"}}, &res); st != 200 || res.Deleted != 2 || len(res.Failed) != 1 {
		t.Fatalf("bulk delete: %d %+v", st, res)
	}
	var objs []map[string]interface{}
	api.do("GET", "/api/objectstore/files"+q, nil, &objs)
	if len(objs) != 1 {
		t.Fatalf("objects left = %v", objs)
	}
	if st := api.do("POST", "/api/objectstore-seal/files"+q, nil, nil); st != 200 {
		t.Fatalf("seal: %d", st)
	}
	if st := put("d.txt"); st == 200 {
		t.Fatal("a sealed store took an upload")
	}
}
