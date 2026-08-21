# Security policy

## Supported versions

Security fixes land on the latest released version of the extension. There are no long-term support branches.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through [GitHub's private vulnerability reporting](https://github.com/runtimeverification/stellar-debugger/security/advisories/new), or by email to <security@runtimeverification.com>. Include the version of the extension, the version of `komet-node`, and enough detail to reproduce — a launch configuration or a recorded trace file is ideal.

We aim to acknowledge a report within three business days and to keep you updated as we work on a fix. We will credit you in the advisory unless you'd rather stay anonymous.

## Scope

This extension executes contracts on a **local** `komet-node` and shells out to the Stellar CLI to build them. Things we consider security-relevant:

- A launch configuration, a contract, or a recorded trace file causing code execution beyond the documented build and node commands.
- The extension leaking a `sourceSecret`, or any other credential from a launch configuration, into logs, telemetry, or a network request.
- Debugging an untrusted contract or replaying an untrusted trace compromising the editor host.

Note that a launch configuration deliberately names commands to run (`buildCommand`, `node.command`). A workspace you open is trusted to the extent VSCode's workspace trust says it is; a malicious `launch.json` naming a malicious build command is not a vulnerability in this extension.
