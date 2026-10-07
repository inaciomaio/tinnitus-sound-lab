# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-10-07

First website release.

### Added
- Split the prototype into ES modules with no build step.
- Log file format schema v2 (JSON) with session ids, edit times, deletion tombstones and settings. See `docs/LOG_FORMAT.md`.
- Import of JSON backups and CSV exports from every version, including the prototype. Imports merge and skip duplicates. Drag-and-drop supported.
- Export of the full log as JSON, or sessions as CSV (v1 column order, plus `id` and `updatedAt`).
- Optional Google Drive sync using the `drive.file` scope.
- Unit tests for the log format, run in CI.
- Automatic deploy to GitHub Pages from `main`.
- Content Security Policy and no-referrer policy.

### Changed
- Chart bars have a maximum width, so a short log stays readable.

## [0.1.0] — 2026-10-07

Single-file prototype: pitch matcher, bilateral alternation generator, session runner and log with CSV export.
