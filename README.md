# kindle-research-capture

A macOS research workflow for building a private searchable corpus from
Kindle text that is already visible to the authorized Kindle application.

The project was designed around Japanese vertical-writing books, where
normal page-turn assumptions and OCR-only approaches are unreliable.

## What it does

- Reads Kindle text through macOS Accessibility (AX).
- Preserves one reading viewport per JSONL record.
- Detects image-only viewports and saves screenshots.
- OCRs image-only pages with both Japanese horizontal and vertical models.
- Merges AX and OCR blocks while preserving provenance.
- Uses task-scoped keep-awake instead of permanent system changes.
- Includes explicit cleanup workflow for agent-driven desktop automation.

## What it does not do

It does not decrypt Kindle files, remove DRM, scrape Amazon servers, or ship
any book text. Captured content stays local and should not be committed.

## Quick start

Requirements: macOS, Kindle for Mac, Python with PyObjC
(`ApplicationServices`, `AppKit`, `Quartz`), Tesseract with `jpn` and
`jpn_vert`, and optionally PyMuPDF.

See [SKILL.md](SKILL.md) for the compact agent procedure.
