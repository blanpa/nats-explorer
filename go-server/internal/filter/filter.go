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
//	valid     bool             the payload matches the schema pinned for the subject
//	violations list(string)    how it differs; empty when it matches
//
// `valid` and `violations` are resolved lazily: an expression that does not
// mention them costs nothing, and without a pinned schema everything is
// valid. That is what makes `!valid` work everywhere an expression does --
// the subject tree, the history endpoints, a time range, an alert rule.
//
// Programs are cached by expression text: the same filter is asked for on
// every view change and every history request.
package filter

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"cel.dev/cel-go/cel"
	"cel.dev/cel-go/ext"
	"cel.dev/cel-go/interpreter"

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
		cel.Variable("valid", cel.BoolType),
		cel.Variable("violations", cel.ListType(cel.StringType)),
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
	// Data is the payload as it arrived; the schema check needs the bytes,
	// not the parsed document.
	Data []byte
	// rec, when set, produces Raw, Kind and the parsed payload on first use
	// instead of up front. See VarsOfRecord.
	rec *message.Record
}

// SchemaChecker reports how a payload differs from the schema pinned for its
// subject, and under which pattern it was pinned. An empty pattern means
// nothing is pinned, which is not the same as a message that matches: the UI
// has to tell "no reference" from "matches the reference".
type SchemaChecker func(subject, kind string, payload []byte) (violations []string, pattern string)

// checker is process-wide because the pinned schemas are: every expression,
// wherever it runs, judges a message against the same reference.
var checker atomic.Pointer[SchemaChecker]

// SetSchemaChecker installs the check behind `valid` and `violations` and
// returns how to remove it again. Removing only clears its own checker, so a
// second server in the same process (tests) does not switch off the first's.
// Passing nil clears whatever is installed.
func SetSchemaChecker(fn SchemaChecker) (remove func()) {
	if fn == nil {
		checker.Store(nil)
		return func() {}
	}
	p := &fn
	checker.Store(p)
	return func() { checker.CompareAndSwap(p, nil) }
}

/**
 * Annotate marks browser messages with how they stand against the schema
 * pinned for their subject, so a list can show it without asking again.
 *
 * It is the same judgement `!valid` makes in an expression, from the same
 * reference -- a row that reads red and a filter that does not catch it
 * would be two answers to one question. Nothing pinned costs a pattern
 * lookup and no parse, which is the case on almost every subject.
 */
func Annotate(msgs []message.NatsMessage) {
	p := checker.Load()
	if p == nil {
		return
	}
	check := *p
	for i := range msgs {
		m := &msgs[i]
		violations, pattern := check(m.Subject, m.PayloadType, []byte(m.Payload))
		if pattern == "" {
			continue
		}
		m.Schema = &message.SchemaVerdict{Valid: len(violations) == 0, Violations: violations, Pattern: pattern}
	}
}

// activation resolves the variables of one evaluation. Everything an
// expression does not mention costs nothing: the payload is parsed, the
// headers are flattened and the schema is checked at most once, and only
// when the expression asks for them.
type activation struct {
	v       Vars
	headers map[string]string
	payload any
	raw     string
	kind    string

	headersDone bool
	payloadDone bool
	rawDone     bool
	kindDone    bool

	violations []string
	checked    bool
}

func (a *activation) Parent() interpreter.Activation { return nil }

// rawText is the payload as text. On the ingest path it is produced here
// rather than in VarsOf, because most expressions never ask for it.
func (a *activation) rawText() string {
	if !a.rawDone {
		a.rawDone = true
		switch {
		case a.v.Raw != "":
			a.raw = a.v.Raw
		case a.v.rec != nil:
			a.raw = a.v.rec.Text()
		}
	}
	return a.raw
}

// kindOf is "json", "string" or "binary". A record caches its own answer,
// so asking it twice is free.
func (a *activation) kindOf() string {
	if !a.kindDone {
		a.kindDone = true
		a.kind = a.v.Kind
		if a.kind == "" && a.v.rec != nil {
			a.kind = a.v.rec.Kind()
		}
	}
	return a.kind
}

