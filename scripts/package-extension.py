#!/usr/bin/env python3
"""Build a Chrome Web Store ZIP containing only the extension runtime files."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
extension = root / "extension"
manifest = json.loads((extension / "manifest.json").read_text())
version = manifest["version"]
assert version == json.loads((root / "package.json").read_text())["version"], "Version mismatch"
files = ["manifest.json", "background.js", "content.js", "options.html", "options.js"]
files += sorted(set(manifest["icons"].values()) | set(manifest["action"]["default_icon"].values()))
output = root / "release" / f"aionda-browser-mcp-{version}-chrome.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(extension / name, name)
print(output)
