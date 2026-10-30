#!/bin/bash
# A certificate for the computer host from a private CA that can sign for exactly one
# name (COMPUTERS_2026-10.md D18), and nothing else:
#
#   bash private-tls.sh <domain> <output directory>
#
# Writes <out>/ca.pem (the CA certificate, for the web VM's NODE_EXTRA_CA_CERTS),
# <out>/cert.pem and <out>/key.pem (the host's, for nginx). The CA is EC P-256 with a
# CRITICAL nameConstraints extension permitting only <domain>, so trusting it adds trust
# in that one name: a certificate it signed for any other name fails verification. The
# CA's private key exists only in a temporary directory while the host certificate is
# signed, and is then shredded: nobody can sign anything else with it, ever. Renewal
# (setup.sh --renew-tls) makes a new CA; the web VM's trust file may hold both during
# the switch.
set -euo pipefail
DOMAIN="${1:-}"
OUT="${2:-}"
[ -n "$DOMAIN" ] && [ -n "$OUT" ] || { echo "usage: private-tls.sh <domain> <output directory>" >&2; exit 2; }
# The certificate names the host as DNS:<domain>, and a client checks an https://<IP>
# origin against IP entries only, so a certificate for an address is never trusted.
if [[ "$DOMAIN" =~ ^[0-9.]+$ || "$DOMAIN" == *:* ]]; then
  echo "private-tls.sh: the host needs a DNS name, not an IP address ($DOMAIN): a private DNS record or an /etc/hosts line on the web VM will do" >&2; exit 2
fi
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || { echo "private-tls.sh: not a host name: $DOMAIN" >&2; exit 2; }
command -v openssl >/dev/null || { echo "private-tls.sh: openssl is required" >&2; exit 2; }
install -d -m 0755 "$OUT"
WORK="$(mktemp -d)"
cleanup() {
  if [ -f "$WORK/ca.key" ]; then
    if command -v shred >/dev/null; then shred -u "$WORK/ca.key"; else rm -f "$WORK/ca.key"; fi
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
umask 077

cat > "$WORK/ca.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ca
[dn]
CN = Juno computer host CA for $DOMAIN
[ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
nameConstraints = critical, permitted;DNS:$DOMAIN
subjectKeyIdentifier = hash
CNF
cat > "$WORK/host.cnf" <<CNF
[host]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:$DOMAIN
authorityKeyIdentifier = keyid
subjectKeyIdentifier = hash
CNF

openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/ca.key"
openssl req -new -x509 -key "$WORK/ca.key" -days 400 -config "$WORK/ca.cnf" -out "$WORK/ca.pem"
openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/host.key"
openssl req -new -key "$WORK/host.key" -subj "/CN=$DOMAIN" -out "$WORK/host.csr"
openssl x509 -req -in "$WORK/host.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial -days 397 \
  -extfile "$WORK/host.cnf" -extensions host -out "$WORK/host.pem" 2>/dev/null
openssl verify -CAfile "$WORK/ca.pem" "$WORK/host.pem" >/dev/null

install -m 0644 "$WORK/ca.pem" "$OUT/ca.pem"
install -m 0644 "$WORK/host.pem" "$OUT/cert.pem"
install -m 0600 "$WORK/host.key" "$OUT/key.pem"
echo "private-tls: $OUT/cert.pem for $DOMAIN, valid 397 days; CA key destroyed; trust $OUT/ca.pem on the web VM"
