package main

import "testing"

func TestSourceURL(t *testing.T) {
	const repo = "https://github.com/blanpa/nats-explorer"
	cases := []struct {
		name            string
		env             string
		version, commit string
		want            string
	}{
		{"dev build", "", "dev", "", repo},
		{"release", "", "0.3.0", "", repo + "/releases/tag/v0.3.0"},
		{"release with a v", "", "v0.3.0", "", repo + "/releases/tag/v0.3.0"},
		{"commit wins over version", "", "0.3.0", "abc1234", repo + "/tree/abc1234"},
		{"own repository", "https://git.example.org/ops/explorer", "0.3.0", "abc1234",
			"https://git.example.org/ops/explorer"},
		{"own GitHub fork", "https://github.com/someone/fork/", "0.3.0", "abc1234",
			"https://github.com/someone/fork/tree/abc1234"},
		{"whitespace", "  " + repo + "  ", "dev", "", repo},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SOURCE_URL", tc.env)
			old, oldCommit := version, commit
			version, commit = tc.version, tc.commit
			defer func() { version, commit = old, oldCommit }()
			if got := sourceURL(); got != tc.want {
				t.Fatalf("sourceURL() = %q, want %q", got, tc.want)
			}
		})
	}
}
