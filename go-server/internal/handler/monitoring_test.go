package handler

import (
	"testing"

	"nats-explorer/internal/connection"
)

func TestMonitoringBaseURL(t *testing.T) {
	cases := []struct {
		name string
		cfg  connection.Config
		want string
		err  bool
	}{
		{"explicit url wins", connection.Config{MonitoringURL: "http://mon:9999/", Servers: []string{"nats://x:4222"}}, "http://mon:9999", false},
		{"default port", connection.Config{Servers: []string{"nats://nats.local:4222"}}, "http://nats.local:8222", false},
		{"explicit port", connection.Config{Servers: []string{"nats://nats.local:4222"}, MonitoringPort: 8300}, "http://nats.local:8300", false},
		{"userinfo in url", connection.Config{Servers: []string{"nats://user:pass@nats.local:4222"}}, "http://nats.local:8222", false},
		{"tls scheme", connection.Config{Servers: []string{"tls://secure.example:4222"}}, "http://secure.example:8222", false},
		{"no scheme", connection.Config{Servers: []string{"10.0.0.5:4222"}}, "http://10.0.0.5:8222", false},
		{"ipv6", connection.Config{Servers: []string{"nats://[::1]:4222"}}, "http://[::1]:8222", false},
		{"no servers", connection.Config{}, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := monitoringBaseURL(c.cfg)
			if (err != nil) != c.err {
				t.Fatalf("err = %v, want error %v", err, c.err)
			}
			if got != c.want {
				t.Errorf("url = %q, want %q", got, c.want)
			}
		})
	}
}