// doc is the parsed payload: the JSON document, or the text for anything
// else. Parsing is what a filter on the ingest path would pay per message,
// so it happens only for an expression that mentions `payload`.
func (a *activation) doc() any {
	if a.payloadDone {
		return a.payload
	}
	a.payloadDone = true
	if a.payload != nil {
		return a.payload
	}
	if a.v.rec != nil && a.kindOf() == "json" {
		var d any
		if json.Unmarshal(a.v.rec.Data, &d) == nil {
			a.payload = normalize(d)
			return a.payload
		}
	}
	a.payload = a.rawText()
	return a.payload
}

// headerMap flattens the headers to their first value. An expression that
// does not mention `headers` never builds the map.
func (a *activation) headerMap() map[string]string {
	if a.headersDone {
		return a.headers
	}
	a.headersDone = true
	if a.headers == nil && a.v.rec != nil {
		a.headers = make(map[string]string, len(a.v.rec.Header))
		for k, vals := range a.v.rec.Header {
			if len(vals) > 0 {
				a.headers[k] = vals[0]
			}
		}
	}
	if a.headers == nil {
		a.headers = map[string]string{}
	}
	return a.headers
}

func (a *activation) resolveViolations() []string {
	if !a.checked {
		a.checked = true
		a.violations, _ = SchemaViolations(a.v.Subject, a.kindOf(), a.data())
	}
	return a.violations
}

// SchemaViolations asks the installed checker. Without one nothing is
// pinned, so nothing can be violated.
func SchemaViolations(subject, kind string, payload []byte) (violations []string, pattern string) {
	fn := checker.Load()
	if fn == nil {
		return nil, ""
	}
	return (*fn)(subject, kind, payload)
}

// data is the raw payload; history results carry their text, not bytes.
func (a *activation) data() []byte {
	if a.v.Data != nil {
		return a.v.Data
	}
	return []byte(a.rawText())
}

func (a *activation) ResolveName(name string) (any, bool) {
	switch name {
	case "subject":
		return a.v.Subject, true
	case "payload":
		return a.doc(), true
	case "raw":
		return a.rawText(), true
	case "kind":
		return a.kindOf(), true
	case "headers":
		return a.headerMap(), true
	case "size":
		return a.v.Size, true
	case "timestamp":
		return a.v.Timestamp, true
	case "reply":
		return a.v.Reply, true
	case "valid":
		return len(a.resolveViolations()) == 0, true
	case "violations":
		v := a.resolveViolations()
		if v == nil {
			v = []string{}
		}
		return v, true
	}
	return nil, false
}

// VarsOfRecord builds the variables of a record without touching its
// payload: the text, the parsed document and the headers are produced only
// if the expression asks for them. This is the form the ingest path uses,
// where a filter is evaluated on every message and most expressions only
// look at the subject -- parsing every payload there would cost more than
// the filter saves.
func VarsOfRecord(r *message.Record) Vars {
	return Vars{Subject: r.Subject, Size: len(r.Data), Timestamp: r.Timestamp, Reply: r.Reply, Data: r.Data, rec: r}
}

// VarsOf builds the variables of a record. The payload is parsed once here.
func VarsOf(r *message.Record) Vars {
	v := Vars{Subject: r.Subject, Raw: r.Text(), Kind: r.Kind(), Size: len(r.Data), Timestamp: r.Timestamp, Reply: r.Reply, Data: r.Data}
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
	out, _, err := p.prg.Eval(&activation{v: v, headers: v.Headers, payload: v.Payload})
	if err != nil {
		return false, err
	}
	b, ok := out.Value().(bool)
	return ok && b, nil
}

// Match reports whether a record satisfies the program; errors read as false.
func (p *Program) Match(r *message.Record) bool {
	ok, _ := p.Eval(VarsOfRecord(r))
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
