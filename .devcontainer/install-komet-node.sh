#!/usr/bin/env bash
#
# Installs komet-node (the local Stellar testnet on K semantics) into a
# dedicated uv-managed virtualenv and builds its kompiled semantics.
#
# Prerequisites (provided by the Dockerfile): uv on PATH, and the `komet` /
# K toolchain installed via kup (so `kdist`/`kompile` are available).
#
# Result: `source $KOMET_NODE_VENV/bin/activate` then
#         `python -m komet_node --trace` runs the node.
set -euo pipefail

export PATH="/home/node/.nix-profile/bin:/home/node/.local/bin:${PATH}"

VENV="${KOMET_NODE_VENV:-/home/node/.komet-node}"
KOMET_NODE_REF="${KOMET_NODE_REF:-main}"

echo ">>> Creating komet-node venv at ${VENV}"
uv venv --python 3.10 "${VENV}"
# shellcheck disable=SC1091
source "${VENV}/bin/activate"

echo ">>> Installing komet-node from git (@${KOMET_NODE_REF})"
uv pip install "git+https://github.com/runtimeverification/komet-node.git@${KOMET_NODE_REF}"

echo ">>> Building komet-node kdist semantics"
# Builds the node semantics on top of the komet/KWasm semantics. This is the
# slow step; it reuses prebuilt komet artifacts from the kup install.
#
# kup installs `komet` as a makeWrapper script that injects the K binaries
# (kompile, krun, ...) onto komet's *own* PATH only — they aren't exposed
# globally. kdist invokes `kompile` directly, so locate K's bin dir from the
# komet wrapper and put it on PATH (grep -a so it works whether the wrapper is
# a shell script or a compiled binary wrapper; the store paths are embedded in
# both).
#
# NOTE: reference the kup wrapper by its explicit nix-profile path, NOT via
# `command -v komet`. The activated venv installs its own `komet` console
# script that shadows the wrapper but contains no /nix/store paths.
KUP_KOMET="${HOME}/.nix-profile/bin/komet"
if ! command -v kompile >/dev/null 2>&1; then
  komet_wrapper="$(readlink -f "${KUP_KOMET}")"
  for d in $(grep -aoE "/nix/store/[^\"' :]+/bin" "${komet_wrapper}" | sort -u); do
    if [ -x "${d}/kompile" ]; then
      export PATH="${d}:${PATH}"
      break
    fi
  done
fi
command -v kompile >/dev/null 2>&1 || {
  echo "ERROR: could not locate kompile (K framework) via the komet wrapper" >&2
  exit 1
}

# Align the venv's pyk to the kompile that will build the kdist targets. The
# komet-node wheel pins `kframework<7.1.321` (kast JSON format v3), but the
# kup-installed K binaries are newer and emit a later format. pyk validates the
# kast version when it reads `compiled.json`, so a pyk older than the kompile
# that produced the artifact aborts with `Invalid version: N` and the node dies
# on its first request. The invariant is "pyk must match kompile", so we install
# the matching kframework version, overriding the wheel's upper-bound pin.
K_VERSION="$(kompile --version | sed -n 's/^K version:[[:space:]]*v//p')"
echo ">>> Aligning pyk to K ${K_VERSION}"
uv pip install "kframework==${K_VERSION}"

echo ">>> Building kdist semantics"
# The node imports the four soroban-semantics definitions (llvm, llvm-tracing,
# llvm-library, haskell) at module load time, plus komet-node's own simbolik
# target. Building only 'komet-node.*' leaves the soroban-semantics targets
# unbuilt, so the server crashes on import with
# `Target undefined or not built: soroban-semantics.llvm`.
kdist build 'soroban-semantics.*' 'komet-node.*'

echo ">>> komet-node install complete"
python -m komet_node --help >/dev/null 2>&1 || true
