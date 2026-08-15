# Changelog

All notable changes to `alter-obsidian-plugin` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-05-27

### Added

- Plugin-load preflight against the backend minimum-version floor. The
  signed floor document is verified with signing-key rotation support and
  the result is cached in Obsidian-managed plugin data. A stale (>7d) cache
  while offline and below the floor is the only intentional lockout case.
- Below-floor block: the plugin registers only an upgrade-prompt command and
  shows a modal directing the user to
  `Settings -> Community plugins -> Check for updates`. No ribbon, status-bar,
  pairing commands, settings tab, or daemon connection while blocked.
- Client identification headers attached to every backend call, so the
  service can apply the version floor and record upgrade prompts.

## [0.1.1] - 2026-05-18

### Changed

- Punctuation and typography cleanup across user-facing text.
