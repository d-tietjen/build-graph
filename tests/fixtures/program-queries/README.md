# Program plan fixtures

`fixture-graphs.cjs` declares a generic user-input parameter, a cross-package
`bridge::relay` -> `dependency::relay` intermediary, an explicit boolean check and
an application decoding operation. Its positive operation reads the relayed input;
the near-miss reads a separate parameter. These are compile-shaped synthetic facts,
not an exploitable application. The check is caller-declared policy, never inferred
from its spelling. Two procedures have the same displayed `decode` name while raw
graph IDs, procedure IDs, compiler IDs, packages and build units remain distinct.

Independent expected positive members include the input parameter, exact relay
argument/return steps, decoder argument, successful guard outcome and operation.
`other::decode` and the near-miss input route are excluded. Tests also construct a
convergent CFG with a shorter later route, loops, recursion, callback boundaries,
unresolved native/dependency bodies, missing capabilities and 1,000 unrelated
legacy procedures. Reads/writes tests assert syntactic usages only.

`capture-model.cjs` binds immutable exact declarations from the existing generic
multi-crate value-flow and guard-obligations workspaces. The real combined query
uses `guard_fixture::early_return` parameter 3 as declared input, the operation's
argument 3 as destination, and the existing four exact subject/value bindings.
The near-miss selects unrelated parameter 0. `positive` / `swapped` in the value
workspace supply an independent cross-package propagation pair. The fixture
applications are never executed; only the reviewed compiler importer captures them.

After independent source review, the coordinator runs:

```sh
node --test scripts/test-program-queries.cjs scripts/test-viewer-program-queries.cjs
GUARD_CAPTURE=/owned/guard/graph.json GUARD_HTML=/owned/guard/graph.html VALUE_CAPTURE=/owned/value/graph.json VALUE_HTML=/owned/value/graph.html node --test scripts/test-program-queries.cjs scripts/test-viewer-program-queries.cjs
```

The optional capture paths must come from the reviewed producer and pristine owned
fixture copies. They exercise complete shared API / actual emitted Blob worker /
fallback payloads and hashes, saved replay, CLI request/stdin/JSONL, public analyzer
agreement and independently expected slice membership. An absent environment
variable does not count as a compiler-backed pass.
