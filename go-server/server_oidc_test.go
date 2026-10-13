package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"nats-explorer/internal/auth"
)

// fakeIssuer is the smallest OpenID provider: discovery, keys, an authorize
// endpoint that consents at once, and a token endpoint that checks the
// PKCE verifier and signs an ID token with the claims it was given.
type fakeIssuer struct {
	srv    *httptest.Server
	key    *rsa.PrivateKey
	mu     sync.Mutex
	claims map[string]interface{}
	codes  map[string][2]string // code -> nonce, challenge
}

func newFakeIssuer(t *testing.T) *fakeIssuer {
	t.Helper()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	f := &fakeIssuer{key: key, codes: map[string][2]string{}}
	mux := http.NewServeMux()
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	iss := f.srv.URL
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"issuer": iss, "authorization_endpoint": iss + "/authorize", "token_endpoint": iss + "/token",
			"jwks_uri": iss + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		code := "code-" + q.Get("state")
		f.mu.Lock()
		f.codes[code] = [2]string{q.Get("nonce"), q.Get("code_challenge")}
		f.mu.Unlock()
		http.Redirect(w, r, q.Get("redirect_uri")+"?code="+code+"&state="+q.Get("state"), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		f.mu.Lock()
		pending, ok := f.codes[r.Form.Get("code")]
		claims := map[string]interface{}{}
		for k, v := range f.claims {
			claims[k] = v
		}
		f.mu.Unlock()
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != pending[1] {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		now := time.Now().Unix()
		claims["iss"], claims["aud"], claims["nonce"], claims["iat"], claims["exp"] = iss, "explorer", pending[0], now, now+300
		signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: "k1"}}, nil)
		payload, _ := json.Marshal(claims)
		jws, _ := signer.Sign(payload)
		token, _ := jws.CompactSerialize()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"access_token": "at", "token_type": "Bearer", "id_token": token, "expires_in": 300})
	})
	return f
}

// login runs the browser's part: the explorer's login, the provider's
// consent, the callback; it returns the status of the last step and who
// the explorer thinks is signed in.
func oidcLogin(t *testing.T, base string) (int, map[string]interface{}) {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	res, err := c.Get(base + "/api/oidc/login")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	// The callback ends on the UI's root, which this test server does not
	// serve: arriving there is the success.
	if res.Request.URL.Path != "/" {
		return res.StatusCode, nil
	}
	res, err = c.Get(base + "/api/auth")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var who map[string]interface{}
	json.NewDecoder(res.Body).Decode(&who)
	return 200, who
}

// Single sign-on: the provider decides who gets in, a group claim decides
// the role, another claim the connections, and a login without an allowed
// group is refused.
func TestServerOIDC(t *testing.T) {
	f := newFakeIssuer(t)
	srv := newTestServer(t, serverConfig{oidc: &auth.OIDCConfig{
		Issuer: f.srv.URL, ClientID: "explorer", ClientSecret: "s",
		AdminValues: []string{"nats-admins"}, AllowedValues: []string{"nats-users"}, ConnectionsClaim: "nats_connections",
	}})

	var info map[string]interface{}
	(&apiClient{t: t, base: srv.URL}).do("GET", "/api/auth", nil, &info)
	if info["mode"] != "oidc" || info["oidc"] != true || info["authenticated"] != false {
		t.Fatalf("auth info before login = %v", info)
	}

	f.claims = map[string]interface{}{"sub": "1", "preferred_username": "pascal", "groups": []string{"nats-admins"}}
	st, who := oidcLogin(t, srv.URL)
	if st != 200 || who["authenticated"] != true || who["user"] != "pascal" || who["role"] != "admin" {
		t.Fatalf("admin login: %d %v", st, who)
	}

	f.claims = map[string]interface{}{"sub": "2", "email": "anna@example.com", "groups": "nats-users", "nats_connections": []string{"lab*"}}
	st, who = oidcLogin(t, srv.URL)
	conns, _ := who["connections"].([]interface{})
	if st != 200 || who["user"] != "anna@example.com" || who["role"] != "viewer" || len(conns) != 1 || conns[0] != "lab*" {
		t.Fatalf("viewer login: %d %v", st, who)
	}

	f.claims = map[string]interface{}{"sub": "3", "preferred_username": "mallory", "groups": []string{"marketing"}}
	if st, _ := oidcLogin(t, srv.URL); st != http.StatusForbidden {
		t.Fatalf("a login outside the allowed groups: %d", st)
	}

	// A callback that was not started here is refused.
	res, _ := http.Get(srv.URL + "/api/oidc/callback?code=x&state=y")
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("a foreign callback: %d", res.StatusCode)
	}
}
