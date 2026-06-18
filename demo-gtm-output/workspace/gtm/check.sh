#!/usr/bin/env bash
set -uo pipefail
F=gtm/brief.md
fail(){ echo "FAIL: $1"; exit 1; }
test -f "$F" || fail "gtm/brief.md missing"
for s in "## Market Size" "## Competitors" "## Risks" "## Recommendation" "## Sources"; do
  grep -qF "$s" "$F" || fail "missing section: $s"
done
grep -Eiq '\$[0-9][0-9.,]*[[:space:]]*(b|m|bn|billion|million|tn|trillion)' "$F" || fail "no TAM dollar figure with magnitude (e.g. \$12B)"
grep -Eq '^\|?[[:space:]]*:?-{3,}' "$F" || fail "Competitors must be a markdown table (no |---| separator row)"
rows=$(grep -cE '^[[:space:]]*\|.*\|' "$F"); [ "$rows" -ge 5 ] || fail "competitor table needs header+separator+>=3 rows (got $rows pipe-rows)"
risks=$(grep -cE '^[[:space:]]*[-*][[:space:]]+' "$F"); [ "$risks" -ge 3 ] || fail "need >=3 bullet items (got $risks)"
grep -Eq '\b(NO-?GO|GO)\b' "$F" || fail "no explicit GO / NO-GO recommendation"
src=$(grep -coE 'https?://' "$F"); [ "$src" -ge 3 ] || fail "need >=3 source URLs (got $src)"
bytes=$(wc -c < "$F"); [ "$bytes" -ge 1200 ] || fail "brief too thin ($bytes bytes, need >=1200)"
echo "ALL CHECKS PASS"
