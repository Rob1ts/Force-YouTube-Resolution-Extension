"""Generate the extension icons from a single vector-like drawing.

Usage: python scripts/make-icons.py
Requires Pillow (only needed when regenerating the checked-in PNGs).
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

SIZE = 1024
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "src" / "icons"
DOCS_DIR = ROOT / "docs"


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def diagonal_gradient(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    start = (255, 51, 85)
    end = (204, 0, 34)
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            pixels[x, y] = tuple(
                round(start[channel] + (end[channel] - start[channel]) * t)
                for channel in range(3)
            )
    return image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    canvas = diagonal_gradient(SIZE).convert("RGBA")

    # Soft highlight in the upper-left corner.
    highlight = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    hdraw = ImageDraw.Draw(highlight)
    hdraw.ellipse((-360, -470, 760, 540), fill=(255, 255, 255, 34))
    canvas = Image.alpha_composite(canvas, highlight)

    # Soft shadow cast by the play mark.
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.polygon([(430, 330), (430, 760), (760, 545)], fill=(110, 0, 18, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    canvas = Image.alpha_composite(canvas, shadow)

    draw = ImageDraw.Draw(canvas)

    # Play triangle.
    draw.polygon([(402, 290), (402, 734), (748, 512)], fill=(255, 255, 255, 255))

    # Small upward chevron in the lower-right: "maximum".
    chevron = [(690, 735), (790, 635), (890, 735)]
    draw.line(chevron, fill=(255, 255, 255, 235), width=42, joint="curve")

    alpha = ImageChops.multiply(canvas.getchannel("A"), rounded_rect_mask(SIZE, 236))
    canvas.putalpha(alpha)

    for size in (16, 32, 48, 128):
        resized = canvas.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(OUT_DIR / f"icon{size}.png", optimize=True)

    canvas.resize((512, 512), Image.Resampling.LANCZOS).save(
        DOCS_DIR / "logo.png", optimize=True
    )

    print(f"Wrote icons to {OUT_DIR}")
    print(f"Wrote README logo to {DOCS_DIR / 'logo.png'}")


if __name__ == "__main__":
    main()
