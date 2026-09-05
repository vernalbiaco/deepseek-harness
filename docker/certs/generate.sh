#!/bin/sh
# Mint a local CA and one leaf certificate for the Traefik HTTPS routes in
# docker-compose.raven.yml. The Web UI needs a browser secure context, which
# plain HTTP grants only to 127.0.0.1 and *.localhost names; HTTPS earns it
# for the RavenStack hostnames too.
#
# Output goes to certs/ at the repository root, which is gitignored: the key
# is a credential and must never be committed. Re-running replaces both files.
set -eu

out="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)/certs"
days_ca=3650
days_leaf=825   # Safari and Chrome reject a leaf valid for longer.

mkdir -p "$out"
chmod 700 "$out"

# The CA. Trusting this one certificate is what removes the browser warning;
# the leaf below is reissued without retrusting anything.
if [ ! -f "$out/ca.key" ]; then
  openssl req -x509 -newkey rsa:4096 -sha256 -days "$days_ca" -nodes \
    -keyout "$out/ca.key" -out "$out/ca.crt" \
    -subj "/CN=DeepSeek Harness local CA/O=DeepSeek Harness" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi

# The leaf. Every name the override routes must appear in subjectAltName;
# browsers ignore the Common Name.
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$out/harness.key" -out "$out/harness.csr" \
  -subj "/CN=harness.local.raven.com" 2>/dev/null

cat > "$out/harness.ext" <<'EXT'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:harness.local.raven.com,DNS:harness-api.local.raven.com,DNS:harness.localhost,DNS:harness-api.localhost,DNS:harness.ernestojpamajr.com,DNS:omni.localhost,DNS:omni.ernestojpamajr.com,IP:127.0.0.1
EXT

openssl x509 -req -in "$out/harness.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" \
  -CAcreateserial -out "$out/harness.crt" -days "$days_leaf" -sha256 \
  -extfile "$out/harness.ext" 2>/dev/null

rm -f "$out/harness.csr" "$out/harness.ext"
chmod 600 "$out"/*.key
chmod 644 "$out"/*.crt

echo "wrote $out/harness.crt (leaf) and $out/ca.crt (CA)"
openssl x509 -in "$out/harness.crt" -noout -dates -ext subjectAltName
