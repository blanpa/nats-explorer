package schema

import (
	"encoding/json"
	"fmt"
	"sort"
)

// Validating payloads against a schema someone pinned as the expected one.
//
// The derived schema describes what a subject sends; drift only compares the
// samples to each other, so a subject that has been wrong all along looks
// perfectly consistent. Pinning turns the description into a reference: from
// then on a message can be judged, not just counted.
//
// What is enforced is deliberately narrow. Types and required fields are
// facts about the shape and are worth alerting on. Value ranges are not:
// they come from samples, and a rule that fires the first time a sensor
// reports 90.1 instead of 89.9 is switched off within two days. An
// enumeration is only checked when the field was pinned with Enum set.

// ExpectedField is one field of a pinned schema.
type ExpectedField struct {
	Path string `json:"path"`
	// Types the value may have ("string", "integer", "number", "bool",
	// "object", "array", "null"); empty accepts anything.
	Types []string `json:"types,omitempty"`
	// Required: every message must carry the path.
	Required bool `json:"required,omitempty"`
	// Enum, when set, is the closed set of allowed strings.
	Enum []string `json:"enum,omitempty"`
}

// Expected is a schema pinned for a subject pattern.
type Expected struct {
	Fields []ExpectedField `json:"fields"`
	// Strict also reports paths the pinned schema does not know.
	Strict bool `json:"strict,omitempty"`
}

// Violation is one way a payload differs from what was pinned.
type Violation struct {
	Path string `json:"path"`
	// Kind is "missing", "type", "enum", "unexpected" or "payload".
	Kind string `json:"kind"`
	Want string `json:"want,omitempty"`
	Got  string `json:"got,omitempty"`
}

// String is the one-line form the UI and the CEL variable use.
func (v Violation) String() string {
	switch v.Kind {
	case "missing":
		return v.Path + ": missing"
	case "unexpected":
		return v.Path + ": not in the schema"
	case "payload":
		return v.Got
	default:
		return fmt.Sprintf("%s: %s, expected %s", v.Path, v.Got, v.Want)
	}
}

// FromSchema pins a derived schema: fields that every sampled message
// carried become required, the observed types become the allowed ones.
// Enumerations and strictness are left to the caller -- guessing them from
// samples is how a validator ends up rejecting healthy traffic.
func FromSchema(s Schema) Expected {
	exp := Expected{Fields: make([]ExpectedField, 0, len(s.Fields))}
	for _, f := range s.Fields {
		types := make([]string, 0, len(f.Types))
		for _, t := range f.Types {
			types = append(types, t.Type)
		}
		sort.Strings(types)
		exp.Fields = append(exp.Fields, ExpectedField{
			Path:     f.Path,
			Types:    types,
			Required: f.Presence >= 1,
		})
	}
	return exp
}

// Check reports how a payload differs from the pinned schema. A payload that
// is not JSON is one violation, not a list of missing fields: the message is
// of a different kind, and saying so once is the useful answer.
func (e *Expected) Check(kind string, payload []byte) []Violation {
	if e == nil || len(e.Fields) == 0 {
		return nil
	}
	if kind != "json" {
		return []Violation{{Kind: "payload", Got: "payload is not JSON"}}
	}
	var doc any
	if err := json.Unmarshal(payload, &doc); err != nil {
		return []Violation{{Kind: "payload", Got: "payload is not valid JSON"}}
	}

	byPath := make(map[string]*ExpectedField, len(e.Fields))
	for i := range e.Fields {
		byPath[e.Fields[i].Path] = &e.Fields[i]
	}
	seen := make(map[string]bool, len(e.Fields))
	var out []Violation
	WalkDoc("", doc, 0, func(path string, v any) bool {
		seen[path] = true
		f, known := byPath[path]
		if !known {
			if e.Strict {
				out = append(out, Violation{Path: path, Kind: "unexpected"})
			}
			// An unknown branch has no expectations below it either.
			return e.Strict
		}
		if got := typeOf(v); len(f.Types) > 0 && !contains(f.Types, got) {
			out = append(out, Violation{Path: path, Kind: "type", Want: join(f.Types), Got: got})
		}
		if len(f.Enum) > 0 {
			if s, isString := v.(string); isString && !contains(f.Enum, s) {
				out = append(out, Violation{Path: path, Kind: "enum", Want: join(f.Enum), Got: s})
			}
		}
		return true
	})
	for i := range e.Fields {
		f := &e.Fields[i]
		if f.Required && !seen[f.Path] {
			out = append(out, Violation{Path: f.Path, Kind: "missing"})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// Strings renders violations for the CEL `violations` variable.
func Strings(vs []Violation) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = v.String()
	}
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func join(list []string) string {
	out := ""
	for i, v := range list {
		if i > 0 {
			out += " or "
		}
		out += v
	}
	return out
}
