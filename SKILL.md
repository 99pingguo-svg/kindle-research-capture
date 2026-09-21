# Kindle Research Capture — Agent Skill

## Use this when
A user owns a Kindle book on macOS and wants a local, searchable research corpus
from the text that the authorized Kindle UI exposes.

## Core pipeline
1. Start task-scoped keep-awake.
2. Open the owned/downloaded book in Kindle for Mac.
3. For Japanese vertical books, navigate to the first readable section.
4. Capture text exposed by macOS Accessibility.
5. If a reading viewport exposes no text, save its screenshot.
6. OCR only those image-only pages.
7. Merge AX and OCR blocks in reading order, preserving source_type.
8. Verify final-page coverage.
9. Clean up temporary processes and restore normal desktop state.

## Safety / copyright boundary
- Do not decrypt Kindle files or remove DRM.
- Do not publish captured book text or screenshots.
- Repository outputs must contain only tooling, tests, and synthetic examples.
- Keep AX text and OCR text provenance distinct.

## Commands
Capture:
```bash
python src/capture_kindle_jp_vertical.py --out OUT --title "Book" --max-pages 800
```

OCR + merge:
```bash
python src/ocr_integrate_kindle_jp.py --folder OUT
```

## macOS Japanese vertical navigation
Empirically reliable on the tested Kindle Mac build:
PageDown posted directly to the Kindle process advances the reading viewport.
Do not assume left/right arrow direction; verify navigation on each major Kindle update.

## Cleanup
Never leave keep-awake, capture UI, temporary servers, foreground pinning,
or automation running after the task.
