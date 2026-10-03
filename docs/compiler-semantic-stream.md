# Compiler semantic stream observations

`--observe-semantic-stream` adds an optional schema-1 `semantic_streams` array
to the compiler observation attachment. It requires
`--observe-definition-occurrences` and `--observe-compiler-inputs`, with the
same matching pinned nightly driver and selected Cargo route. It leaves
`CompilerOccurrencesV1` unchanged: that legacy record still has its 64/64 row
limits, 24 KiB limit, original identities and `analysis_coverage_partial` gap.
The new array is outside the original 32 KiB invocation record. Both formats,
invocation observations, generators and Cargo operations share the original
8 MiB attachment total.

## Actual domain and order

The producer uses the pinned compiler's `iter_local_def_id()` after analysis,
then `hir_walk_toplevel_module()` with `nested_filter::All` and the separate
`hir_walk_attributes()` traversal. This visits the
entire local definition table and the structural HIR tree, including modules,
imports, signatures and generics, traits and impls, associated items, foreign
declarations, variants, constants, closures and nested bodies. It does not use
the legacy body-only visitor as its semantic universe.

Definition rows retain actual local compiler indexes, kinds, bounded compiler
DefKey paths and source-map locations. HIR local bindings also retain their
owner index, since they have no LocalDefId. Reference rows retain actual path
and path-segment resolutions, local bindings, lifetime parameters, calls,
methods, field access and construction/destructuring, and overloaded or builtin
operators. Import namespace resolutions come from the compiler's `walk_use`.
Body type checking uses the actual type-checking root, including nested closures.
Entering an item, trait item, impl item or foreign item clears the enclosing
body table while its signature is visited. Its body installs its own original
table, and returning restores the enclosing table. Each lookup requires the
actual matching HIR owner and a supported expression, pattern or field node;
non-body associated-type signatures retain an unsupported disposition. The
pinned `visit_qpath` span remains the observed location; its walk helper takes
only the visitor, qualified path and HIR identity.
Method resolution attempts the actual post-analysis instance; unresolved dynamic
dispatch retains its observed trait target and an unsupported disposition.

Associated constraint identifiers, attribute semantics, inline assembly semantics,
unresolved segments, inferred lifetimes, indirect calls, unsupported field
resolution and overlong/deep definition paths are counted as unsupported.
Their nested supported HIR is still visited. Missing, expanded, zero-width or
otherwise unrepresentable coordinates retain explicit gaps or absent locations.
External compiler definition indexes are observed, with `external_target`;
they do not provide an external package-to-graph identity mapping. Generated
locations retain `generated_ordering_unknown`. MIR, later compiler phases,
generator provenance and input completeness are outside this local HIR domain.

Rows follow actual compiler definition enumeration and HIR traversal order.
There is no large all-occurrence collection or sorting pass. Each stream binds
its fresh callback nonce, enclosing ordered-command marker, crate, metadata and
`local_hir` domain. The attachment assigns the exact retained invocation ordinal
after the existing Cargo unit join and invocation sort.
The reader binds the semantic request to the same original pre-execution
callback request, including its nonce, command and unit. It reads both control
files through the existing anchored reader within one 32 KiB control allowance.
An omitted legacy occurrence record does not replace that original callback.
A present legacy record must agree with the stream nonce in both the reader
and portable attachment validator. These are correlation checks, not authority.

## Pages, terminal and bounds

Pages have contiguous ordinals, matching bindings, independently contiguous
definition/reference ordinals, at most 64 definitions and 64 references, and
at most 24 KiB **total encoded page bytes**. Page gaps describe dispositions
observed in that traversal prefix, including omitted candidates. Space for every
possible later gap is reserved before accepting a row. A row cannot acquire a new byte
allowance by crossing a page boundary. A small local page inventory records
actual committed byte sizes and markers before the observer reads pages.
It is not exported as an authentication record.

The terminal records the actual stop (`end_of_domain`, `work_limit`,
`output_limit`, `source_work_limit`, or `publication_interrupted`), traversal
work events, visited candidate definition/reference rows, unsupported candidates,
omitted **visited** rows, committed emitted rows/pages, source work and gaps.
An omitted count excludes the unvisited remainder after interruption; that
remainder is unknown. `end_of_domain` is emitted only after the actual definition
iteration and full HIR walk both reach their end. It can still contain unsupported
rows and gaps. A missing/rejected callback or terminal becomes an enclosing
observation gap and counted stream loss. None of these outcomes asserts complete
compiler inputs or graph association.

Source buffers remain compiler-owned. Each is at most 8 MiB; hashing across the
legacy and new callback shares one 32 MiB budget. Only the same actual immutable
compiler buffer deduplicates driver work. Every emitted source-map version and
row association remains present. The observer checks portable source references
through its existing stable anchored reader, with one additional 32 MiB source
validation allowance shared across all new streams in the attachment. Repeated
identical source references deduplicate read work without dropping rows.

A run-local short accounting transaction reserves page/index/terminal and cache
bookkeeping before allocation/publication. Its monotonic counter is shared by
all callbacks; interruption never resets it. Page capacity and inventory count
derive from remaining encoded budget. The reader admits all inventory sizes
before allocating the page vector. Bounded deserializers ignore untrusted size
hints and reject row/page inventories above the finite envelope. Traversal has
one million work events, including bounded DefKey walks (at most 64 components
and 1024 bytes). The existing invocation, argument, Cargo-operation and file-work
limits remain in force. The final assembly charges all retained observations
before insertion and reserves room for loss witnesses; it can discard optional
streams with explicit truncation instead of exceeding 8 MiB.

Nonces, FNV markers, counts, compiler indexes and terminal bookkeeping are
observational consistency data. They do not authenticate execution, establish
complete graph association or authorize reuse.

## Measurement still required

Authoring has not executed the producer or regressions. The shared Linux job
must compile the actual driver against `nightly-2026-02-27`/`rustc-dev`, compile
the default and feature-enabled CLI, and run all existing observation/Cargo
routing cases plus the semantic DTO, page-reader and genuine compiler traversal
cases. The genuine cases cover structural domains, more than one page,
unsupported resolution/path limits, 8 MiB per-file and 32 MiB stream work
interruptions, and actual output overflow. They fail if the matching driver is
missing. Actual compiler/API compatibility, generated ordering, external identity
mapping and downstream graph association remain measurement/consumer gates.

See [validation](compiler-input-validation.md) for the source selector inventory.
