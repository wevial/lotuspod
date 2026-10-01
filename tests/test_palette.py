"""Test suite for the theme's palette (`src/lotuspod/_theme/tokens.json`): every
text colour reads at WCAG AA on the night and surface backgrounds, and text
reads on the tints the theme draws it on.

The contrast is computed here with the WCAG 2 relative-luminance formula, and
the formula is first checked on a published pair: #767676 on white is 4.54:1.

Run from the repo root:

    python -m unittest tests.test_palette -v
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TOKENS = json.loads(
    (REPO_ROOT / "src" / "lotuspod" / "_theme" / "tokens.json").read_text(encoding="utf-8")
)
COLORS = TOKENS["colors"]
STRUCTURE = TOKENS["structure"]
INK = TOKENS["type"]["ink"]
# WCAG 2 AA for body text.
AA = 4.5

TEXT_COLORS = (
    "sky", "pale_sky", "rose", "pale_rose", "mint", "amber",
    "lavender", "pale_lavender", "muted_lavender",
)

RGBA = re.compile(r"rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\s*\)")
HEX = re.compile(r"#([0-9a-fA-F]{6})")


def parse(value: str) -> tuple[float, float, float, float]:
    """A token's colour as (r, g, b, alpha), channels 0-255."""
    match = HEX.fullmatch(value)
    if match:
        digits = match.group(1)
        return (int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16), 1.0)
    match = RGBA.fullmatch(value)
    if match:
        return (int(match.group(1)), int(match.group(2)), int(match.group(3)), float(match.group(4)))
    raise ValueError(f"not a hex or rgba() colour: {value!r}")


def over(top: str, under: str) -> str:
    """top composited over the opaque colour under, as hex."""
    r, g, b, alpha = parse(top)
    base = parse(under)
    assert base[3] == 1.0, f"{under} is not opaque"
    mixed = [round(c * alpha + u * (1 - alpha)) for c, u in zip((r, g, b), base[:3])]
    return "#" + "".join(f"{c:02x}" for c in mixed)


def luminance(value: str) -> float:
    """WCAG 2 relative luminance of an opaque colour."""
    r, g, b, alpha = parse(value)
    assert alpha == 1.0, f"{value} is not opaque"

    def linear(channel: float) -> float:
        c = channel / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)


def contrast(text: str, background: str) -> float:
    """The WCAG 2 contrast of text on an opaque background; a translucent
    text colour is composited over the background first."""
    if parse(text)[3] < 1.0:
        text = over(text, background)
    light, dark = sorted((luminance(text), luminance(background)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


class OracleTests(unittest.TestCase):
    def test_published_pair(self):
        self.assertEqual(round(contrast("#767676", "#ffffff"), 2), 4.54)

    def test_order_does_not_matter(self):
        self.assertAlmostEqual(contrast("#ffffff", "#767676"), contrast("#767676", "#ffffff"))

    def test_black_on_white_is_21(self):
        self.assertAlmostEqual(contrast("#000000", "#ffffff"), 21.0)


class TokenFormTests(unittest.TestCase):
    def test_every_colour_and_tint_is_hex_or_rgba(self):
        for group in (COLORS, STRUCTURE):
            for name, value in group.items():
                with self.subTest(name=name):
                    parse(value)


class TextColourTests(unittest.TestCase):
    def test_each_text_colour_reads_on_night_and_surface(self):
        for name in TEXT_COLORS:
            for ground in ("night", "surface"):
                with self.subTest(colour=name, on=ground):
                    self.assertGreaterEqual(contrast(COLORS[name], COLORS[ground]), AA)


class TintTests(unittest.TestCase):
    def test_text_reads_on_each_tint(self):
        night = COLORS["night"]
        surface = COLORS["surface"]
        pairs = {
            "pale_sky on header_tint": (COLORS["pale_sky"], over(STRUCTURE["header_tint"], night)),
            "pale_sky on code_chip over night": (COLORS["pale_sky"], over(STRUCTURE["code_chip"], night)),
            "pale_sky on code_chip over surface": (COLORS["pale_sky"], over(STRUCTURE["code_chip"], surface)),
            "ink on reader_tint": (INK, over(STRUCTURE["reader_tint"], night)),
            "ink on highlight": (INK, over(STRUCTURE["highlight"], night)),
            "pale_lavender on quote_band": (COLORS["pale_lavender"], over(STRUCTURE["quote_band"], night)),
        }
        for name, (text, ground) in pairs.items():
            with self.subTest(pair=name):
                self.assertGreaterEqual(contrast(text, ground), AA)


if __name__ == "__main__":
    unittest.main()
