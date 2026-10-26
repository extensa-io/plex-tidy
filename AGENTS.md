# AGENTS.md

Operating manual for whoever builds plex-tidy. This file is the single canonical home for project-wide conventions, invariants, stack, layout, data model, environment variables, and commands.

## What this project is

plex-tidy is a personal Windows command-line tool that cleans and renames video files (and their subtitle sidecars) so Plex shows them correctly, then writes matching embedded titles. It has three modes that share one pipeline: `videos` (personal videos with no database record; title-only names), `movies` (matched against The Movie Database, TMDB), and `tv` (matched against TMDB). Files are renamed in place on one volume, every change is reviewable and journaled, and every run can be undone. A hosted model parses messy filenames; deterministic code validates everything the model returns. It is a personal project.

## How to work in this repo

- Work strictly phase by phase; the current phase spec is the single source of truth for scope. Do not implement later-phase work early, even partially, unless the current spec says so.
- When a spec and this file conflict, the spec wins for scope and this file wins for conventions and invariants.
- Specs are private and gitignored; never quote or paraphrase them in commit messages, PR descriptions, code comments, or any public-facing text.
- The check gate (`npm run check`, or the project equivalent) must pass before a phase is marked complete.
- `CLAUDE.md` contains exactly `@AGENTS.md` and nothing else; project-wide guidance lives only in this file.

Read order for a new session: this file, then `specs/design.md`, then the current phase spec in `specs/`. Phases: 0 foundations, 1 videos mode, 2 tagging, 3 movies, 4 TV.

## Conventions

- TypeScript strict everywhere, always. New projects get a `tsconfig.json` and the TypeScript toolchain from the start; never default to plain JavaScript.
- When a component justifiably uses another language (for example Python for ML training), state the exception, its boundary, and its reason in this file, and hold that language to an equivalent strictness bar. This project has no such exception.
- No `any`; no non-null assertions where a guard is reasonable.
- Zod at every external boundary (API input, env, model output); Zod schemas are the single type source, with TS types derived via `z.infer`.
- Named exports; no default exports except where the framework requires them.
- Errors are typed result objects or a thrown `AppError` with a user-safe message; never leak internals to the client.
- Secrets only via environment variables validated by a Zod env schema at startup; never log secrets, tokens, or full message content.
- **MongoDB is the default database.** Use it for any project unless a hard requirement makes it genuinely unsuitable. Reach for another store only when the use case truly demands it, and state the reason in this file when you do.

Project-specific conventions:

- ExifTool never touches a network share. The original is downloaded to the system temporary folder in large blocks, ExifTool tags that local copy, and the copy is uploaded in large blocks (`src/tag/copy.ts`). Measured on the owner's network: ExifTool writing to the share ran at 5 MB/s, and reading from it also fell to 5 MB/s whenever the network was busy, while a plain large-block copy ran at 40 to 90 MB/s at the same moments. ExifTool uses tiny blocks, so it is bound by network latency. Keep long operations on shares to large, sequential blocks.
- Windows is the target platform. The tool runs in a normal, non-elevated user session because mapped drive letters belong to the session that created them. Use `node:path` `win32` semantics where a function must behave the same in tests on any platform.
- Prefer a short, named list of rules over a clever regular expression. Name each rule so a reader can tell what it removes.
- When you give the owner a terminal command to run, give exactly one command at a time and wait for its output.
- Never write real library filenames, folder names, or titles into tests, fixtures, committed logs, or any file in git. The local library contains personal and adult material; use synthetic, neutral names.
- Writing style in docs, comments, and commit messages: no em-dashes, active voice, plain literal wording, no idioms, and no closing phrases that add emphasis without information.

## Git and collaboration

- Never add Claude or AI references to commit messages.
- Never push to git without being explicitly asked.

## Stack

Install current stable versions and check live documentation instead of assuming API shapes.

