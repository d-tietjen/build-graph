# Optional Cargo launch intent channel

On Linux with `rustc-driver`, the `build` command accepts
`--cargo-launch-observer-fd N --cargo-launch-root OPAQUE` together with
`--observe-definition-occurrences`. The caller supplies one already connected
Unix stream FD, numbered at least 3. There is no pathname connection or socket
listener. The CLI consumes that descriptor and owns a private CLOEXEC duplicate.
Absent these options, existing launch paths and exported DTOs remain unchanged.
`watch` and `update` do not adopt this finite, single-pass channel.

Every selected Cargo metadata, build and docs command uses the same Session
seam. The hook runs after argument, tool, compiler wrapper, cwd and environment
configuration. It materializes the inherited environment plus explicit changes
on the `Command`, obtains a bounded generic environment overlay, materializes
that final environment, and consumes the frozen command. Ambient environment
changes cannot change delivery after that snapshot. The actual selected program
is explicitly delivered at argv[0]; all ordered arguments and the absolute cwd
are retained as raw byte arrays, without UTF-8 replacement or wrapper stripping.
Library callers choose explicitly whether the first snapshot inherits or starts
empty; the actual Session commands use their existing inheriting profile.

Final preparation repeats the freeze on the owned `Command` with inheritance
disabled before comparison, carrier creation or ACK. A late Unix `arg0` override
is reset to the selected program; an equivalent replacement command cannot add
ambient environment entries through its default inheritance. Explicit argument,
cwd or environment changes still reject when their frozen description differs.
The readonly `command_intent` helper describes an already frozen command; it
cannot inspect hidden Unix overrides or inheritance on an arbitrary `Command`.
This final normalization uses APIs available on the existing Rust 1.85 baseline.

## Protocol version 1

Frames begin with **one sendmsg byte**: tag 0 carries no descriptor; tag 1 carries
exactly one SCM_RIGHTS descriptor on that byte. Four bytes of unsigned big-endian
JSON length follow, then exactly that many JSON bytes. The receiver reads the
ancillary byte separately with recvmsg and CLOEXEC rights, rejecting descriptors
on length/body bytes, truncated control data, extra rights and other ancillary
data. This also handles stream splitting and coalescing. Each channel is owned
exclusively; no process-wide lock or background reaper is used.

Every event and response is a strict envelope:
`{"schema_version":1,"payload":...}`. Unknown fields and versions reject.
Event payloads use the `event` tag and response payloads use `response`.
`Binding` has the exact declaration order `session, operation, request, root,
kind`; correlations are nonempty printable ASCII of at most 256 bytes. The
actual Session kinds are `metadata`, `build` and `docs`, with consecutive
operation ordinals. These labels do not authenticate a process.

1. `route`: `intent` and `request_sha256`. `CommandIntent` field order is
   `schema_version, binding, program, argv, cwd, environment`. Environment fields
   are `sha256, entries, bytes, complete`; this boolean describes availability.
   Request SHA256 covers the exact bounded encoding of that CommandIntent.
2. Route response: exact `binding`, `request_sha256`, distinct lowercase 64-hex
   `route_nonce`, and `environment` changes. Each change has raw-byte `name` and
   nullable raw-byte `value` (null removes a key). No environment names have
   private meaning in this public module. Denial or contradictory response
   stops this operation before spawn.
3. A Linux memfd named `build-graph-launch-intent-v1` contains bounded final JSON
   with fields `intent, route_nonce, route_response_sha256`. It is created with
   CLOEXEC and ALLOW_SEALING and sealed against write, grow, shrink and further
   seal changes. `intent` carries version 1 and the final command/digest.
4. `intent` notice transfers that exact FD. Its fields are `binding,
   route_nonce, route_response_sha256, carrier_bytes, carrier_sha256`.
   `acknowledged` response contains the exact `binding` and `event_sha256` over
   the **received raw event envelope bytes**. It must arrive before spawn.
   Response SHA covers the **received raw Route response envelope bytes**;
   receivers must not reencode either raw-byte fingerprint.
5. `spawned` has binding and the actual child PID. `spawn_failed` has binding.
   `completed` has binding and actual nullable exit code/signal after wait.
   `cancelled` has binding, nullable PID and actual nullable exit code/signal.
   `unavailable` reports a failed observation. Each uses the same exact ACK.

No inherited or final environment values appear in intent/events, exports or
logs. Only the caller's explicitly supplied bounded overlay response contains
its new values. Malformed-response errors use fixed messages, not payloads.
The existing allowlisted observation export remains separate and conservative.

The full environment digest uses published `sha2` SHA256. Its bytes are:
`build-graph:launch-environment:v1\0`, then entry count as u64 little endian,
then entries in raw-name byte lexicographic order. Each entry contains u64 LE
name length, name bytes, u64 LE value length and value bytes. Values and names
must have no NUL; names are nonempty and cannot contain `=`. This fingerprint
is descriptive and does not grant authority. The
[dependency and license inventory](launch-intent-dependencies.json) pins the
published cached archive checksums and included license files. Genuine locked
resolver, cross-target compilation and driver/CLI validation remain required.

## Bounds and ownership

| Input | Cap |
| --- | --- |
| Encoded event, response or final carrier | 32 KiB |
| Cumulative channel send + receive (including five-byte frame overhead) | 256 KiB |
| Operations / frames | 16 / 128 |
| Cumulative socket I/O time | 5 seconds |
| Full raw environment | 1024 entries / 64 KiB name + value bytes |
| Caller overlay | 32 entries / 8 KiB name + value bytes |
| Program + argv + cwd | 256 arguments / 8 KiB raw bytes |
| Opted-in metadata stdout / stderr retention | 8 MiB each |

The I/O budget is charged cumulatively across exchanges; it is not restarted
per byte or event. Cargo's run time remains under the existing operation owner.
Protocol overflow, stale/duplicate correlations, missing ACK, timeout, unsupported FD or
callback failure prevents spawn and fences subsequent operations. A post-spawn
observer failure synchronously cancels and waits the same actual child before
returning error. Dropping the opted-in child guard does the same. Pipe setup,
read and output-cap failures retain that child and carrier; both metadata pipes
are drained under one synchronous owner, with bounded retention.

The carrier stays live through actual spawn failure or actual wait and owning
terminal ACK/error disposal. A fatal wait error cannot release it or report
extinction: after one cancellation attempt the original stack remains retained
and observation-only until actual wait or external disposal of that caller
scope. This adds no detached owner, execution deadline or descendant claim.
The low-level library transport/PreparedLaunch methods require their caller to
own and wait the returned Child; the real CLI uses the same-stack CargoChild
guard, and a prepared command permits only one spawn attempt.

## Remaining original-parent join

This channel, root text, nonce, payload digest, sealed FD and ACK do not prove
executable qualification, creator birth, ancestry, custody or completeness.
SO_PEERCRED is not used as inherited-channel emitter authentication. An original
parent must separately pin the qualified emitter, exact carrier creation/seals,
root birth, actual wait-owned FORK/birth/EXEC successor, selected Cargo image and
delivered environment, and charge all carriers and operations under its existing
budget. Those private production joins are outside this public protocol.
The public compiler/graph DTO still reports partial or unavailable observations;
this feature adds no Complete or eligibility grant.
