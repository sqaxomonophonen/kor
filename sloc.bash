#!/usr/bin/env bash
echo "3RDPARTY:"
wc -l $(git ls-files | grep -F stb_)
echo
echo "OURS:"
wc -l $(git ls-files | grep -vF stb_)
