# Icon source

`icon.svg` is the source for the marketplace tile; `icon.png` (128×128) is what `package.json` references.

Regenerate after editing the SVG:

```bash
convert -background none -density 384 images/icon.svg -resize 128x128 images/icon.png
convert images/icon.png -depth 8 -strip images/icon.png
```
