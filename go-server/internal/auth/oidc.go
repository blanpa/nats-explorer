package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Single sign-on: the company's identity provider -- Keycloak, Entra ID,
// Okta, Google, Authentik -- decides who may in, and a claim of the ID
// token decides the role and the connections. The explorer is a
// confidential client with the authorization code flow, PKCE and a nonce;
// a successful login ends in the same session cookie as a password.

// OIDCConfig is what the provider and the mapping need.
type OIDCConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	// RedirectURL is where the provider sends the browser back; empty
	// derives it from the request, which is right behind most proxies.
	RedirectURL string
	// RoleClaim names the claim the admin values are looked for in, a
	// string or a list ("groups" by default).
	RoleClaim string
	// AdminValues make an admin when the claim holds one of them; anyone
	// else who gets in is a viewer.
	AdminValues []string
	// AllowedValues, when set, are required: the claim must hold one of
	// them, or of AdminValues, for the login to succeed at all.
	AllowedValues []string
	// ConnectionsClaim names a claim whose values narrow the connections
	// the user sees; empty or absent sees every connection.
	ConnectionsClaim string
	// BasePath is where the UI lives, to send the browser back to.
	BasePath string
}

type oidcProvider struct {
	cfg      OIDCConfig
	verifier *oidc.IDTokenVerifier
	oauth    oauth2.Config
}

const (
	oidcStateCookie = "ne_oidc"
	oidcFlowTTL     = 10 * time.Minute
)

// EnableOIDC discovers the provider and switches single sign-on on. It
// fails when the issuer cannot be reached: a server told to use SSO must
// not start without it.
func (s *Service) EnableOIDC(ctx context.Context, cfg OIDCConfig) error {
	if cfg.Issuer == "" || cfg.ClientID == "" {
		return errors.New("OIDC needs an issuer and a client id")
	}
	if cfg.RoleClaim == "" {
		cfg.RoleClaim = "groups"
	}
	provider, err := oidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return fmt.Errorf("OIDC discovery at %s: %w", cfg.Issuer, err)
	}
	p := &oidcProvider{
		cfg:      cfg,
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
		oauth: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			Endpoint:     provider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		},
	}
	s.mu.Lock()
	s.oidc = p
	s.mu.Unlock()
	return nil
}

func randomString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// redirectFor is the callback URL: the configured one, or the request's own
// host with the base path, the scheme taken from the proxy where it says.
func (p *oidcProvider) redirectFor(r *http.Request) string {
	if p.cfg.RedirectURL != "" {
		return p.cfg.RedirectURL
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := r.Host
	if fh := r.Header.Get("X-Forwarded-Host"); fh != "" {
		host = fh
	}
	return scheme + "://" + host + p.cfg.BasePath + "/api/oidc/callback"
}

// OIDCLogin answers GET /api/oidc/login: off to the provider, with the
// state, the nonce and the PKCE verifier in a short-lived cookie.
func (s *Service) OIDCLogin(w http.ResponseWriter, r *http.Request) {
	p := s.oidc
	if p == nil {
		writeError(w, http.StatusNotFound, "single sign-on is not configured")
		return
	}
	state, nonce, verifier := randomString(16), randomString(16), randomString(32)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	http.SetCookie(w, &http.Cookie{
		Name: oidcStateCookie, Value: state + "." + nonce + "." + verifier, Path: "/", MaxAge: int(oidcFlowTTL / time.Second),
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
	})
	cfg := p.oauth
	cfg.RedirectURL = p.redirectFor(r)
	url := cfg.AuthCodeURL(state, oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"))
	http.Redirect(w, r, url, http.StatusFound)
}

// claimValues reads a claim that is a string or a list of strings.
func claimValues(claims map[string]interface{}, name string) []string {
	switch v := claims[name].(type) {
	case string:
		return splitPatterns(strings.ReplaceAll(v, " ", ","))
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, x := range v {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func anyOf(have, want []string) bool {
	for _, h := range have {
		for _, w := range want {
			if h == w {
				return true
			}
		}
	}
	return false
}

// identityOf maps the claims of a verified ID token onto an identity, or
// says why the login is refused.
func (p *oidcProvider) identityOf(claims map[string]interface{}) (Identity, error) {
	name, _ := claims["preferred_username"].(string)
	if name == "" {
		name, _ = claims["email"].(string)
	}
	if name == "" {
		name, _ = claims["sub"].(string)
	}
	values := claimValues(claims, p.cfg.RoleClaim)
	role := RoleViewer
	if anyOf(values, p.cfg.AdminValues) {
		role = RoleAdmin
	} else if len(p.cfg.AllowedValues) > 0 && !anyOf(values, p.cfg.AllowedValues) {
		return Identity{}, fmt.Errorf("%s is not in a group allowed in (claim %q)", name, p.cfg.RoleClaim)
	}
	id := Identity{Name: name, Role: role}
	if p.cfg.ConnectionsClaim != "" {
		id.Connections = claimValues(claims, p.cfg.ConnectionsClaim)
	}
	return id, nil
}

// OIDCCallback answers GET /api/oidc/callback: the code is exchanged, the
// ID token verified against the nonce, the claims mapped, and the browser
// sent back to the UI with a session.
func (s *Service) OIDCCallback(w http.ResponseWriter, r *http.Request) {
	p := s.oidc
	if p == nil {
		writeError(w, http.StatusNotFound, "single sign-on is not configured")
		return
	}
	fail := func(status int, msg string) {
		http.SetCookie(w, &http.Cookie{Name: oidcStateCookie, Value: "", Path: "/", MaxAge: -1})
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(status)
		fmt.Fprintf(w, "Sign-in failed: %s\n", msg)
	}
	if e := r.URL.Query().Get("error"); e != "" {
		fail(http.StatusUnauthorized, e+": "+r.URL.Query().Get("error_description"))
		return
	}
	c, err := r.Cookie(oidcStateCookie)
	if err != nil {
		fail(http.StatusBadRequest, "the sign-in took too long or started in another browser; start it again")
		return
	}
	parts := strings.SplitN(c.Value, ".", 3)
	if len(parts) != 3 || parts[0] != r.URL.Query().Get("state") {
		fail(http.StatusBadRequest, "the state does not match; start the sign-in again")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	cfg := p.oauth
	cfg.RedirectURL = p.redirectFor(r)
	tok, err := cfg.Exchange(ctx, r.URL.Query().Get("code"), oauth2.SetAuthURLParam("code_verifier", parts[2]))
	if err != nil {
		fail(http.StatusBadGateway, "the code exchange failed: "+err.Error())
		return
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		fail(http.StatusBadGateway, "the provider sent no ID token")
		return
	}
	idt, err := p.verifier.Verify(ctx, raw)
	if err != nil {
		fail(http.StatusUnauthorized, "the ID token does not verify: "+err.Error())
		return
	}
	if idt.Nonce != parts[1] {
		fail(http.StatusUnauthorized, "the nonce does not match")
		return
	}
	var claims map[string]interface{}
	if err := idt.Claims(&claims); err != nil {
		fail(http.StatusBadGateway, err.Error())
		return
	}
	id, err := p.identityOf(claims)
	if err != nil {
		fail(http.StatusForbidden, err.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oidcStateCookie, Value: "", Path: "/", MaxAge: -1})
	http.SetCookie(w, s.cookie(r, s.NewSession(id), int(SessionTTL/time.Second)))
	http.Redirect(w, r, p.cfg.BasePath+"/", http.StatusFound)
}