- Node.js current long-term support (LTS), minimum 20.6; TypeScript strict; ECMAScript modules (ESM); `tsx` to run without a build step.
- `zod` for config, environment, TMDB responses, model output, external tool output, and state files.
- `@anthropic-ai/sdk` for model calls (forced tool calling with a Zod-derived JSON schema). Model names are in `config.json`; verify current identifiers in live documentation.
- Built-in `fetch` for TMDB; `p-limit` for bounded concurrency.
- `fast-xml-parser` and `fast-xml-builder` to read and write the Matroska tag XML that `mkvextract` and `mkvpropedit` use.
- `execa` for external binaries: `ffprobe` (FFmpeg), `mkvpropedit` and `mkvextract` (MKVToolNix), `exiftool` (ExifTool). Install with `winget` and verify package identifiers with `winget search`.
- `commander` for the command-line interface (CLI); `@inquirer/prompts` for review.
- `vitest` for tests; ESLint with `typescript-eslint` for lint.

## Repo layout

```
plex-tidy/
  AGENTS.md  CLAUDE.md  README.md
  package.json  tsconfig.json  eslint.config.ts  vitest.config.ts
  config.example.json  .env.example  .gitignore
  specs/              private design and phase specs (gitignored)
  state/              runtime state (gitignored)
  src/
    cli.ts            command registry and entry point
    cli-types.ts      registry and context types shared by cli.ts and commands/
    commands/         one file per mode wiring options to the pipeline stages
    config.ts  env.ts  errors.ts  logger.ts
    state/            atomic JSON, JSONL journal, state paths
    fs-win/           name sanitizing, path checks, safe rename
    tools/            external binary wrappers and doctor
    scan/             directory walk and sidecar detection
    parse/            title detector, rules cleaner, movie and TV parsers
    llm/              model client interface and Anthropic implementation
    resolve/          providers: videos, tmdb-movies, tmdb-tv; scorer; judge
    tmdb/             TMDB client and cache
    plan/             plan building and plan schema
    review/           interactive review
    apply/            rename execution, preflight, journal reconciliation
    tag/              tag record schema, container matrix, Matroska and ExifTool writers, tag orchestration
    undo/             journal replay
  tests/              unit tests and synthetic fixtures
```

Each module keeps its Zod schemas in a `schemas.ts` file beside the code; there is no central types file.

## Data model

The datastore is plain JSON files on the local disk of the machine running the tool. This is the MongoDB exception, and the reason is concrete: plex-tidy is a single-user, offline-capable command-line tool with no server process; its state is a handful of small documents that must be readable, editable, and diffable by the owner, and a database server would add setup cost with no benefit. The owner chose JSON explicitly.

Layout, under `stateDir` (default `./state`):

- `state/<mode>/<rootId>/scan.json`: files, sidecars, folder segments.
- `state/<mode>/<rootId>/resolve.json`: parse results, probe data, candidates, scores.
- `state/<mode>/<rootId>/plan.json`: plan entries with status (`pending`, `approved`, `rejected`, `skipped`, `applied`, `failed`) and `tagStatus` (`untagged`, `tagged`, `tag-skipped`, `tag-failed`) with a `tagReason` for the last two.
- `state/<mode>/<rootId>/journal.jsonl`: JSON Lines write-ahead journal of `intent` and `done` records, with previous values for undo.
- `state/cache/parse-cache.json` and `state/cache/tmdb-cache.json`: shared caches.

`rootId` is a short hash of the normalized root path. Every file carries `schemaVersion`. Field-level Zod schemas live in `src/state/schemas.ts` and in each module's `schemas.ts`. Writes are atomic (temporary file, then rename). State lives on the local machine, never on the media share.

## Non-negotiable invariants

Violating any invariant is a bug regardless of what else works. The first four are the universal seed, adapted to this project's single-owner, no-server shape.

