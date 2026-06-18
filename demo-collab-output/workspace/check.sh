#!/usr/bin/env bash
out=$(bash stats.sh 3 1 4 1 5)
expected=$'count=5\nsum=14\nmin=1\nmax=5'
if [ "$out" = "$expected" ]; then echo PASS; else echo 'FAIL:'; echo "$out"; exit 1; fi
