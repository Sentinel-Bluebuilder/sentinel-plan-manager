from PIL import Image
import os

src = os.path.join(os.path.dirname(__file__), '..', 'public', 'logo.png')
dst = os.path.join(os.path.dirname(__file__), '..', 'public', 'logo-dark.png')

img = Image.open(src).convert('RGBA')
w, h = img.size
px = img.load()

# Recolor near-black pixels (wordmark) to white. Leave blue shield + transparency alone.
# Threshold: if R,G,B all < 80 and alpha > 0, treat as black wordmark -> white.
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if a > 0 and r < 80 and g < 80 and b < 80:
            px[x, y] = (255, 255, 255, a)

img.save(dst, 'PNG')
print(f'wrote {dst} ({w}x{h})')
