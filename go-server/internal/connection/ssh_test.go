package connection

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"golang.org/x/crypto/ssh"
)

// bastion is the smallest SSH server that forwards: password auth, and
// direct-tcpip channels copied to wherever they ask for.
func bastion(t *testing.T, password string) (addr string, hostKey string) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if string(pw) == password {
				return nil, nil
			}
			return nil, io.ErrUnexpectedEOF
		},
	}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
				if err != nil {
					return
				}
				defer sconn.Close()
				go ssh.DiscardRequests(reqs)
				for ch := range chans {
					if ch.ChannelType() != "direct-tcpip" {
						ch.Reject(ssh.UnknownChannelType, "no")
						continue
					}
					// host (string), port (uint32), origin host, origin port
					data := ch.ExtraData()
					hl := binary.BigEndian.Uint32(data[:4])
					host := string(data[4 : 4+hl])
					port := binary.BigEndian.Uint32(data[4+hl : 8+hl])
					target, err := net.Dial("tcp", net.JoinHostPort(host, itoa(int(port))))
					if err != nil {
						ch.Reject(ssh.ConnectionFailed, err.Error())
						continue
					}
					c, creqs, err := ch.Accept()
					if err != nil {
						target.Close()
						continue
					}
					go ssh.DiscardRequests(creqs)
					go func() {
						io.Copy(c, target)
						c.Close()
					}()
					go func() {
						io.Copy(target, c)
						target.Close()
					}()
				}
			}()
		}
	}()
	return ln.Addr().String(), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
}

func itoa(n int) string { return strconv.Itoa(n) }

func startNATS(t *testing.T) *natsserver.Server {
	t.Helper()
	ns, err := natsserver.NewServer(&natsserver.Options{Host: "127.0.0.1", Port: -1, NoLog: true, NoSigs: true})
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats-server did not start")
	}
	t.Cleanup(ns.Shutdown)
	return ns
}

// A connection through a bastion reaches the server, reports the host key
// it saw so it can be pinned, holds a wrong pin or a wrong password
// against the bastion, and closes the session with the connection.
func TestSSHTunnel(t *testing.T) {
	ns := startNATS(t)
	addr, hostKey := bastion(t, "secret")
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	store := NewStore()
	m, err := store.Connect(Config{ID: "ssh1", Name: "ssh", Servers: []string{ns.ClientURL()}, AuthMethod: "none",
		SSH: &SSHConfig{Host: host, Port: port, User: "u", Password: "secret"}})
	if err != nil {
		t.Fatal(err)
	}
	if !m.NC.IsConnected() {
		t.Fatal("not connected through the tunnel")
	}
	st := store.GetStatus("ssh1")
	if !st.SSH || st.SSHHostKey != hostKey {
		t.Fatalf("status = %+v, want the host key %q", st, hostKey)
	}
	// Round trip through the tunnel.
	sub, _ := m.NC.SubscribeSync("t.ping")
	m.NC.Publish("t.ping", []byte("1"))
	if _, err := sub.NextMsg(2 * time.Second); err != nil {
		t.Fatalf("no message through the tunnel: %v", err)
	}
	store.Disconnect("ssh1")
	if m.tunnel.client != nil {
		t.Fatal("the SSH session outlived the connection")
	}

	// Pinned to the key seen: fine. Pinned to another: refused.
	if _, err := store.Connect(Config{ID: "ssh2", Servers: []string{ns.ClientURL()}, AuthMethod: "none",
		SSH: &SSHConfig{Host: host, Port: port, User: "u", Password: "secret", HostKey: "bastion.example " + hostKey}}); err != nil {
		t.Fatalf("pinned to the right key: %v", err)
	}
	if st := store.GetStatus("ssh2"); st.SSHHostKey != "" {
		t.Fatalf("a pinned connection reports a seen key: %+v", st)
	}
	store.Disconnect("ssh2")
	_, otherKey := bastion(t, "x")
	if _, err := store.Connect(Config{ID: "ssh3", Servers: []string{ns.ClientURL()}, AuthMethod: "none",
		SSH: &SSHConfig{Host: host, Port: port, User: "u", Password: "secret", HostKey: otherKey}}); err == nil {
		t.Fatal("a wrong pinned key was accepted")
	}
	if _, err := store.Connect(Config{ID: "ssh4", Servers: []string{ns.ClientURL()}, AuthMethod: "none",
		SSH: &SSHConfig{Host: host, Port: port, User: "u", Password: "wrong"}}); err == nil {
		t.Fatal("a wrong password was accepted")
	}
	if _, err := store.Connect(Config{ID: "ssh5", Servers: []string{ns.ClientURL()}, AuthMethod: "none",
		SSH: &SSHConfig{Host: host, Port: port, User: "u", HostKey: "not a key"}}); err == nil || !strings.Contains(err.Error(), "password or a private key") {
		t.Fatalf("a tunnel without credentials: %v", err)
	}
	if _, err := parseHostKey("garbage"); err == nil {
		t.Fatal("garbage parsed as a host key")
	}
}
