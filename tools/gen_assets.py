#!/usr/bin/env python3
"""
Procedurally generates a pixel-art tileset and character spritesheets
for the Pixel Realm multiplayer sandbox game. No external art assets --
everything is drawn programmatically with Pillow so there are zero
licensing concerns.
"""
import os
import random
from PIL import Image, ImageDraw

random.seed(42)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "assets")
os.makedirs(OUT_DIR, exist_ok=True)

TILE = 16  # base tile size in px (rendered scaled up client-side)

def new_tile():
    return Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))

def noise_shade(base, variance=10):
    r, g, b = base
    d = random.randint(-variance, variance)
    return (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)))

def speckle(img, base, variance=12, density=0.35):
    px = img.load()
    for y in range(TILE):
        for x in range(TILE):
            if random.random() < density:
                px[x, y] = (*noise_shade(base, variance), 255)
            else:
                px[x, y] = (*base, 255)

# ---- Individual tile builders -------------------------------------------

def tile_grass():
    img = new_tile()
    speckle(img, (86, 158, 62), variance=14, density=0.5)
    d = ImageDraw.Draw(img)
    for _ in range(4):
        x, y = random.randint(1, TILE - 2), random.randint(1, TILE - 2)
        d.point((x, y), fill=(60, 130, 45, 255))
        d.point((x, y - 1), fill=(60, 130, 45, 255))
    return img

def tile_grass_flowers():
    img = tile_grass()
    d = ImageDraw.Draw(img)
    colors = [(255, 235, 90), (240, 240, 240), (255, 140, 170)]
    for _ in range(3):
        x, y = random.randint(1, TILE - 2), random.randint(1, TILE - 2)
        c = random.choice(colors)
        d.point((x, y), fill=(*c, 255))
    return img

def tile_dirt_path():
    img = new_tile()
    speckle(img, (176, 140, 92), variance=14, density=0.45)
    d = ImageDraw.Draw(img)
    for _ in range(3):
        x, y = random.randint(0, TILE - 1), random.randint(0, TILE - 1)
        d.point((x, y), fill=(140, 108, 68, 255))
    return img

def tile_water():
    img = new_tile()
    speckle(img, (58, 120, 200), variance=10, density=0.4)
    d = ImageDraw.Draw(img)
    for y in range(2, TILE, 4):
        d.line([(0, y), (TILE, y)], fill=(120, 180, 235, 180))
    return img

def tile_sand():
    img = new_tile()
    speckle(img, (222, 200, 142), variance=10, density=0.4)
    return img

def tile_tree():
    img = tile_grass()
    d = ImageDraw.Draw(img)
    # trunk
    d.rectangle([7, 11, 8, 15], fill=(94, 62, 40, 255))
    # canopy (layered circles for a pixel-art blob look)
    d.ellipse([2, 1, 13, 12], fill=(38, 102, 46, 255))
    d.ellipse([4, 0, 11, 8], fill=(52, 128, 58, 255))
    d.point((5, 3), fill=(70, 150, 72, 255))
    d.point((9, 5), fill=(70, 150, 72, 255))
    return img

def tile_rock():
    img = tile_grass()
    d = ImageDraw.Draw(img)
    d.ellipse([3, 6, 13, 14], fill=(120, 118, 122, 255))
    d.ellipse([4, 5, 10, 11], fill=(150, 148, 152, 255))
    d.point((6, 7), fill=(190, 188, 190, 255))
    return img

def tile_fence():
    img = tile_grass()
    d = ImageDraw.Draw(img)
    d.rectangle([2, 4, 3, 14], fill=(150, 110, 66, 255))
    d.rectangle([12, 4, 13, 14], fill=(150, 110, 66, 255))
    d.rectangle([1, 6, 14, 7], fill=(170, 128, 78, 255))
    d.rectangle([1, 10, 14, 11], fill=(170, 128, 78, 255))
    return img

TILES = {
    "grass": tile_grass(),
    "grass2": tile_grass_flowers(),
    "path": tile_dirt_path(),
    "water": tile_water(),
    "sand": tile_sand(),
    "tree": tile_tree(),
    "rock": tile_rock(),
    "fence": tile_fence(),
}

# Build a tileset strip in a fixed order (index used by client/server map data)
TILE_ORDER = ["grass", "grass2", "path", "water", "sand", "tree", "rock", "fence"]

sheet = Image.new("RGBA", (TILE * len(TILE_ORDER), TILE), (0, 0, 0, 0))
for i, name in enumerate(TILE_ORDER):
    sheet.paste(TILES[name], (i * TILE, 0))
