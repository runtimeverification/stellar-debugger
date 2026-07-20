#!/usr/bin/env bash
#
# dev.sh — one entry point for working across the semantics chain.
#
#   stellar-debugger  ->  komet-node  ->  komet  ->  wasm-semantics
#
# You only need this when you are CHANGING the semantics. For plain debugging the
# devcontainer already has the komet-node binary (via `kup`) — just press F5.
#
# When you are changing the semantics:
#
#   ./scripts/dev.sh setup     # check out the chain + wire it together
#   …edit .deps/wasm-semantics or .deps/komet…
#   ./scripts/dev.sh build     # fast incremental rebuild
#   ./scripts/dev.sh use       # make it the debugger's komet-node, then press F5
#
# When you are upstreaming that change as PRs across the repos:
#
#   ./scripts/dev.sh pr status <branch>              # what would be opened
#   ./scripts/dev.sh pr open   <branch> [--draft] [--dry-run]
#
# Everything below (nix, uv, kdist, checkouts) is plumbing this script drives for
# you — you never run those directly. The chain is pinned by uv git dependencies,
# not flake inputs, which is why local iteration needs checkouts wired with uv
# path sources rather than `kup --override`. Details: CONTRIBUTING.md.
#
set -euo pipefail

# --- configuration ---------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN_DIR="${DEV_DEPS_DIR:-$REPO_ROOT/.deps}"
GH_ORG="https://github.com/runtimeverification"
# Leaf -> root: build/PR order so an upstream checkout/PR always exists first.
CHAIN_ORDER=(wasm-semantics komet komet-node)

SENTINEL_OPEN="# >>> dev.sh: local path sources (generated; do not commit) >>>"
SENTINEL_CLOSE="# <<< dev.sh <<<"

# `pr link` pin rewrites: repo|dep|tag-pin-regex|url-prefix|url-suffix
LINK_KOMET_NODE='komet-node|komet|komet.git@v[0-9.]*|komet.git@|'
LINK_KOMET='komet|pykwasm|wasm-semantics.git@v[0-9.]*#subdirectory=pykwasm|wasm-semantics.git@|#subdirectory=pykwasm'

log()  { printf '\033[1;34m[dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[dev]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[dev]\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"; }

# --- checkout helpers ------------------------------------------------------

dir_of()     { printf '%s/%s' "$CHAIN_DIR" "$1"; }
default_of() { git -C "$(dir_of "$1")" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'; }

# Ensure <repo> is checked out under .deps/ with tags available. Clones if
# absent, otherwise fetches (branches + tags). Does NOT move HEAD.
fetch_repo() {
  local repo="$1" dir; dir="$(dir_of "$1")"
  if [[ -d "$dir/.git" ]]; then
    log "fetching $repo"
    git -C "$dir" fetch --quiet --tags origin
  else
    log "cloning $repo"
    git clone --quiet "$GH_ORG/$repo.git" "$dir"
  fi
}

# Move <repo> to <rev>. Refuses if the tree carries real local work (ignoring the
# generated path-source block + relock churn), so we never discard a dev's edits.
checkout_rev() {
  local repo="$1" rev="$2" dir; dir="$(dir_of "$1")"
  if ! git -C "$dir" diff --quiet || ! git -C "$dir" diff --cached --quiet; then
    if git -C "$dir" status --porcelain | grep -qvE 'pyproject\.toml|uv\.lock'; then
      warn "$repo: local changes present; leaving at $(git -C "$dir" rev-parse --abbrev-ref HEAD)"
      return
    fi
    git -C "$dir" checkout --quiet -- pyproject.toml uv.lock 2>/dev/null || true
  fi
  git -C "$dir" checkout --quiet "$rev"
  log "$repo -> $rev"
}

# Extract the version a downstream pyproject pins for <dep>, e.g. "0.1.85" from
# `komet.git@v0.1.85`. Empty if not found.
pinned_version() {
  grep -oE "${2}@v[0-9.]+" "$1" 2>/dev/null | head -1 | grep -oE '[0-9.]+$' || true
}

# The version <repo> is pinned at by its immediate downstream (empty if unknown).
pinned_for() {
  case "$1" in
    komet)          pinned_version "$CHAIN_DIR/komet-node/pyproject.toml" 'komet\.git' ;;
    wasm-semantics) pinned_version "$CHAIN_DIR/komet/pyproject.toml" 'wasm-semantics\.git' ;;
  esac
}

