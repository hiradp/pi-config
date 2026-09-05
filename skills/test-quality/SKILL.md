---
name: test-quality
description: Required whenever adding, modifying, planning, or auditing automated tests. Prevents low-value tests that restate implementation or framework behavior and focuses coverage on application-owned contracts and concrete regressions.
---

# Test Quality

Treat tests as maintained production code, not as a coverage inventory. Test application-owned behavior and credible regressions rather than translating each changed declaration or code branch into an assertion.

## Before writing tests

1. Identify the requirement, invariant, failure mode, or prior regression the change owns.
2. Map each proposed test to an externally meaningful outcome: returned value, persisted state, state transition, side effect, authorization decision, error contract, filtering result, or boundary behavior.
3. Inspect nearby tests for project conventions, but do not copy a pattern merely because it exists.
4. Prefer the cheapest test level that exercises the real contract without reproducing the implementation.

Do not assume every production-code change needs a new test. Existing higher-level coverage may already protect it, and stable framework behavior can be trusted.

## Value gate

Add or retain a test only when it has a clear answer to all of these:

- What application-owned contract or concrete regression does this protect?
- What realistic implementation defect would make it fail without requiring the framework or language runtime itself to be broken?
- Does the assertion observe behavior rather than restate the implementation?
- Is the behavior not already covered more effectively elsewhere?
- Will the test remain useful through a reasonable internal refactor?

If the only answer is “this line/declaration was added,” omit the test.

## Usually omit

- Conventional association, getter, setter, delegation, or dependency-injection wiring tested by round-tripping the objects just configured.
- Built-in framework validations, enum helpers, ORM persistence, or library behavior with no application-specific logic.
- Shared concern, mixin, or helper behavior repeated for every class that includes it.
- Generic public-ID, timestamp, factory-validity, constructor, or serialization-shape tests when the model does not customize that behavior.
- Assertions that a mock was called exactly as the implementation is written when the interaction is not itself a contract.
- Tests added only to mirror branches, increase coverage, or enumerate all changed symbols.

These are heuristics, not bans. Test framework integration when custom keys, scopes, callbacks, configuration, overrides, compatibility boundaries, or past regressions create a real application risk.

## Prefer

- Business invariants and negative paths.
- Non-default lifecycle behavior such as retention, cascade, restriction, retry, timeout, and rollback semantics.
- Custom validation conditions and boundaries, without retesting the framework primitive beneath them.
- Queries and scopes through included and excluded records.
- State transitions and their disallowed transitions.
- Permission boundaries, externally visible errors, persistence constraints, and regression reproductions.

For declarative framework code, assert the application outcome created by a meaningful non-default option. For example, test that deletion is blocked or a discarded record is retained; do not enumerate both directions of an ordinary ORM association.

## Final deletion pass

Before declaring the change complete, inspect every added or materially changed test independently of the implementation:

1. State the plausible application defect it catches.
2. Check whether another test already catches that defect.
3. Delete it if it only confirms stable framework behavior, repeats a shared helper's own coverage, or mirrors a declaration without protecting an application outcome.
4. Keep test names behavior-oriented and keep setup, action, and assertions visually distinct when repository conventions require it.

Do not preserve a weak test merely because it passes or was already written during the task.
