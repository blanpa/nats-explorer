// Package subject holds the NATS subject rules the rest of the server needs:
// matching a subject against a pattern, and the literal prefix of a pattern.
// Alert rules, subscriptions and pinned schemas all ask the same question,
// so they ask it in one place.
package subject

import "strings"

// Match reports whether a subject matches a NATS pattern: "*" matches one
// token, ">" the rest of the subject (at least one token).
func Match(pattern, subject string) bool {
	pt := strings.Split(pattern, ".")
	st := strings.Split(subject, ".")
	for i, p := range pt {
		if p == ">" {
			return i == len(pt)-1 && len(st) > i
		}
		if i >= len(st) || (p != "*" && p != st[i]) {
			return false
		}
	}
	return len(pt) == len(st)
}

// LiteralPrefix returns the leading literal tokens of a pattern, the branch a
// history lookup can start from; empty when the pattern starts with a wildcard.
func LiteralPrefix(pattern string) string {
	var toks []string
	for _, t := range strings.Split(pattern, ".") {
		if t == "*" || t == ">" {
			break
		}
		toks = append(toks, t)
	}
	return strings.Join(toks, ".")
}
