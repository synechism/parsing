#!/usr/bin/env python3
import argparse
import json
import urllib.request
from pathlib import Path


PDFS = [
    {
        "id": "attention",
        "title": "Attention Is All You Need",
        "url": "https://arxiv.org/pdf/1706.03762.pdf",
        "why": "dense academic layout with figures, tables, formulas, and references",
    },
    {
        "id": "layoutparser",
        "title": "LayoutParser: A Unified Toolkit for Deep Learning Based Document Image Analysis",
        "url": "https://arxiv.org/pdf/2103.15348.pdf",
        "why": "document-layout paper with examples, figures, tables, and multi-column pages",
    },
    {
        "id": "doclaynet",
        "title": "DocLayNet: A Large Human-Annotated Dataset for Document-Layout Segmentation",
        "url": "https://arxiv.org/pdf/2206.01062.pdf",
        "why": "document AI paper with complex page images, tables, and visual comparisons",
    },
    {
        "id": "mineru",
        "title": "MinerU: An Open-Source Solution for Precise Document Content Extraction",
        "url": "https://arxiv.org/pdf/2409.18839.pdf",
        "why": "target-domain parser paper with evaluation tables and system diagrams",
    },
]


def download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "pdfparse-agent-e2e/0.1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        target.write_bytes(response.read())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("data/test-pdfs"))
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for item in PDFS:
        target = args.out / f"{item['id']}.pdf"
        if not target.exists() or target.stat().st_size == 0:
            print(f"Downloading {item['id']} -> {target}")
            download(item["url"], target)
        manifest.append({**item, "path": str(target), "bytes": target.stat().st_size})

    manifest_path = args.out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()

