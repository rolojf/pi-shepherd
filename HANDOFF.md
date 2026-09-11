# Handoff: pi-shepherd security review and launch hardening

## Start here

Continue in this checkout:

```text
$HOME/Documents/dev/pi-shepherd
```

Repository state at handoff:

- Fork: `https://github.com/rolojf/pi-shepherd.git`
- Branch: `main`
- Base HEAD: `9bc02334f6b53f17977ee18596b525747fb43c4f`
- Upstream package reviewed: `@luminascale/pi-shepherd@0.2.1`
- Working tree intentionally contains an uncommitted security fix, its regression test, and this handoff.
- The user will review, stage, commit, and push. Do not do those steps unless explicitly asked.
- Pi loads this checkout as a local package. `pi list` reports `../../Documents/dev/pi-shepherd`.
- Start a new Pi session or use `/reload` after source changes.

Read `AGENTS.md` and `$PI_CODING_AGENT_DIR/CODING_STANDARDS.md` before changing code. In particular, write a failing test before each bug fix.

## Objective

Assess whether pi-shepherd is safe and compatible with the installed
`@earendil-works/pi-coding-agent` 0.85.1, patch the confirmed shell-injection
issue without reducing child-agent capabilities, then continue hardening the
remaining trust and lifecycle boundaries.

## Review conclusion

Do not treat upstream v0.2.1 as hardened. It has good compatibility,
supply-chain provenance, tests, and several thoughtful lifecycle controls, but
the reviewed release had one confirmed shell injection and still has important
project-trust, child-isolation, and cleanup gaps.

No obvious malware, telemetry, intentional credential theft, custom HTTP
fetching, or SSRF implementation was found. The extension does not launch
Claude, Codex, or Cursor, does not use `--dangerously-skip-permissions`, and
does not perform destructive Git worktree cleanup.

## Compatibility and supply-chain evidence

Audit snapshot:

- Git commit: `9bc02334f6b53f17977ee18596b525747fb43c4f`
- npm version: `@luminascale/pi-shepherd@0.2.1`
- The lockfile was authored against Earendil Pi 0.84.2.
- All repository tests pass against the locally installed Earendil Pi 0.85.1 packages.
- Package manifest has no direct runtime dependencies, only Pi peer dependencies.
- OSV reported no known advisories across 237 locked packages.
- The npm release has registry signatures and SLSA provenance tied to the audited commit.
- All 115 files in the npm tarball matched the Git commit byte-for-byte.
- The publish workflow uses GitHub OIDC and runs `npm test` before publication.

Remaining supply-chain caveats:

- Peer dependency ranges are `*`, so future Pi versions are not guaranteed compatible.
- The Git tag itself is not cryptographically signed.
- GitHub Actions use moving major-version tags rather than full action SHAs.
- Tests run for releases, but there is no general push/PR CI workflow and the
  package `build` and `check` scripts are no-ops.

## Completed fix: quote the child tool allowlist

### Original vulnerability

`src/core/discovery.ts` accepts `tools` values from agent frontmatter.
`src/core/herdr.ts` previously appended the comma-separated value to a generated
Bash command without quoting it:

```ts
args.push('--tools', tools.join(','));
```

Because the final command is `pi ${args.join(' ')}`, a frontmatter value such as
`read; <command> #` terminated the Pi command and executed arbitrary shell
syntax as the current user. The command ran before child Pi started, so Pi's
tool allowlist and child trust handling could not mitigate it.

The source of `tools` is a discovered user, project, or bundled agent
definition. Normal delegated task text is written to a file and was not part of
this injection path.

### Patch applied

`src/core/herdr.ts` now shell-quotes the complete comma-separated allowlist:

```ts
if (tools && tools.length > 0) args.push('--tools', shellQuote(tools.join(',')));
```

This is intentionally a quoting fix, not a hard-coded tool allowlist. Bash
removes the protective quotes and Pi receives exactly the same single argument,
so built-in and custom child tools retain their existing capabilities.

Do not replace this with a narrow fixed list. If tool-name validation is added
later, validate against Pi's available tool names or a Pi-compatible naming
contract without breaking custom extension tools. Correct shell quoting remains
mandatory even with validation.

### Regression test added

`test/verify-launch.mjs` now:

1. Creates a temporary fake `pi` executable that captures its argv.
2. Generates a launch script with shell metacharacters in a tool value.
3. Executes the generated launch script.
4. Confirms no injected marker is created.
5. Confirms Pi receives the entire allowlist, including
   `shepherd_message` and `shepherd_done`, as one argument.

Red/green evidence:

- Before the source patch, the new test failed because the marker was created
  and Pi received only the prefix of the tool list.
- After the patch, the focused launch suite and complete test suite passed.

Verification already run:

```text
npm run launch:test  PASS
npm test             PASS

git diff --check     PASS
```

No dependencies were installed. For local test resolution, ignored
`node_modules` symlinks point to the already-installed Pi 0.85.1 packages.

## Current working-tree changes

Expected files:

```text
M  src/core/herdr.ts
M  test/verify-launch.mjs
?? HANDOFF.md
```

Nothing has been staged, committed, or pushed.

## Remaining security work, in priority order

### P0: enforce Pi project trust and fail closed without UI

Current behavior:

- `src/extension/config.ts:207-224` reads `.shepherd/config.json` based only on cwd.
- A committed project config can activate itself with `projectScope: true` and
  select project agents.
- `src/core/discovery.ts:225-235` reads project `.pi/agents` and
  `.agents/agents` without consulting Pi project trust.
- `src/core/lifecycle.ts:157-163` asks for project-agent confirmation only when
  `ctx.hasUI` is true. If confirmation is enabled but no UI exists, execution
  currently proceeds without confirmation.
