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

func TestDeployment(t *testing.T) {
	cases := []struct {
		name  string
		env   map[string]string
		files []string
		want  string
	}{
		{"binary", nil, nil, ""},
		{"docker", nil, []string{"/.dockerenv"}, "docker"},
		{"podman", nil, []string{"/run/.containerenv"}, "container"},
		{"kubernetes wins over the runtime's marker", map[string]string{"KUBERNETES_SERVICE_HOST": "10.0.0.1"}, []string{"/.dockerenv"}, "kubernetes"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := deploymentFrom(func(k string) string { return tc.env[k] }, func(p string) bool {
				for _, f := range tc.files {
					if f == p {
						return true
					}
				}
				return false
			})
			if got != tc.want {
				t.Fatalf("deployment = %q, want %q", got, tc.want)
			}
		})
	}
}
