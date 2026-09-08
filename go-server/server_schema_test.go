package main

import (
	"fmt"
	"testing"
	"time"
)

// GET /api/schema derives the payload structure of a subject from its history.
func TestServerSchema(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{"id": "sc", "name": "s", "servers": []string{ns.ClientURL()}, "authMethod": "none"}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	q := "?connId=sc"
	for i := 1; i <= 6; i++ {
		api.do("POST", "/api/publish"+q, map[string]interface{}{"subject": "sch.temp", "payload": fmt.Sprintf(`{"temp": %d.5, "unit": "C", "tags": ["a"]}`, 20+i)}, nil)
	}
	var res struct {
		Subject string `json:"subject"`
		Schema  struct {
			Samples int            `json:"samples"`
			Kinds   map[string]int `json:"kinds"`
			Fields  []struct {
				Path     string  `json:"path"`
				Presence float64 `json:"presence"`
				Max      float64 `json:"max"`
			} `json:"fields"`
			Drift []interface{} `json:"drift"`
		} `json:"schema"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for res.Schema.Samples < 6 && time.Now().Before(deadline) {
		api.do("GET", "/api/schema"+q+"&subject=sch.temp", nil, &res)
		time.Sleep(50 * time.Millisecond)
	}
	if res.Subject != "sch.temp" || res.Schema.Samples != 6 || res.Schema.Kinds["json"] != 6 {
		t.Fatalf("schema = %+v", res)
	}
	paths := map[string]float64{}
	var tempMax float64
	for _, f := range res.Schema.Fields {
		paths[f.Path] = f.Presence
		if f.Path == "temp" {
			tempMax = f.Max
		}
	}
	if paths["temp"] != 1 || paths["unit"] != 1 || paths["tags[]"] != 1 || tempMax != 26.5 {
		t.Fatalf("fields = %v max %v", paths, tempMax)
	}
	if len(res.Schema.Drift) != 0 {
		t.Fatalf("drift = %v", res.Schema.Drift)
	}
	if st := api.do("GET", "/api/schema"+q, nil, nil); st != 400 {
		t.Errorf("without subject: %d, want 400", st)
	}
	// an unknown subject is an empty schema, not an error
	if st := api.do("GET", "/api/schema"+q+"&subject=nothing.here", nil, &res); st != 200 || res.Schema.Samples != 0 {
		t.Errorf("unknown subject = %d %+v", st, res.Schema)
	}
	api.do("POST", "/api/disconnect-all", nil, nil)
}
