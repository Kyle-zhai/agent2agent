#!/usr/bin/env bash

count=$#
sum=0
min=$1
max=$1

for arg in "$@"; do
    sum=$((sum + arg))
    if [ "$arg" -lt "$min" ]; then
        min=$arg
    fi
    if [ "$arg" -gt "$max" ]; then
        max=$arg
    fi
done

echo "count=$count"
echo "sum=$sum"
echo "min=$min"
echo "max=$max"
