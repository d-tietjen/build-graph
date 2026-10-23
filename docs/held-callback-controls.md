# Held callback control descriptors

Linux builds with `rustc-driver` may select `--held-callback-controls` together
with `--observe-compiler-inputs --observe-definition-occurrences`. The optional
semantic stream uses the same transport. Omission retains the existing private
0600 request paths, path readers, request schemas and output checks. The new
configuration field is omitted when false. Other platforms and builds without
the driver feature do not expose this option.

This is immutable **data delivery**. Descriptor numbers, memfd names, schemas,
nonces and valid bytes do not authenticate a compiler unit, executable, process
lifetime or complete input closure. They do not authorize reuse or execution.

## Actual producer and lifetime

The wrapper first creates its original exclusive request files. Before reading
any body or creating a memfd, the transport opens each source under its held
private 0700 parent, checks its 0600 single-link regular-file identity and admits
both lengths against **one 32 KiB total**. It checks held FD/path identities before
and after the read. The temporary body vectors share that capacity bound.

Each control is a new, empty `MFD_CLOEXEC | MFD_ALLOW_SEALING` memfd. The wrapper
sets 0600 permissions, completes scalar writes and adds all four seals:
`F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL`. It verifies the seals,
size and descriptor identity, then compares positional readback with the original
body using a fixed 4 KiB working buffer. All of this precedes the delegated child.
Temporary body vectors are dropped before spawn. The routing names are
`build-graph-occurrence-control-v1` and `build-graph-semantic-control-v1`.

`OwnedSealedControls::configure_child` creates fixed CLOEXEC delivery copies owned
by the actual `Command` hook. Dropping the returned retention cannot leave stale
numeric descriptors in the hook. Only that child's hook clears CLOEXEC on those
exact owned copies, using `fcntl`; it allocates no objects and takes no locks.
Parent copies remain CLOEXEC. The wrapper retains the original descriptors
through the actual wait and callback/result processing. Spawn errors and drops
close owned copies through the existing RAII lifecycle. No runner, wait owner or
new deadline is introduced.

## Driver ABI

The exact delegated command receives:

| Variable | Meaning |
| --- | --- |
| `BG_DRIVER_OCCURRENCE_REQUEST_FD` | Ownership transfer of one non-stdio occurrence control FD |
| `BG_DRIVER_SEMANTIC_REQUEST_FD` | Optional ownership transfer of a distinct semantic control FD |
| `BG_DRIVER_OCCURRENCE_REQUEST` | Original request path and private output-parent correlation |
| `BG_DRIVER_SEMANTIC_REQUEST` | Original semantic request path and output-parent correlation |

FD selectors are canonical decimal integers at least 3. A semantic FD without an
occurrence FD, identical numbers, identical underlying files, malformed numbers
or invalid controls suppresses callbacks. Explicit FD mode never falls back to
reading a path body. The actual wrapper clears all four variables before setting
its selected delivery, so ambient FD selectors cannot select wrapper behavior.
The wrapper's own opt-in comes from its per-run configuration.

The driver adopts the unique ownership transfer at the first step of `main`,
before sysroot helpers or compiler threads. The unsafe adoption entrypoint
requires one-time process-entry ownership; it is not a safe raw-FD constructor
for borrowed caller descriptors. Received descriptors immediately regain
CLOEXEC and remain owned through compiler/callback result disposal.

The driver accepts a readable regular descriptor with all four seals, including
an `O_RDWR` memfd. `F_SEAL_WRITE` prevents its aliases from changing bytes;
`F_SEAL_GROW` and `F_SEAL_SHRINK` prevent size changes. `O_WRONLY`, `O_PATH`, missing
seals and unsupported descriptors are rejected. An existing writable shared
mapping prevents the required write seal from succeeding. Production does not
reopen through `/proc` or rely on pathname/memfd inode equality.

Before allocating either body, the receiver checks both sizes against the same
32 KiB total. It uses exact-capacity bounded vectors and `pread` from offset zero,
leaving the shared file position unchanged. Repeated size, mode, owner, identity
and seal checks surround the read. The occurrence and semantic request schemas
and actual compiler/source/crate/metadata/nonce/output-parent validators remain
unchanged. The semantic binding must equal the occurrence binding. Existing
private output directories, budgets and final output readers remain in force.

## Failure and resource accounting

A transport setup failure delegates the original compiler with no callback
selectors and records a bounded existing read/budget and callback-unavailable
outcome. It does not retry through mutable path bodies. Compiler spawn/failure
results retain their original behavior. Diagnostics contain categories or counts,
not request bodies, environment values or descriptor addresses.

At most two bodies are transported. Payload vectors total at most 32 KiB at the
producer and receiver; the producer drops its temporary payloads before fork.
Readback has a fixed 4 KiB working buffer. Memfd physical storage is the sum of
page-rounded actual body sizes; two bodies totaling 32 KiB use at most nine pages
when pages are 4 KiB. Fixed descriptor copies share those same kernel pages.
Decoded request objects and existing output allocations remain separately real
allocations; this API does not claim they are free or issue a resource grant.
Any original execution owner must admit and retain its own measured pages,
recorded bytes and metadata through its existing capacity/lifetime mechanism.

An external original owner may record non-authoritative physical observations
while the wrapper is alive. Authenticating a later callback requires its genuine
completed job, creator/child birth and image, fork/exec ordering, successful
writes/seals/consumption, exact raw schema and output correlation. This generic
API provides none of that execution authority itself.

## Validation

The source contains real Linux seal, mutation, descriptor, positional-read,
Command/child lifetime, failure and isolation controls, plus mandatory matching
nightly-driver positives and strict binding negatives. Missing actual driver,
compiler or sysroot inputs fails the genuine controls; it does not skip them.
The 165 existing public controls remain mandatory with their original assertion
bodies. Default/feature/platform/MSRV, standalone driver lock/source/archive and
license/package closure checks are required as well. Authored controls are not
execution or qualification evidence.
