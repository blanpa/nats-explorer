// Package filter evaluates CEL expressions against messages: the payload
// filter of the subject tree, the history endpoints and the alert rules.
//
// An expression sees these variables:
//
//	subject   string           the full subject
//	payload   dyn              the JSON document, or the text of a non-JSON payload
//	raw       string           the payload text (base64 for binary)
//	kind      string           "json", "string" or "binary"
//	headers   map(string,string)  first value per header
//	size      int              payload bytes
//	timestamp int              arrival time in milliseconds
//	reply     string           the reply subject
//
// Programs are cached by expression text: the same filter is asked for on
// every view change and every history request.
package filter

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"cel.dev/cel-go/cel"
	"cel.dev/cel-go/ext"

	"nats-explorer/internal/message"
)

var env = func() *cel.Env {
	e, err := cel.NewEnv(
		cel.Variable("subject", cel.StringType),
		cel.Variable("payload", cel.DynType),
		cel.Variable("raw", cel.StringType),
		cel.Variable("kind", cel.StringType),
		cel.Variable("headers", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("size", cel.IntType),
		cel.Variable("timestamp", cel.IntType),
		cel.Variable("reply", cel.StringType),
		cel.CrossTypeNumericComparisons(true),
		ext.Strings(),
		ext.Math(),
	)
	if err != nil {
		panic(err)
	}
	return e
}()

// Program is a compiled expression.
type Program struct {
	Expr string
	prg  cel.Program
}

const cacheMax = 256

var (
	cacheMu sync.Mutex
	cache   = map[string]*Program{}
)

// Compile parses and type-checks an expression. The result must be a
// boolean. Compiled programs are cached.
func Compile(expr string) (*Program, error) {
	cacheMu.Lock()
	p, ok := cache[expr]
	cacheMu.Unlock()
	if ok {
		return p, nil
	}
	ast, iss := env.Compile(expr)
	if iss.Err() != nil {
		return nil, errors.New(iss.Err().Error())
	}
	if ast.OutputType() != cel.BoolType && ast.OutputType() != cel.DynType {
		return nil, fmt.Errorf("expression must yield true or false, not %s", ast.OutputType())
	}
	prg, err := env.Program(ast, cel.EvalOptions(cel.OptOptimize))
	if err != nil {
		return nil, err
	}
	p = &Program{Expr: expr, prg: prg}
	cacheMu.Lock()
	if len(cache) >= cacheMax {
		cache = map[string]*Program{}
	}
	cache[expr] = p
	cacheMu.Unlock()
	return p, nil
}

// Vars are the variables of one evaluation.
type Vars struct {
	Subject   string
	Payload   any
	Raw       string
	Kind      string
	Headers   map[string]string
	Size      int
	Timestamp int64
	Reply     string
}

// VarsOf builds the variables of a record. The payload is parsed once here.
func VarsOf(r *message.Record) Vars {
	v := Vars{Subject: r.Subject, Raw: r.Text(), Kind: r.Kind(), Size: len(r.Data), Timestamp: r.Timestamp, Reply: r.Reply}
	if v.Kind == "json" {
		var doc any
		if err := json.Unmarshal(r.Data, &doc); err == nil {
			v.Payload = normalize(doc)
		} else {
			v.Payload = v.Raw
		}
	} else {
		v.Payload = v.Raw
	}
	if len(r.Header) > 0 {
		v.Headers = make(map[string]string, len(r.Header))
		for k, vals := range r.Header {
			if len(vals) > 0 {
				v.Headers[k] = vals[0]
			}
		}
	}
	return v
}

// VarsOfMessage builds the variables of a wire message (history results).
func VarsOfMessage(m *message.NatsMessage) Vars {
	v := Vars{Subject: m.Subject, Raw: m.Payload, Kind: m.PayloadType, Size: m.Size, Timestamp: m.Timestamp, Reply: m.Reply, Payload: m.Payload}
	if m.PayloadType == "json" {
		var doc any
		if err := json.Unmarshal([]byte(m.Payload), &doc); err == nil {
			v.Payload = normalize(doc)
		}
	}
	if len(m.Headers) > 0 {
		v.Headers = make(map[string]string, len(m.Headers))
		for k, vals := range m.Headers {
			if len(vals) > 0 {
				v.Headers[k] = vals[0]
			}
		}
	}
	return v
}

// normalize turns whole JSON numbers into ints, so `payload.n % 2 == 0` and
// `payload.code in [3, 4]` work the way people write them; other numbers
// stay doubles and compare across types.
func normalize(v any) any {
	switch x := v.(type) {
	case float64:
		if x == float64(int64(x)) && x > -1e15 && x < 1e15 {
			return int64(x)
		}
		return x
	case []any:
		for i := range x {
			x[i] = normalize(x[i])
		}
		return x
	case map[string]any:
		for k, val := range x {
			x[k] = normalize(val)
		}
		return x
	default:
		return v
	}
}

// Eval runs the program. Runtime errors (a missing field, a type clash on
// this particular message) count as no match and are returned for display.
func (p *Program) Eval(v Vars) (bool, error) {
	headers := v.Headers
	if headers == nil {
		headers = map[string]string{}
	}
	payload := v.Payload
	if payload == nil {
		payload = v.Raw
	}
	out, _, err := p.prg.Eval(map[string]any{
		"subject":   v.Subject,
		"payload":   payload,
		"raw":       v.Raw,
		"kind":      v.Kind,
		"headers":   headers,
		"size":      v.Size,
		"timestamp": v.Timestamp,
		"reply":     v.Reply,
	})
	if err != nil {
		return false, err
	}
	b, ok := out.Value().(bool)
	return ok && b, nil
}

// Match reports whether a record satisfies the program; errors read as false.
func (p *Program) Match(r *message.Record) bool {
	ok, _ := p.Eval(VarsOf(r))
	return ok
}

// MatchMessage is Match for wire messages.
func (p *Program) MatchMessage(m *message.NatsMessage) bool {
	ok, _ := p.Eval(VarsOfMessage(m))
	return ok
}

// Keep filters a list of wire messages in place order, keeping at most
// limit; a nil program keeps everything.
func Keep(p *Program, msgs []message.NatsMessage, limit int) []message.NatsMessage {
	if p == nil {
		if limit > 0 && len(msgs) > limit {
			return msgs[:limit]
		}
		return msgs
	}
	out := msgs[:0:0]
	for i := range msgs {
		if p.MatchMessage(&msgs[i]) {
			out = append(out, msgs[i])
			if limit > 0 && len(out) >= limit {
				break
			}
		}
	}
	return out
}
