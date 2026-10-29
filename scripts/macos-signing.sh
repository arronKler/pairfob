#!/usr/bin/env bash
# Stable identity for the standalone daemon; source from builders/publishers.
# Keep this identifier and the release team's identity across daemon versions.
PAIRFOB_MACOS_IDENTIFIER=com.pairfob.daemon

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
  if [[ "${PAIRFOB_ALLOW_UNSIGNED_MACOS:-0}" == 1 ]]; then
    echo 'WARNING: macOS release without a Developer ID certificate; privacy grants may reset after updates.' >&2
    pairfob_require_adhoc_host
    return $?
  fi
  pairfob_require_macos_signing_host || return 1
  if [[ -z "${PAIRFOB_MACOS_SIGN_IDENTITY:-}" || "$PAIRFOB_MACOS_SIGN_IDENTITY" == - ]]; then
    echo 'Set PAIRFOB_MACOS_SIGN_IDENTITY to a Developer ID Application identity (name or SHA-1).' >&2
    echo 'For an explicit release without a certificate, set PAIRFOB_ALLOW_UNSIGNED_MACOS=1.' >&2
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
    else
      pairfob_verify_macos_binary "$directory/pairfob-darwin-$arch" || return 1
    fi
  done
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