# Write a generated [tool.uv.sources] block into <pyproject>. Each remaining arg
# is "<name>=<inline-toml-table>", e.g. 'komet={ path = "../komet", editable = true }'.
# Idempotent (keyed on the sentinel); refuses to clobber a hand-written block. An
# empty arg list leaves an empty, override-free block (deps fall back to their pins).
write_uv_sources() {
  local file="$1"; shift
  [[ -f "$file" ]] || die "no pyproject.toml at $file"
  if grep -qF "$SENTINEL_OPEN" "$file"; then
    local tmp; tmp="$(mktemp)"
    sed "/$(printf '%s' "$SENTINEL_OPEN" | sed 's/[.[\*^$/]/\\&/g')/,/$(printf '%s' "$SENTINEL_CLOSE" | sed 's/[.[\*^$/]/\\&/g')/d" "$file" > "$tmp"
    mv "$tmp" "$file"
  elif grep -qE '^\[tool\.uv\.sources\]' "$file"; then
    die "$file already has a hand-written [tool.uv.sources]; refusing to edit."
  fi
  {
    printf '\n%s\n[tool.uv.sources]\n' "$SENTINEL_OPEN"
    local pair
    for pair in "$@"; do printf '%s = %s\n' "${pair%%=*}" "${pair#*=}"; done
    printf '%s\n' "$SENTINEL_CLOSE"
  } >> "$file"
}

# Wire deps at local checkouts via editable PATH sources — the fast-loop wiring
# (`build`/`shell` run uv against the real filesystem, so out-of-tree paths are
# fine). Usage: inject_sources <pyproject> "<name>=<rel-path>" ...
inject_sources() {
  local file="$1"; shift
  local -a specs=(); local pair
  for pair in "$@"; do
    specs+=("${pair%%=*}={ path = \"${pair#*=}\", editable = true }")
  done
  write_uv_sources "$file" "${specs[@]}"
  log "wired path sources into ${file#"$REPO_ROOT"/}"
}

# Run a command inside komet-node's Nix dev shell (uv + kompile + toolchain).
# `nix develop --command` does NOT cd into the flake dir, so cd explicitly.
in_devshell() {
  need nix
  local dir; dir="$(dir_of komet-node)"
  nix develop --extra-experimental-features 'nix-command flakes' \
    "$dir" --command bash -lc "cd '$dir' && $1"
}

# --- semantics-dev subcommands ---------------------------------------------

