package connection

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// A NATS server behind a bastion: the explorer reaches it through one SSH
// connection to the bastion and asks that host to open the way to each
// server. The NATS client never learns; it is handed a dialer that does
// the asking, and reconnects the same way.

// SSHConfig is the bastion a connection goes through.
type SSHConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
	User     string `json:"user"`
	Password string `json:"password,omitempty"`
	// PrivateKey is the PEM of a key, with its passphrase where it has one.
	PrivateKey string `json:"privateKey,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	// HostKey pins the bastion's public key, in the form of a known_hosts
	// line without the host name. Empty accepts whatever the bastion
	// presents and reports it, so it can be pinned afterwards.
	HostKey string `json:"hostKey,omitempty"`
}

// sshDialer opens connections through the bastion. One SSH client serves
// every dial, opened on the first and again after it broke.
type sshDialer struct {
	cfg SSHConfig

	mu     sync.Mutex
	client *ssh.Client
	// seen is the bastion's host key as presented, for pinning it later.
	seen string
}

func newSSHDialer(cfg SSHConfig) (*sshDialer, error) {
	cfg.Host = strings.TrimSpace(cfg.Host)
	cfg.User = strings.TrimSpace(cfg.User)
	if cfg.Host == "" || cfg.User == "" {
		return nil, errors.New("the SSH tunnel needs a host and a user")
	}
	if cfg.Port == 0 {
		cfg.Port = 22
	}
	if strings.TrimSpace(cfg.PrivateKey) == "" && cfg.Password == "" {
		return nil, errors.New("the SSH tunnel needs a password or a private key")
	}
	if strings.TrimSpace(cfg.PrivateKey) != "" {
		if _, err := parseSSHKey(cfg.PrivateKey, cfg.Passphrase); err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(cfg.HostKey) != "" {
		if _, err := parseHostKey(cfg.HostKey); err != nil {
			return nil, err
		}
	}
	return &sshDialer{cfg: cfg}, nil
}

func parseSSHKey(pem, passphrase string) (ssh.Signer, error) {
	var signer ssh.Signer
	var err error
	if passphrase != "" {
		signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(pem), []byte(passphrase))
	} else {
		signer, err = ssh.ParsePrivateKey([]byte(pem))
	}
	if err != nil {
		var missing *ssh.PassphraseMissingError
		if errors.As(err, &missing) {
			return nil, errors.New("the SSH key needs its passphrase")
		}
		return nil, fmt.Errorf("SSH key: %w", err)
	}
	return signer, nil
}

// parseHostKey reads a pinned key: "ssh-ed25519 AAAA…", with or without a
// host name in front, as a known_hosts line has it.
func parseHostKey(line string) (ssh.PublicKey, error) {
	fields := strings.Fields(line)
	for i := 0; i+1 < len(fields); i++ {
		if strings.HasPrefix(fields[i], "ssh-") || strings.HasPrefix(fields[i], "ecdsa-") {
			key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.Join(fields[i:], " ")))
			if err != nil {
				return nil, fmt.Errorf("SSH host key: %w", err)
			}
			return key, nil
		}
	}
	return nil, errors.New("SSH host key: expected a line like \"ssh-ed25519 AAAA…\"")
}

// clientConfig is how the bastion is talked to.
func (d *sshDialer) clientConfig() (*ssh.ClientConfig, error) {
	cfg := &ssh.ClientConfig{User: d.cfg.User, Timeout: 10 * time.Second}
	if strings.TrimSpace(d.cfg.PrivateKey) != "" {
		signer, err := parseSSHKey(d.cfg.PrivateKey, d.cfg.Passphrase)
		if err != nil {
			return nil, err
		}
		cfg.Auth = append(cfg.Auth, ssh.PublicKeys(signer))
	}
	if d.cfg.Password != "" {
		cfg.Auth = append(cfg.Auth, ssh.Password(d.cfg.Password))
	}
	if strings.TrimSpace(d.cfg.HostKey) != "" {
		pinned, err := parseHostKey(d.cfg.HostKey)
		if err != nil {
			return nil, err
		}
		cfg.HostKeyCallback = ssh.FixedHostKey(pinned)
	} else {
		// Nothing pinned: the key is accepted and remembered, so whoever
		// looks can pin it; the form says this is the state of things.
		cfg.HostKeyCallback = func(_ string, _ net.Addr, key ssh.PublicKey) error {
			d.mu.Lock()
			d.seen = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
			d.mu.Unlock()
			return nil
		}
	}
	return cfg, nil
}

// Dial is what the NATS client calls for every server, and after every
// disconnect: a channel through the bastion to the address.
func (d *sshDialer) Dial(network, address string) (net.Conn, error) {
	client, err := d.connect()
	if err != nil {
		return nil, err
	}
	conn, err := client.Dial(network, address)
	if err != nil {
		// The bastion may have dropped the session; the next dial opens a new one.
		d.mu.Lock()
		if d.client == client {
			d.client = nil
		}
		d.mu.Unlock()
		client.Close()
		return nil, fmt.Errorf("through %s: %w", d.cfg.Host, err)
	}
	return conn, nil
}

func (d *sshDialer) connect() (*ssh.Client, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.client != nil {
		return d.client, nil
	}
	cfg, err := d.clientConfig()
	if err != nil {
		return nil, err
	}
	addr := net.JoinHostPort(d.cfg.Host, fmt.Sprint(d.cfg.Port))
	// The callback above takes the lock to remember the key, so it must
	// not be held while dialing.
	d.mu.Unlock()
	client, err := ssh.Dial("tcp", addr, cfg)
	d.mu.Lock()
	if err != nil {
		return nil, fmt.Errorf("SSH to %s: %w", addr, err)
	}
	if d.client != nil {
		client.Close()
		return d.client, nil
	}
	d.client = client
	return client, nil
}

// HostKeySeen is the bastion's key as it was presented, when none is pinned.
func (d *sshDialer) HostKeySeen() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.seen
}

// Close ends the SSH session; the NATS connection over it is closed first.
func (d *sshDialer) Close() {
	d.mu.Lock()
	client := d.client
	d.client = nil
	d.mu.Unlock()
	if client != nil {
		client.Close()
	}
}
