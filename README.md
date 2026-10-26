# plex-tidy

A Windows command-line tool that cleans and renames video files and their subtitle sidecars so Plex displays them correctly, and writes matching titles into the files' embedded metadata.

This is a personal project. There is no hosted version.

## What it does

plex-tidy has three modes that share one pipeline. `local` cleans filenames for personal videos that have no database record and keeps only the title. `movies` and `tv` match files against The Movie Database (TMDB) and rename them into the Plex naming scheme. Every run is a dry run unless you pass `--yes`, every change is journaled, and every run can be undone. Renaming and tagging are separate commands.

## Stack

TypeScript in strict mode on Node.js, run with `tsx`. Zod validates configuration, environment variables, API responses, model output, and state files. A hosted language model parses messy filenames, and deterministic code validates what it returns. TMDB provides movie and TV metadata. FFmpeg, MKVToolNix, and ExifTool handle probing and embedded tags. State is plain JSON on local disk.

## Development

Requirements: Windows, Node.js current LTS release (20.6 or later), and `winget` for the external tools.

```
npm install
copy .env.example .env
copy config.example.json config.json
npm run start -- doctor
```

Fill in `.env` with your keys and `config.json` with your settings, then run `doctor` again until it reports no problems. Run the tool from a normal, non-elevated terminal so mapped drive letters are visible.

Example run:

```
npm run start -- local scan --root U:\Videos
npm run start -- local plan --root U:\Videos
npm run start -- local review --root U:\Videos
npm run start -- local apply --root U:\Videos --yes
```

## Scripts

- `npm run start -- <mode> <command> [options]`: run the CLI.
- `npm run check`: typecheck, lint, and tests. This is the gate for every phase.
- `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:watch`.

## Repo layout

```
src/        CLI, pipeline stages, providers, tagging
tests/      unit tests and synthetic fixtures
state/      runtime state (gitignored)
specs/      private design and phase specs (gitignored)
AGENTS.md   conventions, invariants, and build instructions
```

## Phases

The build is staged across private phase specs: foundations, local mode, tagging, movies, and TV. Conventions and invariants live in `AGENTS.md`.