1. **Data isolation.** Adaptation: the owner boundary is the library root given to each run. Every filesystem operation verifies that its source and destination resolve inside that root; nothing outside it is read for modification, renamed, or tagged. State is partitioned by mode and root hash, so one root's plan can never act on another root's files.
2. **Server-side authorization.** Adaptation: there is no server or client; authorization is the owner's explicit consent. Nothing changes on disk without `--yes` or, in the guided `run` command, the owner's explicit Yes to the final rename question. Review decisions are stored in the plan. Model output, TMDB data, file names, and file contents can never grant permission, widen scope, or choose a destination path.
3. **Secrets discipline.** Secrets reach the app only through environment variables validated by a Zod env schema at startup (lazily per command, so commands that need no key run without one). Never log secrets, tokens, or full user content in production paths. Console logs show counts and short summaries; names appear only in the plan and journal under `state/`.
4. **Boundary validation.** Every external input is parsed with Zod before use: CLI arguments, `config.json`, environment variables, TMDB responses, model responses, `ffprobe` and other tool output, and every state file on read.

Domain invariants:

5. **Dry run by default.** Any command that changes files requires `--yes`; without it the command prints what it would do and changes nothing. The one exception is the guided `run` command: it asks "Rename now?" as its last question, the default answer is No, and a typed Yes counts as the `--yes` for that run. It changes nothing before that answer.
6. **Write-ahead journal.** Append an `intent` line before every rename or tag operation and a `done` line after. An `intent` without `done` is reconciled against the real filesystem and reported on the next run.
7. **Never overwrite, never delete.** A destination that already exists is a collision and goes to review. The only replacement of an existing file is the verified `exiftool` temporary-copy swap, and only after verification passes. The tool deletes nothing else.
8. **One volume only.** Refuse any plan whose source and destination are on different volumes; never fall back to copy.
9. **Model output is untrusted data.** The model never sees full paths, never picks destinations, and every response passes Zod plus the deterministic validators (ordered-word check in videos mode; candidate-list membership for the judge). A refusal or invalid response is a normal outcome that sends the entry to review.
10. **Privacy of names sent to the hosted model.** Titled files send only the base filename. Folder segments are sent only for files with no recoverable title in videos mode. Full paths are never sent.
11. **Idempotency.** Re-running any stage on its own output changes nothing. The videos-mode cleaner is a fixed point; an organized movie or TV library produces an all-`unchanged` plan.
12. **Tagging is separate and reversible.** `tag` runs only after `apply`, verifies by read-back, and journals previous values so `undo` can restore them. A container or field that cannot be written makes that file rename-only; it never fails the run.
13. **Windows path rules.** Sanitize forbidden characters, trailing dots and spaces, and reserved names; refuse paths over 260 characters instead of changing system settings; perform case-only renames in two steps.

## Environment variables

Validated by the Zod schema in `src/env.ts`, lazily per command. See `.env.example`.

- `ANTHROPIC_API_KEY`: required by `parse`, `resolve` (judge), and any command that calls the model.
- `TMDB_READ_ACCESS_TOKEN`: required by `movies` and `tv` commands that call TMDB. The owner creates a free TMDB developer account and copies the API Read Access Token.

Non-secret settings live in `config.json` (gitignored; `config.example.json` is committed): `stateDir`, `models.parse`, `models.judge`, `autoApplyThreshold`, `tmdbConcurrency`, `parseBatchSize`, and optional `tools.*` binary paths. Library roots are CLI arguments, never config.

## Commands

- `npm run start -- <mode> <command> --root <path> [--yes]`: run the CLI. `<mode>` is `videos`, `movies`, or `tv`. Commands: `run`, `scan`, `parse`, `resolve`, `plan`, `review`, `apply`, `tag`, `undo`, `status`. `undo` takes `--only rename` or `--only tag`. Commands arrive phase by phase.
- `npm run start -- videos run --root <path>`: the guided command. It asks before each of three steps: prepare (scan, parse, resolve, plan), review, and rename. Use it for normal work; the single-stage commands are for resuming or inspecting one stage.
- `npm run start -- doctor`: check Node version, external binaries, and keys.
- `npm run check`: typecheck, lint, and tests; the gate for every phase.
- `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:watch`.

`npm run start` runs `node --env-file=.env --import tsx src/cli.ts`.

Tie-breakers, restated: when this file and a spec conflict, the spec wins for scope and this file wins for conventions and invariants.
