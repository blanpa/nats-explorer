package alerts

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// Where an alert goes besides the log. A webhook that speaks JSON is the
// generic answer; Slack and Teams each want their own shape, and writing
// the same adapter in front of every installation is the half hour this
// file saves. Email is the channel a plant still reads at night.

// Webhook formats a rule may ask for.
const (
	FormatJSON  = "json"
	FormatSlack = "slack"
	FormatTeams = "teams"
)

// headline is the one line every channel starts with.
func headline(ev Event) string {
	state := ev.State
	switch ev.State {
	case StateStale:
		state = "silent"
	case StateResolved:
		state = "resolved"
	}
	return fmt.Sprintf("[%s] %s: %s %s", ev.Severity, ev.RuleName, ev.Subject, state)
}

// webhookBody renders an event for the format the rule asked for.
func webhookBody(format string, ev Event) []byte {
	switch format {
	case FormatSlack:
		text := "*" + headline(ev) + "*"
		if ev.Preview != "" {
			text += "\n```" + ev.Preview + "```"
		}
		body, _ := json.Marshal(map[string]any{"text": text})
		return body
	case FormatTeams:
		// The Workflows webhook of Teams takes an Adaptive Card; the plain
		// text of the retired Office connector no longer arrives anywhere.
		blocks := []map[string]any{{"type": "TextBlock", "text": headline(ev), "weight": "Bolder", "wrap": true}}
		if ev.Preview != "" {
			blocks = append(blocks, map[string]any{"type": "TextBlock", "text": ev.Preview, "fontType": "Monospace", "wrap": true})
		}
		body, _ := json.Marshal(map[string]any{
			"type": "message",
			"attachments": []map[string]any{{
				"contentType": "application/vnd.microsoft.card.adaptive",
				"content":     map[string]any{"type": "AdaptiveCard", "version": "1.4", "body": blocks},
			}},
		})
		return body
	default:
		body, _ := json.Marshal(map[string]any{
			"rule": ev.RuleName, "ruleId": ev.RuleID, "connId": ev.ConnID, "subject": ev.Subject,
			"state": ev.State, "severity": ev.Severity, "preview": ev.Preview, "time": ev.Time,
		})
		return body
	}
}

// mailSubject and mailBody are what an email carries.
func mailSubject(ev Event) string { return headline(ev) }

func mailBody(ev Event) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\nRule: %s\nSubject: %s\nConnection: %s\nState: %s\nSeverity: %s\nTime: %s\n",
		headline(ev), ev.RuleName, ev.Subject, ev.ConnID, ev.State, ev.Severity, time.UnixMilli(ev.Time).UTC().Format(time.RFC3339))
	if ev.Preview != "" {
		fmt.Fprintf(&b, "\n%s\n", ev.Preview)
	}
	return b.String()
}

// recipients splits the rule's address list.
func recipients(list string) []string {
	var out []string
	for _, a := range strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == ';' || r == ' ' }) {
		if a != "" {
			out = append(out, a)
		}
	}
	return out
}

// SMTP is what sending an email needs; From is the sender the server
// accepts. Host empty means email is not configured.
type SMTP struct {
	Host, User, Pass, From string
	Port                   int
}

// ErrNoMail is reported on a rule with recipients when the server has no
// SMTP configuration: the log should say why nothing arrived.
var ErrNoMail = errors.New("email is not configured: set SMTP_HOST, SMTP_FROM and, where needed, SMTP_USER and SMTP_PASS")

// Mailer sends one message. STARTTLS is used when the server offers it,
// port 465 is taken as TLS from the first byte, and anything else goes in
// the clear -- a local relay, mostly.
func (s SMTP) Mailer() func(to []string, subject, body string) error {
	if s.Host == "" {
		return nil
	}
	port := s.Port
	if port == 0 {
		port = 587
	}
	addr := net.JoinHostPort(s.Host, fmt.Sprint(port))
	return func(to []string, subject, body string) error {
		var conn net.Conn
		var err error
		dialer := net.Dialer{Timeout: 10 * time.Second}
		if port == 465 {
			conn, err = tls.DialWithDialer(&dialer, "tcp", addr, &tls.Config{ServerName: s.Host})
		} else {
			conn, err = dialer.Dial("tcp", addr)
		}
		if err != nil {
			return err
		}
		conn.SetDeadline(time.Now().Add(30 * time.Second))
		c, err := smtp.NewClient(conn, s.Host)
		if err != nil {
			conn.Close()
			return err
		}
		defer c.Close()
		if port != 465 {
			if ok, _ := c.Extension("STARTTLS"); ok {
				if err := c.StartTLS(&tls.Config{ServerName: s.Host}); err != nil {
					return err
				}
			}
		}
		if s.User != "" {
			if err := c.Auth(smtp.PlainAuth("", s.User, s.Pass, s.Host)); err != nil {
				return err
			}
		}
		if err := c.Mail(s.From); err != nil {
			return err
		}
		for _, rcpt := range to {
			if err := c.Rcpt(rcpt); err != nil {
				return err
			}
		}
		w, err := c.Data()
		if err != nil {
			return err
		}
		msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s",
			s.From, strings.Join(to, ", "), subject, time.Now().Format(time.RFC1123Z), strings.ReplaceAll(body, "\n", "\r\n"))
		if _, err := w.Write([]byte(msg)); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		return c.Quit()
	}
}
