"""Every literal string the UI passes to T() (and every data-i18n attribute) has a Korean entry in i18n.js."""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "src" / "missile_studio" / "server" / "static"
LIT = re.compile(r"""(['"])((?:\\.|(?!\1).)*)\1""")


def _unquote(q: str, body: str) -> str:
    if q == "'":
        body = body.replace("\\'", "'").replace('"', '\\"')
    return json.loads('"' + body + '"')


def _dictionary_keys() -> set[str]:
    src = (STATIC / "i18n.js").read_text(encoding="utf-8")
    block = src[src.index("const KO = {") : src.index("\n  };")]
    return {_unquote(m.group(1), m.group(2)) for m in re.finditer(r"""(['"])((?:\\.|(?!\1).)*)\1\s*:""", block)}


def _first_arg(src: str, start: int) -> str:
    depth, j, quote = 0, start, None
    while j < len(src):
        c = src[j]
        if quote:
            if c == "\\":
                j += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c in "({[":
            depth += 1
        elif c in ")}]":
            depth -= 1
            if depth == 0:
                break
        elif c == "," and depth == 1:
            break
        j += 1
    return src[start + 1 : j]


def _ui_keys() -> set[str]:
    keys: set[str] = set()
    for name in ("app.js", "admin.js"):
        src = (STATIC / name).read_text(encoding="utf-8")
        for m in re.finditer(r"(?<![\w$.])T\(", src):
            arg = _first_arg(src, m.end() - 1)
            keys |= {_unquote(x.group(1), x.group(2)) for x in LIT.finditer(arg) if re.search("[A-Za-z]", x.group(2))}
    page = (STATIC / "index.html").read_text(encoding="utf-8")
    keys |= {html.unescape(v) for v in re.findall(r'data-i18n(?:-html|-ph)?="([^"]*)"', page)}
    return keys


def test_every_ui_string_has_korean():
    missing = sorted(_ui_keys() - _dictionary_keys())
    assert not missing, f"{len(missing)} UI strings have no Korean in i18n.js: {missing[:10]}"


def test_pages_load_the_dictionary_before_their_script():
    for page, script in (("index.html", "app.js"), ("admin.html", "admin.js")):
        text = (STATIC / page).read_text(encoding="utf-8")
        assert text.index("/static/i18n.js") < text.index(f"/static/{script}")