cmd_setup() {
  need git
  local tip=""; [[ "${1:-}" == "--tip" ]] && tip=1
  mkdir -p "$CHAIN_DIR"

  # komet-node is the root of what we build; take it at its default branch tip.
  fetch_repo komet-node

  # Resolve each upstream at the version its downstream PINS, not at tip. Pulling
  # to tip skews the K-framework version (komet-node constrains `kframework`, but
  # tip pykwasm may need newer K) and uv resolution fails. Editing relative to the
  # current release is the real dev scenario; --tip overrides (then bump pins).
  fetch_repo komet
  local kv; kv="$(pinned_version "$CHAIN_DIR/komet-node/pyproject.toml" 'komet\.git')"
  if [[ -n "$tip" ]]; then log "komet: --tip (default branch)"
  else [[ -n "$kv" ]] || die "could not read komet pin from komet-node/pyproject.toml"; checkout_rev komet "v$kv"; fi

  fetch_repo wasm-semantics
  local pv; pv="$(pinned_version "$CHAIN_DIR/komet/pyproject.toml" 'wasm-semantics\.git')"
  if [[ -n "$tip" ]]; then log "wasm-semantics: --tip (default branch)"
  else [[ -n "$pv" ]] || die "could not read pykwasm pin from komet/pyproject.toml"; checkout_rev wasm-semantics "v$pv"; fi

  # uv only honours sources in the *root* project, so komet-node overrides BOTH
  # komet and (transitively) pykwasm; komet gets pykwasm too for standalone use.
  inject_sources "$CHAIN_DIR/komet/pyproject.toml" "pykwasm=../wasm-semantics/pykwasm"
  inject_sources "$CHAIN_DIR/komet-node/pyproject.toml" "komet=../komet" "pykwasm=../wasm-semantics/pykwasm"

  log "checkouts wired. Building the chain (first build is slow)…"
  cmd_build
  printf '\n'; log "setup complete — edit under .deps/, then: dev.sh build && dev.sh use"
}

cmd_build() {
  [[ -d "$(dir_of komet-node)" ]] || die "run 'setup' first"
  log "rebuilding semantics (incremental; only changed kdist targets recompile)"
  in_devshell 'uv sync && make kdist-build'
  log "build done"
}

cmd_shell() {
  [[ -d "$(dir_of komet-node)" ]] || die "run 'setup' first"
  need nix
  log "entering komet-node dev shell (uv/kdist/komet-node available); exit to leave"
  nix develop --extra-experimental-features 'nix-command flakes' "$(dir_of komet-node)"
}