sheet_path = os.path.join(OUT_DIR, "tileset.png")
sheet.save(sheet_path)
print("wrote", sheet_path, "tiles:", TILE_ORDER)

# ---- Character spritesheet -----------------------------------------------
# 4 directions (down, left, right, up) x 3 walk frames, 16x16 each,
# drawn as a simple rounded pixel-art humanoid. Body color is tinted
# per-player at request time on the server (query param), so we bake
# a "template" using placeholder colors and also generate a handful
# of pre-tinted variants for convenience.

CHAR_W, CHAR_H = 16, 16
DIRS = ["down", "left", "right", "up"]
FRAMES = 3

def draw_character(skin, shirt, hair, frame, direction):
    img = Image.new("RGBA", (CHAR_W, CHAR_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    bob = 0 if frame == 1 else 1  # idle-ish bob for walk cycle
    leg_offset = [0, 2, -2][frame] if direction in ("down", "up") else 0
    stride = [0, 1, -1][frame]

    # legs
    d.rectangle([6, 12 + bob, 7, 15], fill=(50, 50, 70, 255))
    d.rectangle([9, 12 + bob, 10, 15], fill=(50, 50, 70, 255))
    if direction in ("left", "right"):
        d.rectangle([6, 12 + bob, 7, 14 + (1 if stride > 0 else 0)], fill=(50, 50, 70, 255))
        d.rectangle([9, 12 + bob, 10, 14 - (1 if stride > 0 else 0)], fill=(50, 50, 70, 255))

    # body / shirt
    d.rectangle([5, 7 + bob, 11, 13 + bob], fill=(*shirt, 255))
    # arms
    d.rectangle([4, 8 + bob, 5, 11 + bob], fill=(*shirt, 255))
    d.rectangle([11, 8 + bob, 12, 11 + bob], fill=(*shirt, 255))

    # head
    d.rectangle([5, 2 + bob, 11, 7 + bob], fill=(*skin, 255))
    # hair
    d.rectangle([4, 1 + bob, 12, 3 + bob], fill=(*hair, 255))
    if direction == "down":
        d.rectangle([4, 1 + bob, 5, 4 + bob], fill=(*hair, 255))
        d.rectangle([11, 1 + bob, 12, 4 + bob], fill=(*hair, 255))
        # eyes
        d.point((7, 4 + bob), fill=(30, 30, 30, 255))
        d.point((9, 4 + bob), fill=(30, 30, 30, 255))
    elif direction == "up":
        pass  # back of head, no face
    elif direction == "left":
        d.point((6, 4 + bob), fill=(30, 30, 30, 255))
    elif direction == "right":
        d.point((10, 4 + bob), fill=(30, 30, 30, 255))

    return img

def make_spritesheet(skin, shirt, hair):
    sheet = Image.new("RGBA", (CHAR_W * FRAMES, CHAR_H * len(DIRS)), (0, 0, 0, 0))
    for row, direction in enumerate(DIRS):
        for frame in range(FRAMES):
            spr = draw_character(skin, shirt, hair, frame, direction)
            sheet.paste(spr, (frame * CHAR_W, row * CHAR_H))
    return sheet

# A palette of selectable shirt colors; skin/hair vary slightly per-color
# so each preset looks like a distinct little character.
PRESETS = {
    "red":    {"skin": (235, 194, 154), "shirt": (214, 64, 58),  "hair": (74, 48, 36)},
    "blue":   {"skin": (235, 194, 154), "shirt": (58, 108, 214), "hair": (40, 34, 30)},
    "green":  {"skin": (223, 180, 140), "shirt": (66, 158, 84),  "hair": (60, 40, 24)},
    "yellow": {"skin": (235, 194, 154), "shirt": (222, 182, 48), "hair": (90, 60, 30)},
    "purple": {"skin": (210, 170, 140), "shirt": (140, 70, 190), "hair": (30, 26, 26)},
    "teal":   {"skin": (223, 180, 140), "shirt": (48, 170, 170), "hair": (54, 38, 30)},
    "orange": {"skin": (235, 194, 154), "shirt": (230, 126, 34), "hair": (48, 34, 24)},
    "pink":   {"skin": (235, 194, 154), "shirt": (230, 110, 160),"hair": (66, 44, 34)},
}

for name, p in PRESETS.items():
    sheet = make_spritesheet(p["skin"], p["shirt"], p["hair"])
    path = os.path.join(OUT_DIR, f"char_{name}.png")
    sheet.save(path)
    print("wrote", path)

print("DIRS order:", DIRS, "FRAMES:", FRAMES, "CHAR SIZE:", CHAR_W, CHAR_H)
print("PRESET COLORS:", list(PRESETS.keys()))
