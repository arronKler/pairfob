package wsnet

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"strings"
)

// ClientTLSConfig appends PAIRFOB_TLS_CA to the system roots. Unset means
// default verification. The extra file is for a local-dev CA, not to skip TLS.
func ClientTLSConfig() (*tls.Config, error) {
	path := strings.TrimSpace(os.Getenv("PAIRFOB_TLS_CA"))
	if path == "" {
		return nil, nil
	}
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("PAIRFOB_TLS_CA: %w", err)
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("PAIRFOB_TLS_CA: no certificates in %s", path)
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}, nil
}
