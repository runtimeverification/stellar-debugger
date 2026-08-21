# First public release — polishing checklist

Working doc for the v0.1.0 public release of the Stellar Debugger. Delete this file once the release is out.

Decisions taken: full rename to `stellar` (debug type, settings, command, CLI binaries), version **0.1.0**, `examples/` stays repo-only rather than shipping in the `.vsix`, and the CLIs stay repo-built (no npm publish this release).

## Done

- [x] **Package identity.** `name` → `stellar-debugger`, `displayName` → `Stellar Debugger`, `version` → `0.1.0`, description rewritten; `.devcontainer/devcontainer.json` renamed too, and `package-lock.json` resynced.
- [x] **Full `soroban` → `stellar` rename of everything users type or see**: debug type `"type": "stellar"`, settings `stellar.kometNode.path` and `stellar.cliPath` (was the awkward `soroban.stellar.path`), command `stellar.debug`, binaries `stellar-dap` / `stellar-trace`, the thread label `stellar-vm [n/m]`, and every launch-config name, snippet, error message, doc and example. Internal identifiers (`SorobanDebugSession`, `SorobanLaunchArgs`, `src/soroban/**`) deliberately keep the name: they refer to the Soroban protocol layer, not to the product, and renaming them would churn the whole tree for no user-visible gain.
- [x] **Marketplace metadata.** `icon` (128×128, `images/icon.png`, generated from `images/icon.svg`), `galleryBanner`, ten `keywords`, `categories: [Debuggers, Testing]`, and `preview: true` for the first release.
- [x] **`.vscodeignore` rewritten as an allowlist.** `vsce ls` now reports exactly 8 files and `npm run package` produces a 905 KB `.vsix` — previously it would have swept in the ~5.8 GB of `examples/*/target` and `test/fixtures/*/target` that git ignores but `vsce` does not.
- [x] **Release plumbing.** `@vscode/vsce` and `ovsx` added as devDependencies with `package` / `publish:vscode` / `publish:openvsx` scripts, plus `.github/workflows/release.yml`: tag-triggered, refuses a tag that disagrees with `package.json`, runs the suite with the e2e opt-out (CI already ran it against the real node on that commit), then publishes to the VS Code Marketplace and Open VSX and attaches the `.vsix` to a GitHub release.
- [x] **CHANGELOG.** `[Unreleased]` folded into `[0.1.0] — 2026-08-21`, rewritten as a first-public-release feature list rather than a diff against a version nobody had; the fictional `[0.1.0]`-predecessor entry and its dead tag link are gone, and the komet-node floor is stated under Requirements.
- [x] **README.** New **Install** section (marketplace, `code --install-extension`, Open VSX for Cursor/Windsurf/VSCodium); komet-node **≥ v0.1.87** stated in Requirements with the note that replay needs no toolchain at all; a **Known limitations** section covering partial traces, the opt-level-0 requirement, and one-traced-transaction-per-session; the Roadmap no longer contradicts the Features (the Variables view ships — *inline* values are what's still future); `examples/` described as a repo clone rather than "bundled"; and the CLIs marked as repo-built, not installed by the extension.
- [x] **CLI docs** (`docs/trace-cli.md`, `docs/dap-cli.md`) say plainly that a marketplace install does not put `stellar-trace` / `stellar-dap` on `PATH`.
- [x] **`SECURITY.md`** (private reporting, scope, and the explicit non-vulnerability of a `launch.json` naming its own build command) and **`CODE_OF_CONDUCT.md`** (Contributor Covenant 2.1).
- [x] **Repo hygiene.** `.gitignore` covers `.env`, `.env.*` and `.deps/`; the personal `/home/node/work/...` entries are out of `.vscode/launch.json`; the stray `state.kore` is deleted.
- [x] **Personal paths out of the test data.** `test/justMyCode.test.ts` classified paths under `/home/node/work/rs-lending-xlm/...`, naming an internal project in a repo about to go public; the ground-truth paths are now neutral (`/home/dev/work/lending-pool/...`), which the classifier treats identically since it keys off `.rustup` / `.cargo/registry` / `/rustc/` markers.
- [x] **Lint covers the tests too** (`eslint src test`), and it passes.
- [x] **Activation narrowed.** `activationEvents` was the blanket `onDebug`, which woke this extension for *any* debug session and left the palette command relying on implicit activation; it is now `onDebugResolve:stellar` plus an explicit `onCommand:stellar.debug`.
- [x] **`engines.vscode: ^1.85.0` verified.** `src/extension.ts` is the only module that imports `vscode`, and every API it touches (`registerDebugConfigurationProvider`, `registerDebugAdapterDescriptorFactory`, `DebugAdapterInlineImplementation`, `getConfiguration`, `showInputBox`, `startDebugging`) long predates 1.85; the disassembly, memory and step-back features are negotiated DAP capabilities, supported well before it. The floor is truthful and conservative.
- [x] **CONTRIBUTING** documents the release process, the allowlist `.vscodeignore` invariant, and the deliberate decision to defer the ESLint 9 migration until after the release (dev-only dependency, never reaches the `.vsix`).

## Needs a human

- [ ] **Pin, or at least verify, the `komet-node` version CI and the devcontainer install.** Both run a bare `kup install komet-node`, so they ride whatever is newest at build time — and the trace format is a hard contract this extension rejects on mismatch, which means CI can turn red with no change in this repo. This is not hypothetical: the devcontainer in use here has komet-node `7b2c71b`, about fourteen commits stale and predating the komet v0.1.88 bump, so **all six real-node e2e tests fail locally** with `trace line 1: 'kind' must be a non-empty string`. A raw dump confirms that node still serves the old shape (`{"pos":null,"instr":["callContract"],…}`, no `kind`). Nothing in this repo is at fault, and no polishing change caused it, but the release tag has to sit on a commit whose e2e suite really passed — so rebuild the devcontainer (or `kup install komet-node --version <commit>`) and confirm green before tagging.

- [ ] **Record a screenshot or a short GIF for the README.** This is the one real gap left: the marketplace page is the README, and a time-travel debugger sells on motion — stepping backwards, the Ledger view scrubbing with the cursor. Nothing else on this list can substitute for it.
- [ ] **Confirm the marketplace publisher and add the secrets.** `publisher: runtimeverification` must exist and be verified, with `VSCE_PAT` and `OVSX_PAT` stored as repository secrets, plus an Open VSX namespace of the same name.
- [ ] **Enable GitHub private vulnerability reporting** (Settings → Security) so the link in `SECURITY.md` resolves, and confirm `security@runtimeverification.com` is a mailbox someone actually watches — replace it if not.
- [ ] **Consider a designed icon.** `images/icon.png` is a hand-rolled rewind glyph on navy: legible at tile and tree size, but a real designer would do better. Regeneration instructions are in `images/README.md`.
- [ ] **Install the packaged `.vsix` in a clean VSCode** (no repo, no dev dependencies) and run one replay config and one live build-deploy-debug config. The replay path must work with no toolchain at all — that is the front page's claim.
- [ ] **Tag the release** on a commit that is green on CI: `git tag v0.1.0 && git push origin v0.1.0`. Then check that the marketplace and Open VSX links in the README resolve.
- [ ] **Verify the README's relative links** on the rendered marketplace page (`vsce` rewrites them against the `repository` field; the `docs/` and `examples/` links do not ship inside the `.vsix`).

## After the release

- [ ] Migrate to ESLint 9's flat config.
- [ ] Revisit `preview: true` once the first users have reported back.
