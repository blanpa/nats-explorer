package connection

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"reflect"
	"testing"
	"time"
)

func TestNormalizeServers(t *testing.T) {
	got := normalizeServers([]string{" localhost:4222 ", "", "tls://a:1", "nats://b:2", "  "})
	want := []string{"nats://localhost:4222", "tls://a:1", "nats://b:2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestConnectRejectsMissingServers(t *testing.T) {
	s := NewStore()
	if _, err := s.Connect(Config{ID: "x", Servers: []string{" "}}); err == nil {
		t.Fatal("expected an error for empty server list")
	}
}

func TestBuildOptionsValidatesAuth(t *testing.T) {
	m := &Managed{}
	if _, err := buildOptions(Config{AuthMethod: "nkey"}, m, func() {}); err == nil {
		t.Error("nkey without seed must fail")
	}
	if _, err := buildOptions(Config{AuthMethod: "nkey", NKeySeed: "garbage"}, m, func() {}); err == nil {
		t.Error("invalid nkey seed must fail")
	}
	if _, err := buildOptions(Config{AuthMethod: "jwt"}, m, func() {}); err == nil {
		t.Error("jwt without creds must fail")
	}
	if _, err := buildOptions(Config{AuthMethod: "userpass", User: "u", Pass: "p", TLS: true}, m, func() {}); err != nil {
		t.Errorf("userpass+tls should build: %v", err)
	}
}

func TestStatusOfUnknownConnection(t *testing.T) {
	s := NewStore()
	st := s.GetStatus("nope")
	if st.Connected || st.ID != "nope" {
		t.Fatalf("unexpected status %+v", st)
	}
	if _, err := s.GetNC("nope"); err == nil {
		t.Fatal("GetNC must fail for unknown id")
	}
}

// selfSigned returns a PEM certificate and key for tests.
func selfSigned(t *testing.T, isCA bool) (certPEM, keyPEM string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		IsCA:                  isCA,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
}

func TestTLSConfigFromPEM(t *testing.T) {
	ca, _ := selfSigned(t, true)
	cert, key := selfSigned(t, false)

	tc, err := tlsConfigFor(Config{TLSCA: ca, TLSCert: cert, TLSKey: key})
	if err != nil {
		t.Fatal(err)
	}
	if tc.RootCAs == nil || len(tc.Certificates) != 1 || tc.InsecureSkipVerify {
		t.Fatalf("unexpected tls config: %+v", tc)
	}
	if tc, err := tlsConfigFor(Config{TLS: true, TLSInsecure: true}); err != nil || !tc.InsecureSkipVerify || tc.RootCAs != nil {
		t.Fatalf("insecure config: %v %+v", err, tc)
	}
	if _, err := tlsConfigFor(Config{TLSCA: "not a pem"}); err == nil {
		t.Error("garbage CA must fail")
	}
	if _, err := tlsConfigFor(Config{TLSCert: cert}); err == nil {
		t.Error("certificate without key must fail")
	}
	if _, err := tlsConfigFor(Config{TLSCert: cert, TLSKey: "garbage"}); err == nil {
		t.Error("broken key must fail")
	}
	// buildOptions wires it in and surfaces the error.
	if _, err := buildOptions(Config{TLS: true, TLSCA: "garbage"}, &Managed{}, func() {}); err == nil {
		t.Error("buildOptions must reject a broken CA")
	}
}
