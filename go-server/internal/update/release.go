package update

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// LatestURL is GitHub's answer to "which release is the newest", the same
// one the status bar's hint asks.
const LatestURL = "https://api.github.com/repos/blanpa/nats-explorer/releases/latest"

const (
	sumsName = "SHA256SUMS.txt"
	sigName  = "SHA256SUMS.txt.sig"
	// maxAsset bounds a download; the largest desktop package is ~30 MB.
	maxAsset = 512 << 20
)

// The release job signs SHA256SUMS.txt with the private half of this key
// (the UPDATE_SIGNING_KEY secret). The checksums alone come from the same
// place as the files they describe: whoever could replace one could replace
// both. A signature made outside of GitHub is what makes a release ours.
// Anyone can check one by hand:
//
//	openssl pkeyutl -verify -rawin -pubin -inkey release-key.pem -in SHA256SUMS.txt -sigfile SHA256SUMS.txt.sig
//
//go:embed release-key.pem
var releaseKeyPEM []byte

func releaseKey() (ed25519.PublicKey, error) {
	block, _ := pem.Decode(releaseKeyPEM)
	if block == nil {
		return nil, errors.New("release key: no PEM block")
	}
	k, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("release key: %w", err)
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("release key: %T is not Ed25519", k)
	}
	return pub, nil
}

// release is the part of GitHub's release that an update needs.
type release struct {
	Tag     string
	Version string
	// Assets maps a file name to where it is downloaded from.
	Assets map[string]string
}

func (u *Updater) latest(ctx context.Context) (*release, error) {
	data, err := u.get(ctx, u.api, 4<<20)
	if err != nil {
		return nil, fmt.Errorf("asking for the newest release: %w", err)
	}
	var body struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, fmt.Errorf("reading the newest release: %w", err)
	}
	if body.TagName == "" {
		return nil, errors.New("the newest release has no tag")
	}
	rel := &release{Tag: body.TagName, Version: strings.TrimPrefix(body.TagName, "v"), Assets: map[string]string{}}
	for _, a := range body.Assets {
		rel.Assets[a.Name] = a.URL
	}
	return rel, nil
}

// verifiedSums downloads the checksums of a release and returns them only
// when the release key signed them.
func (u *Updater) verifiedSums(ctx context.Context, rel *release) (map[string]string, error) {
	sumsURL, sigURL := rel.Assets[sumsName], rel.Assets[sigName]
	if sumsURL == "" || sigURL == "" {
		return nil, fmt.Errorf("release %s is not signed: install it by hand", rel.Tag)
	}
	sums, err := u.get(ctx, sumsURL, 1<<20)
	if err != nil {
		return nil, fmt.Errorf("downloading %s: %w", sumsName, err)
	}
	sig, err := u.get(ctx, sigURL, 1<<10)
	if err != nil {
		return nil, fmt.Errorf("downloading %s: %w", sigName, err)
	}
	return u.verify(sums, sig, "the checksums of release "+rel.Tag)
}

// verify returns the checksums only when the release key signed them.
func (u *Updater) verify(sums, sig []byte, what string) (map[string]string, error) {
	if u.key == nil {
		return nil, errors.New("this build has no release key to check an update with")
	}
	if !ed25519.Verify(u.key, sums, sig) {
		return nil, fmt.Errorf("%s do not carry the release key's signature", what)
	}
	return parseSums(sums), nil
}

// fileSum is the SHA-256 of a file, as sha256sum writes it.
func fileSum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// parseSums reads sha256sum's output: "<hex>  <name>", or "<hex> *<name>"
// for a file read in binary mode.
func parseSums(data []byte) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) != 2 || len(fields[0]) != sha256.Size*2 {
			continue
		}
		out[strings.TrimPrefix(fields[1], "*")] = strings.ToLower(fields[0])
	}
	return out
}

// get reads a small file, at most limit bytes of it.
func (u *Updater) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	resp, err := u.do(ctx, url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", url, limit)
	}
	return data, nil
}

func (u *Updater) do(ctx context.Context, url string) (*http.Response, error) {
	if !strings.HasPrefix(url, "https://") {
		return nil, fmt.Errorf("refusing a download over plain HTTP: %s", url)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "nats-explorer/"+u.current)
	if url == u.api {
		req.Header.Set("Accept", "application/vnd.github+json")
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%s answered %s", url, resp.Status)
	}
	return resp, nil
}

// download writes a release file to a temporary file and returns its path
// once its SHA-256 is the one the signed checksums name.
func (u *Updater) download(ctx context.Context, url, want string, progress func(done, total int64)) (string, error) {
	resp, err := u.do(ctx, url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	f, err := os.CreateTemp("", "nats-explorer-update-*")
	if err != nil {
		return "", err
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(f.Name())
		}
	}()
	h := sha256.New()
	counted := &counter{total: resp.ContentLength, progress: progress}
	n, err := io.Copy(io.MultiWriter(f, h, counted), io.LimitReader(resp.Body, maxAsset+1))
	if err != nil {
		return "", err
	}
	if n > maxAsset {
		return "", fmt.Errorf("%s is larger than %d MB", url, maxAsset>>20)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return "", fmt.Errorf("the download's checksum is %s, the release lists %s", got, want)
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	ok = true
	return f.Name(), nil
}

// counter reports how far a download is, in steps of a percent or so.
type counter struct {
	done, total, last int64
	progress          func(done, total int64)
}

func (c *counter) Write(p []byte) (int, error) {
	c.done += int64(len(p))
	if c.progress != nil && (c.done-c.last > 256<<10 || c.done == c.total) {
		c.last = c.done
		c.progress(c.done, c.total)
	}
	return len(p), nil
}
