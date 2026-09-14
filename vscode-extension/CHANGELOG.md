# Changelog

## [Unreleased]

### Changed
- `ai-council.reviewFile` / editor-title / editor-context / explorer-context / auto-save-on-save now all drive the sidebar's own review panel instead of a separate spawn+diagnostics+status-bar+output-channel implementation.

### Removed
- Inline diagnostics, the status bar indicator, and the separate "Show Last Review" webview panel - removed along with the parallel review pipeline in `extension.ts`. "Show Last Review" now opens the last generated HTML report instead.
- `ai-council.showInlineHints` and `ai-council.defaultMode` settings (no longer read by anything).

## [0.1.0] - 2026-09-09

### Added
- Initial release
- Review current file with GPT-4, Grok, and Claude
- Power Mode for premium models
- Inline diagnostics for issues
- Token usage and cost tracking
- HTML report generation
- Context menu integration
- Status bar indicator
- Auto-review on save (optional)
- Gemini support (optional)
