# Summary

<!-- What does this change, and why? The "why" matters more than the "what". -->

Fixes #

## Checks

All four must pass locally before review. CI runs the same commands.

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run format` has been run

## Claims match implementation

- [ ] The README's "what is implemented" / "what still requires execution"
      split is accurate after this change.
- [ ] Anything in `docs/` this change affects has been updated, or nothing in
      `docs/` describes it.
- [ ] No claim added here describes behaviour that is not in this diff.

## Clean room

- [ ] No code, comments, or prose were copied from `reference_repos/`.
- [ ] Where prior art informed this design, it is cited (below, in
      `docs/PRIOR_ART.md`, or in a code comment).

Prior art consulted:

<!-- Repository and what you took conceptually, or "none". -->

## Perception

- [ ] This change does not widen what the agent can perceive, **or** the new
      information is gated by a perception profile and recorded in the ledger.

Effect on the perception budget:

<!-- "None", or describe what is newly knowable and under which profiles. -->

## Tests

<!-- What did you add, and which edge cases does it pin down? If no tests were
     added, say why. -->

## Notes for reviewers

<!-- Anything worth looking at closely, tradeoffs taken, follow-ups deferred. -->
