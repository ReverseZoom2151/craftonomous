# Contributing to Craftonomous

Thanks for your interest. Craftonomous is an agent-agnostic Minecraft
embodiment and evaluation substrate, and the value of the project rests
entirely on its claims being true. Most of the rules below exist to protect
that.

## Getting set up

Node 22 or newer is required (`.nvmrc` pins 22; `nvm use` will pick it up).

```bash
npm ci
```

## The four checks

Every change must leave all four of these green. CI runs exactly these
commands, in this order, on push and on pull requests to `main`.

```bash
npm run typecheck   # tsc --noEmit, strict; the authority on types
npm run lint        # eslint ., flat config
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json
```

Two more that are useful locally:

```bash
npm run test:watch  # vitest in watch mode
npm run format      # prettier --write .
```

`npm run typecheck` is where type errors are meant to surface. The ESLint
config deliberately uses the non-type-checked preset so linting stays fast; do
not expect it to catch type problems.

Run `npm run format` before opening a pull request. Prettier is configured for
single quotes, semicolons, trailing commas, and an 80-column width; if your
editor formats on save with different settings, it will fight the repository.
`.editorconfig` covers the same ground for editors that read it.

## The clean-room rule

`reference_repos/` holds a local corpus of prior-art repositories. It is
git-ignored, excluded from lint and from Prettier, and it is **prior art, not
a parts bin**.

- **Read it.** Understanding how others solved a problem is the point of
  having it.
- **Cite it.** When prior art informed a design decision, say so — in
  `docs/PRIOR_ART.md`, in a code comment, or in the pull request description.
  Name the repository and what you took from it conceptually.
- **Never copy from it.** No source files, no functions, no snippets, no
  lightly-renamed ports. Not into `src/`, not into `tests/`, not into `docs/`.
  Licences differ across that corpus and we do not want to inherit any of them.

If you find yourself with a reference repo open in one window and the file
you are writing in the other, close the reference repo. Write it from your
understanding instead.

## Claims must match the implementation

The README distinguishes **what is implemented** from **what still requires
execution**, and that boundary is a promise to readers. It is the single
easiest thing in this project to break by accident.

- If your change implements something the README lists as not yet done, move
  it across in the same pull request.
- If your change removes, narrows, or weakens a capability the README claims,
  update the claim in the same pull request.
- Do not add a README claim for something that only exists in a branch, a
  design document, or your head.
- The same rule applies to `docs/` — `ARCHITECTURE.md`, `PERCEPTION.md`, and
  `SKILL_RELIABILITY.md` describe real behaviour, not intent. Aspirational
  material belongs in `docs/ROADMAP.md`, clearly marked as such.

A pull request that ships behaviour without updating the claims, or updates
the claims without shipping the behaviour, will be asked to do the other half.

## Tests

New behaviour needs tests. Tests live in `tests/`, mirroring the `src/` layout,
and run under Vitest. Perception and reliability code in particular is where
the project's honesty lives — if you touch the perception gate, the ledger,
or reliability accounting, expect to be asked for tests that pin down the
edge cases, not just the happy path.

## Commit messages

Imperative subject line, and a body that explains **why**.

```
Add decay to skill reliability estimates

A skill that succeeded fifty times last month and failed twice today
still reported a 96% success rate, which made the registry recommend
it long after the world had changed underneath it. Weight recent
outcomes more heavily so the estimate tracks current conditions.
```

- Subject: imperative mood ("Add", "Fix", "Remove" — not "Added", "Adds",
  "Fixing"), no trailing period, kept short enough to read in a log.
- Body: wrap at 72 columns. Explain the reason for the change and the
  consequence of not making it. The diff already shows _what_ changed; the
  message is the only place _why_ can live.
- Reference issues in the body (`Fixes #12`), not the subject.

## Pull requests

Fill in the pull request template. Keep pull requests focused — one concern
per pull request makes review, revert, and bisect all cheaper.

## Reporting security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
