#!/usr/bin/env python3
"""Build the hub's one HTML page on the shared page kit, from page/hub.css and page/hub.js.

The server only reads the finished hub/index.html, so it needs no Python at runtime.
Run this after changing anything in page/, and when the shared kit changes.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".claude/scripts/pages"))
import pagekit  # noqa: E402

HERE = Path(__file__).parent

html = pagekit.page(
    "Services",
    "",
    extra_css=(HERE / "page/hub.css").read_text(),
    extra_js=(HERE / "page/hub.js").read_text(),
)
(HERE / "index.html").write_text(html)
print(f"wrote {HERE / 'index.html'}")
