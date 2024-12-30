#!/usr/bin/env bash
set -e
cd $(dirname $0)

# tested with:
#    clang-16 on debian
#    clang19  on FreeBSD
try_clangs="clang-16 clang19"

for clang in $try_clangs ; do
	CLANG=$(which $clang || true)
	if [ -n "$CLANG" ] ; then
		break
	fi
done
if [ -z $CLANG ] ; then
	echo "none of the binaries in try_clangs (\"$try_clangs\") were found (if you do have clang you can try extending the try_clangs list)"
	exit 1
fi
echo "using clang=$CLANG"
out="../atlasworker_c.wasm"
$CLANG \
	-O2 \
	-Wall \
	-std=c11 \
	--target=wasm32 \
	-mbulk-memory \
	-msimd128 \
	-nostdlib \
	-Wl,--no-entry \
	-Wl,--import-memory \
	-Wl,--export-dynamic \
	-Wl,--unresolved-symbols=import-dynamic \
	-o $out atlasworker_c.c

echo "Artifacts:"
wc -c $out
