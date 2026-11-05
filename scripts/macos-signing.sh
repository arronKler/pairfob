#!/usr/bin/env bash
# Stable identity for the standalone daemon; source from builders/publishers.
# Keep this identifier and the release team's identity across daemon versions.
PAIRFOB_MACOS_IDENTIFIER=com.pairfob.daemon

# Without a Developer ID, the daemon is signed with the project's self-signed
# "Pairfob Daemon Signing" certificate. TCC pins that certificate's leaf hash,
# not the binary hash, so privacy grants survive daemon updates. Import the
# certificate and its private key into the release Mac's keychain; do not
# regenerate it per release. Rotating it costs every user one privacy re-grant.
PAIRFOB_MACOS_SELF_SIGNED_SHA1=71410343DFD9A3EBE420FEEC337B3AA94AFE6729

pairfob_require_macos_signing_host() {
  if [[ "$(uname -s)" != Darwin ]] || ! command -v codesign >/dev/null 2>&1; then
    echo 'macOS release signing/verification requires a Mac with codesign.' >&2
    return 1
  fi
  if [[ ! "${PAIRFOB_MACOS_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ ]]; then
    echo 'Set PAIRFOB_MACOS_TEAM_ID to the release Apple Developer Team ID (10 characters).' >&2
    return 1
  fi
}

pairfob_prepare_macos_signing() {
  if [[ "${PAIRFOB_ALLOW_UNSIGNED_MACOS:-0}" == 1 && "${PAIRFOB_MACOS_SELF_SIGNED:-0}" == 1 ]]; then
    echo 'Set either PAIRFOB_ALLOW_UNSIGNED_MACOS or PAIRFOB_MACOS_SELF_SIGNED, not both.' >&2
    return 1
  fi
  if [[ "${PAIRFOB_MACOS_SELF_SIGNED:-0}" == 1 ]]; then
    pairfob_require_adhoc_host || return 1
    pairfob_require_self_signed_identity || return 1
    return 0
  fi
  if [[ "${PAIRFOB_ALLOW_UNSIGNED_MACOS:-0}" == 1 ]]; then
    echo 'WARNING: macOS release without a Developer ID certificate; privacy grants may reset after updates.' >&2
    pairfob_require_adhoc_host
    return $?
  fi
  pairfob_require_macos_signing_host || return 1
  if [[ -z "${PAIRFOB_MACOS_SIGN_IDENTITY:-}" || "$PAIRFOB_MACOS_SIGN_IDENTITY" == - ]]; then
    echo 'Set PAIRFOB_MACOS_SIGN_IDENTITY to a Developer ID Application identity (name or SHA-1).' >&2
    echo 'For a release without a certificate, set PAIRFOB_ALLOW_UNSIGNED_MACOS=1.' >&2
    return 1
  fi
}

pairfob_verify_macos_binary() {
  local binary="$1" details requirement
  pairfob_require_macos_signing_host || return 1
  requirement="anchor apple generic and identifier \"$PAIRFOB_MACOS_IDENTIFIER\" and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"$PAIRFOB_MACOS_TEAM_ID\""
  codesign --verify --strict --test-requirement "=$requirement" "$binary" || return 1
  details="$(codesign --display --verbose=4 --requirements - "$binary" 2>&1)" || return 1
  # A valid certificate alone is insufficient if a custom DR pins this build's
  # hash. Reject that and require the timestamp used for distribution signing.
  if [[ "$details" == *cdhash* || "$details" != *Timestamp=* || "$details" != *designated\ =\>* ]]; then
    echo "macOS artifact lacks a stable, timestamped signing identity: $binary" >&2
    return 1
  fi
}

pairfob_sign_macos_binary() {
  local binary="$1"
  if [[ "${PAIRFOB_ALLOW_UNSIGNED_MACOS:-0}" == 1 ]]; then
    pairfob_require_adhoc_host || return 1
    codesign --force --sign - --identifier "$PAIRFOB_MACOS_IDENTIFIER" "$binary" || return 1
    pairfob_verify_adhoc_binary "$binary"
    return $?
  fi
  if [[ "${PAIRFOB_MACOS_SELF_SIGNED:-0}" == 1 ]]; then
    pairfob_require_adhoc_host || return 1
    # Address the certificate by hash: name lookup also matches a different
    # certificate with the same common name.
    codesign --force --sign "$PAIRFOB_MACOS_SELF_SIGNED_SHA1" \
      --identifier "$PAIRFOB_MACOS_IDENTIFIER" --options runtime --timestamp "$binary" || return 1
    pairfob_verify_self_signed_binary "$binary"
    return $?
  fi
  codesign --force --sign "$PAIRFOB_MACOS_SIGN_IDENTITY" \
    --identifier "$PAIRFOB_MACOS_IDENTIFIER" --options runtime --timestamp "$binary" || return 1
  pairfob_verify_macos_binary "$binary"
}

pairfob_verify_macos_release() {
  local directory="$1" arch
  # Explicit no-certificate publication still verifies both ad-hoc signatures.
  for arch in amd64 arm64; do
    if [[ "${PAIRFOB_ALLOW_UNSIGNED_MACOS:-0}" == 1 ]]; then
      pairfob_verify_adhoc_binary "$directory/pairfob-darwin-$arch" || return 1
    elif [[ "${PAIRFOB_MACOS_SELF_SIGNED:-0}" == 1 ]]; then
      pairfob_verify_self_signed_binary "$directory/pairfob-darwin-$arch" || return 1
    else
      pairfob_verify_macos_binary "$directory/pairfob-darwin-$arch" || return 1
    fi
  done
}

# The certificate must be imported and usable, but it does not need to be
# trusted for code signing: codesign can sign and verify with the embedded
# chain. TCC matches the designated requirement, not the trust anchor.
pairfob_require_self_signed_identity() {
  local sha="$PAIRFOB_MACOS_SELF_SIGNED_SHA1"
  if [[ ! "$sha" =~ ^[0-9A-Fa-f]{40}$ ]]; then
    echo 'Set PAIRFOB_MACOS_SELF_SIGNED_SHA1 in scripts/macos-signing.sh to the 40-character certificate SHA-1.' >&2
    return 1
  fi
  if ! security find-identity -p codesigning 2>/dev/null | grep -qi "$sha"; then
    echo "The self-signed daemon certificate $sha is not in a keychain on this Mac." >&2
    echo 'Import it with: security import pairfob-daemon-signing.p12 -k "$HOME/Library/Keychains/login.keychain-db" -P <password> -T /usr/bin/codesign' >&2
    return 1
  fi
}

# A stable self-signed identity pins the certificate leaf, never a cdhash.
# Requires an embedded timestamp so the signature outlives the certificate.
pairfob_verify_self_signed_binary() {
  local binary="$1" details designated lower pin test_requirement
  pairfob_require_adhoc_host || return 1
  pin="$(printf '%s' "$PAIRFOB_MACOS_SELF_SIGNED_SHA1" | tr '[:upper:]' '[:lower:]')"
  test_requirement="identifier \"$PAIRFOB_MACOS_IDENTIFIER\" and certificate leaf = H\"$pin\""
  # Evaluate the signing certificate itself, not only the displayed DR: a
  # custom requirement could otherwise name this certificate while the binary
  # is signed by another one.
  codesign --verify --strict --test-requirement "=$test_requirement" "$binary" || return 1
  details="$(codesign --display --verbose=4 --requirements - "$binary" 2>&1)" || return 1
  designated="$(printf '%s\n' "$details" | sed -n 's/^designated => //p')"
  lower="$(printf '%s' "$designated" | tr '[:upper:]' '[:lower:]')"
  details=$'\n'"$details"$'\n'
  if [[ "$details" != *$'\n'"Identifier=$PAIRFOB_MACOS_IDENTIFIER"$'\n'* ||
        "$details" == *$'\nSignature=adhoc\n'* ||
        "$details" != *$'\nTeamIdentifier=not set'$'\n'* ||
        "$details" != *$'\ndesignated => '* ||
        "$details" != *$'\nTimestamp='* ||
        "$lower" == *cdhash* ||
        "$lower" != *"certificate leaf = h\"$pin\""* ]]; then
    echo "macOS artifact lacks the stable self-signed identity: $binary" >&2
    return 1
  fi
}

# Ad-hoc signing validates executable integrity but provides no publisher identity.
pairfob_require_adhoc_host() {
  if [[ "$(uname -s)" != Darwin ]] || ! command -v codesign >/dev/null 2>&1; then
    echo 'No-certificate macOS releases require a Mac with codesign.' >&2
    return 1
  fi
}

pairfob_verify_adhoc_binary() {
  local binary="$1" details
  pairfob_require_adhoc_host || return 1
  codesign --verify --strict "$binary" || return 1
  details="$(codesign --display --verbose=4 "$binary" 2>&1)" || return 1
  details=$'\n'"$details"$'\n'
  if [[ "$details" != *$'\n'"Identifier=$PAIRFOB_MACOS_IDENTIFIER"$'\n'* || "$details" != *$'\nSignature=adhoc\n'* || "$details" != *$'\nTeamIdentifier=not set\n'* ]]; then
    echo "expected a valid Pairfob ad-hoc signature: $binary" >&2
    return 1
  fi
}