- The `agents` action can also expose project-controlled descriptions to the
  parent model before a project trust check.

Pi 0.85.1 exposes `ctx.isProjectTrusted()`. Use it before honoring project
configuration or discovering project definitions.

Required behavior:

1. Untrusted projects must not activate `.shepherd/config.json`.
2. Untrusted project agent directories must not be listed or spawned.
3. If a project agent requires approval and no UI is available, reject it.
4. Trusted interactive project agents should retain the existing per-spawn confirmation.
5. A project config must remain unable to override the user-owned
   `confirmProjectAgents` setting.

Add failing tests first for untrusted config, untrusted discovery/spawn, and the
no-UI case. The design will probably require propagating project trust through
the extension context into settings, discovery, and `startAgent`; avoid reading
project state before that trust value is known.

### P1: define and reduce child privilege

Children are not sandboxes. They run as the same OS user and in the same
checkout. Material consequences:

- Built-in `worker` has `read`, `write`, `edit`, and unrestricted `bash`.
- Built-in `reviewer` has unrestricted `bash`; its read-only rule is prompt text,
  not enforcement.
- `read` can expose files outside the repository unless separately gated.
- The detached Herdr server spawn does not scrub the ambient environment.
- Child Pi currently loads the user's normal extension set in addition to the
  explicitly supplied `shepherd-done.ts` extension.
- Omitted agent `tools` means the child may receive all otherwise active tools.

Evaluate:

- Add Pi's `--no-extensions`; explicit `-e shepherd-done.ts` still loads on Pi 0.85.1.
- Keep the agent-defined `--tools` allowlist and Shepherd child tools working.
- Scrub unnecessary environment variables without breaking provider authentication.
- Add actual permission/tool-call gates for read-only roles, especially `bash`.
- Protect credential paths and other sensitive paths from read/write tools.

Do not describe filesystem mailbox capabilities as isolation from a malicious
same-UID child. A child with filesystem access can inspect or modify sibling
mailbox data.

### P1: terminate or deliberately preserve children on timeout and shutdown

Current behavior:

- Task deadlines in `src/core/orchestration.ts` settle a task as `timed_out` but
  do not stop the child process or close its pane.
- `index.ts:422-435` intentionally stops parent watchers while leaving prompts,
  child panes, result files, and notes untouched.
- A running child can therefore outlive its parent session.
- Persistent spawned agents have no hard execution budget or global concurrency cap.

Decide and document the lifecycle contract before patching. Safer defaults
would close or cancel owned children on task timeout and parent shutdown, with
an explicit opt-in for retention. Preserve the existing invariant that
pi-shepherd only closes panes it owns.

Tests should cover:

- Timeout actually stops or cancels the intended owned child.
- Shutdown handles multiple children and partial close failures.
- Unowned panes are never closed.
- Mailbox cleanup occurs only after children are confirmed gone.
- Retention, if supported, is explicit and leaves a recoverable ownership record.

### P2: harden persistent files and registries

Fieldnotes are enabled by default under `.shepherd/sessions`. Their metadata can
contain delegated task text, absolute project/session paths, and parent-session
information. `src/core/artifact-sessions.ts` opens atomic-write files with mode
`0644` subject to umask.

Review and test:

- Use private permissions where the files can contain sensitive data.
- Keep `.shepherd/sessions` ignored; the README already recommends committing
  only `.shepherd/config.json`.
- Resolve or reject symlink-based paths where project-controlled `.shepherd`
  entries could redirect writes outside the project.
- Make `created-panes.json` updates atomic and locked across concurrent parent sessions.
- Validate retained launch-directory paths before recursive deletion.

### P2: concurrency and operational safety

Agents share one working checkout. This avoids the destructive worktree
removal found in another reviewed fork, but concurrent workers can overwrite or
conflict with one another. Consider an explicit same-checkout warning,
serialization for write-capable agents, or optional isolated worktrees with
non-destructive cleanup.

Also consider a configurable maximum for concurrent/persistent agents to limit
resource and model-cost amplification.

## Existing positive controls worth preserving

- Earendil Pi-native implementation and direct TypeScript loading.
- No external Claude/Codex/Cursor launcher or permission-bypass flag.
- Herdr calls generally use `execFile`/argument arrays.
- Created-pane ownership checks prevent raw pane IDs from bypassing close rules.
- Startup failures attempt to close the pane they created.
- Session-scoped opaque lifecycle IDs.
- Atomic mailbox writes, protected mailbox modes, queue-depth limits, message-size limits, and idempotent acknowledgements.
- Filesystem locks and parent binding for fieldnote session allocation.
- User configuration owns `confirmProjectAgents`; project config cannot disable it.

## Known maturity issues

At review time the repository had low adoption and three open issues:

- Delayed watcher completion delivery after agents are closed.
- Intermittent Herdr pane scrollback snapping.
- Missing useful child-output tails in general task-failure results.

These are not evidence of malicious behavior, but they reinforce that the
project is still maturing. Perform live Herdr verification after each lifecycle
change; unit tests alone do not cover pane/process behavior.

## Recommended next-session sequence

1. Confirm the working tree and rerun `npm run launch:test`.
2. Review the current quoting patch and regression test; do not reduce tool capabilities.
3. Implement P0 project-trust handling using test-first changes.
4. Run the focused trust/settings/discovery tests, then `npm test` and
   `git diff --check`.
5. Reload Pi and perform a live Herdr test with bundled read-only and worker agents.
6. Review/stage/commit/push only when the user explicitly takes or delegates those steps.
7. After the patched commit is pushed, optionally replace the local-path Pi
   package entry with a git source pinned to the full commit SHA. Do not install
   the remote fork before the patch is pushed, because remote `main` still
   points to the unpatched base commit.
