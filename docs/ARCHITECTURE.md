# Architecture

## Principle
Prefer semantic text exposed by macOS Accessibility. OCR is a fallback,
not the primary extraction method.

## Data flow
Kindle Reader
→ AX reading viewport
→ pages.jsonl (source_type=AX本文)

If AX has no readable text:
Kindle Reader
→ screenshot
→ Japanese OCR candidates
→ best candidate
→ ocr_pages.jsonl (source_type=OCR画像本文)

Both streams
→ ordered merge by reading step
→ merged_pages.jsonl / ALL_TEXT_MERGED.txt

## Provenance
Never silently turn OCR into authoritative AX text.
Every merged block keeps its source type.

## Lifecycle
begin task
→ temporary keep-awake
→ capture
→ verify final page
→ OCR/merge
→ research index
→ cleanup
→ audit

No permanent foreground pinning or keep-awake service is required.