# `use` builds komet-node with a real `nix build` (release parity), which copies
# ONLY the flake dir into the Nix store — so it cannot consume the editable PATH
# sources the fast loop uses (`../komet` escapes the store, "do not know how to
# unpack …/source/../komet"). So for `use` we point komet-node at any locally-
# *changed* chain repo via a git file:// source at its committed HEAD — the exact
# git -> uv2nix -> nix pipeline a real release uses — and drop the override for
# unchanged repos (they build from their upstream pins). nix git-fetch sees only
# committed history, so changes must be committed first. The fast-loop path
# sources are restored afterwards so `build` stays instant.
cmd_use() {
  [[ -d "$(dir_of komet-node)" ]] || die "run 'setup' first"
  need kup; need git

  local -a git_specs=()
  local repo dir head pintag
  for repo in komet wasm-semantics; do
    dir="$(dir_of "$repo")"; [[ -d "$dir/.git" ]] || continue
    head="$(git -C "$dir" rev-parse HEAD)"
    pintag="v$(pinned_for "$repo")"
    # Unchanged (still exactly on the pinned tag) -> keep the upstream pin.
    if git -C "$dir" rev-parse -q --verify "$pintag^{commit}" >/dev/null 2>&1 \
       && [[ "$(git -C "$dir" rev-parse "$pintag^{commit}")" == "$head" ]]; then
      continue
    fi
    # Changed -> must be committed; nix builds from committed history only. Ignore
    # the generated pyproject/uv.lock churn when judging "uncommitted".
    if git -C "$dir" status --porcelain -- . ':!pyproject.toml' ':!uv.lock' | grep -q .; then
      die "$repo has uncommitted changes — commit them before 'use' (nix builds from committed history). See: git -C '$dir' status"
    fi
    case "$repo" in
      komet)          git_specs+=("komet={ git = \"file://$dir\", rev = \"$head\" }") ;;
      wasm-semantics) git_specs+=("pykwasm={ git = \"file://$dir\", rev = \"$head\", subdirectory = \"pykwasm\" }") ;;
    esac
    log "$repo: local build -> git file:// @ ${head:0:7}"
  done
  [[ ${#git_specs[@]} -gt 0 ]] || warn "no local changes vs pins — 'use' will rebuild the pinned release."

  log "installing local komet-node onto PATH via kup (exact release build)…"
  # Swap the fast-loop path sources for git sources nix can build, re-lock, build.
  write_uv_sources "$CHAIN_DIR/komet-node/pyproject.toml" "${git_specs[@]}"
  local rc=0
  { in_devshell 'uv lock' && kup install komet-node --version "$(dir_of komet-node)"; } || rc=$?
  # Always restore the editable path sources so the fast loop keeps working.
  inject_sources "$CHAIN_DIR/komet-node/pyproject.toml" "komet=../komet" "pykwasm=../wasm-semantics/pykwasm"
  in_devshell 'uv lock' >/dev/null 2>&1 || true
  [[ $rc -eq 0 ]] || die "use failed (see above); restored fast-loop path sources."
  log "done — the debugger's default 'komet-node' is now your local build."
  log "revert with: kup install komet-node"
}

cmd_status() {
  for repo in "${CHAIN_ORDER[@]}"; do
    local dir; dir="$(dir_of "$repo")"
    if [[ -d "$dir/.git" ]]; then
      printf '  %-16s %s\n' "$repo" "$(git -C "$dir" log -1 --format='%h %s' 2>/dev/null)"
    else
      printf '  %-16s (not checked out)\n' "$repo"
    fi
  done
}

# --- pr subcommands (coordinated upstreaming) ------------------------------

# Does <repo> have <branch> locally, ahead of its remote default branch?
pr_participates() {
  local dir; dir="$(dir_of "$1")"
  [[ -d "$dir/.git" ]] || return 1
  git -C "$dir" show-ref --verify --quiet "refs/heads/$2" || return 1
  [[ "$(git -C "$dir" rev-list --count "origin/$(default_of "$1")..$2" 2>/dev/null || echo 0)" -gt 0 ]]
}

pr_status() {
  local branch="${1:?usage: pr status <branch>}"
  for repo in "${CHAIN_ORDER[@]}"; do
    local dir; dir="$(dir_of "$repo")"
    if [[ ! -d "$dir/.git" ]]; then printf '  %-16s (not checked out)\n' "$repo"; continue; fi
    if pr_participates "$repo" "$branch"; then
      local base; base="$(default_of "$repo")"
      printf '  %-16s \033[1;32mparticipates\033[0m — %s commit(s) ahead of %s\n' \
        "$repo" "$(git -C "$dir" rev-list --count "origin/$base..$branch")" "$base"
    else
      printf '  %-16s —\n' "$repo"
    fi
  done
}

pr_apply_link() {
  local branch="$2" repo dep regex prefix suffix
  IFS='|' read -r repo dep regex prefix suffix <<< "$1"
  local dir file; dir="$(dir_of "$repo")"; file="$dir/pyproject.toml"
  [[ -f "$file" ]] || { warn "$repo: no pyproject.toml; skipping"; return; }
  grep -qE "$regex" "$file" || { log "$repo: $dep pin already rewritten or absent; skipping"; return; }
  sed -i -E "s#${regex}#${prefix}${branch}${suffix}#" "$file"
  git -C "$dir" add pyproject.toml
  git -C "$dir" commit -q -m "TEMP: point $dep at branch $branch (revert before merge)"
  log "$repo: $dep -> @$branch (committed; 'pr unlink' to revert)"
}

pr_link() {
  local branch="${1:?usage: pr link <branch>}"; need git
  pr_apply_link "$LINK_KOMET" "$branch"
  pr_apply_link "$LINK_KOMET_NODE" "$branch"
  warn "Pins now point at '$branch'. Re-lock (dev.sh build) before pushing;"
  warn "these TEMP commits MUST be reverted (pr unlink) before merging."
}

pr_unlink() {
  local branch="${1:?usage: pr unlink <branch>}"; need git
  for repo in komet komet-node; do
    local dir; dir="$(dir_of "$repo")"; [[ -d "$dir/.git" ]] || continue
    if git -C "$dir" log -1 --format='%s' 2>/dev/null | grep -q "^TEMP: point .* at branch $branch"; then
      git -C "$dir" reset -q --hard HEAD~1
      log "$repo: reverted TEMP link commit"
    fi
  done
}

pr_open() {
  local branch="" title="" body="" draft="" dry=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --body)  body="$2";  shift 2 ;;
      --draft) draft="--draft"; shift ;;
      --dry-run) dry=1; shift ;;
      -*) die "unknown flag: $1" ;;
      *) branch="$1"; shift ;;
    esac
  done
  [[ -n "$branch" ]] || die "usage: pr open <branch> [--title T] [--body B] [--draft] [--dry-run]"
  need git; [[ -n "$dry" ]] || need gh

  local participating=()
  for repo in "${CHAIN_ORDER[@]}"; do pr_participates "$repo" "$branch" && participating+=("$repo"); done
  [[ ${#participating[@]} -gt 0 ]] || die "no repo has commits on branch '$branch' (see: pr status $branch)"
  log "participating (leaf->root): ${participating[*]}"

  declare -A pr_url=()
  for repo in "${participating[@]}"; do
    local dir base links="" up; dir="$(dir_of "$repo")"; base="$(default_of "$repo")"
    for up in "${participating[@]}"; do
      [[ "$up" == "$repo" ]] && break
      [[ -n "${pr_url[$up]:-}" ]] && links+="- upstream: ${pr_url[$up]}"$'\n'
    done
    local fbody="${body:-Coordinated change across the semantics chain.}"
    [[ -n "$links" ]] && fbody+=$'\n\n'"Chain:"$'\n'"$links"
    if [[ -n "$dry" ]]; then
      log "[dry-run] $repo: push $branch; gh pr create --base $base --title \"${title:-$branch}\" $draft"
      pr_url[$repo]="(dry-run)"; continue
    fi
    log "$repo: pushing $branch"; git -C "$dir" push -u origin "$branch"
    log "$repo: opening PR against $base"
    pr_url[$repo]="$(cd "$dir" && gh pr create --base "$base" --head "$branch" \
      --title "${title:-$branch}" --body "$fbody" $draft 2>/dev/null || gh pr view "$branch" --json url -q .url)"
    log "$repo: ${pr_url[$repo]}"
  done
  log "done. PRs:"
  for repo in "${participating[@]}"; do printf '  %-16s %s\n' "$repo" "${pr_url[$repo]}"; done
}

cmd_pr() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    status) pr_status "$@" ;;
    link)   pr_link   "$@" ;;
    unlink) pr_unlink "$@" ;;
    open)   pr_open   "$@" ;;
    *) die "unknown pr subcommand: $sub (status|link|unlink|open)" ;;
  esac
}

# --- entry point -----------------------------------------------------------

usage() {
  cat <<'EOF'
dev.sh — work across the semantics chain (komet-node -> komet -> wasm-semantics)

Only needed when CHANGING the semantics. For plain debugging, the devcontainer
already has komet-node (via kup) — just press F5.

  setup [--tip]   check out the chain (at pinned versions) + wire it together
  build           fast incremental rebuild after an edit
  shell           drop into the komet-node dev shell
  use             install the local build as the debugger's komet-node
  status          show checked-out revisions

  pr status <branch>            show which repos would open a PR
  pr open   <branch> [--draft] [--dry-run] [--title T] [--body B]
  pr link   <branch>            point downstream pins at sibling branches (for CI)
  pr unlink <branch>            revert the link commits

nix/uv/kdist are plumbing this script drives — you never run them directly.
EOF
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    setup)  cmd_setup  "$@" ;;
    build)  cmd_build  "$@" ;;
    shell)  cmd_shell  "$@" ;;
    use)    cmd_use    "$@" ;;
    status) cmd_status "$@" ;;
    pr)     cmd_pr     "$@" ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown command: $cmd (try --help)" ;;
  esac
}

main "$@"
