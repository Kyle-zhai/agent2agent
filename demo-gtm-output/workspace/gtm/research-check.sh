#!/usr/bin/env bash
set -uo pipefail
F=gtm/research.md
fail(){ echo "FAIL: $1"; exit 1; }
test -f "$F" || fail "gtm/research.md missing"
grep -Eiq '\$[0-9]' "$F" || fail "no dollar/market figure"
b=$(grep -cE '^[[:space:]]*[-*][[:space:]]+' "$F"); [ "$b" -ge 3 ] || fail "need >=3 bullet facts (got $b)"
grep -Eiq 'risk' "$F" || fail "no risks mentioned"
s=$(grep -coE 'https?://' "$F"); [ "$s" -ge 2 ] || fail "need >=2 source URLs (got $s)"
bytes=$(wc -c < "$F"); [ "$bytes" -ge 500 ] || fail "research too thin ($bytes bytes)"
echo "RESEARCH OK"
