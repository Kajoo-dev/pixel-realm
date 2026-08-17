#!/usr/bin/env python3
"""
Procedurally generates pixel-art assets for the Pixel Realm multiplayer
sandbox game: the terrain tileset, character spritesheets, a standalone
animated tree sprite (for wind sway), a bird sprite (for fly-bys), and an
ornate UI frame for the nearby-player cards. No external art assets --
everything is drawn programmatically with Pillow so there are zero
licensing concerns.
"""
import os
import random
import math
from PIL import Image, ImageDraw

random.seed(42)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "assets")
os.makedirs(OUT_DIR, exist_ok=True)

TILE = 16  # base tile size in px (rendered scaled up client-side)
SUN = (-1, -1)  # light comes from upper-left: shade lower-right edges darker

def new_tile(size=TILE):
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))

def noise_shade(base, variance=10):
    r, g, b = base
    d = random.randint(-variance, variance)
    return (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)))

def speckle(img, base, variance=12, density=0.35):
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            if random.random() < density:
                px[x, y] = (*noise_shade(base, variance), 255)
            else:
                px[x, y] = (*base, 255)

def blend(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))

def ao_edge_shade(img, alpha=55, color=(0, 0, 0)):
    """Cheap ambient-occlusion: darken the bottom & right edge pixels a touch
    so tiles read as having a little depth instead of being flat swatches.
    Blended by hand into fully-opaque output pixels -- tiles are drawn
    edge-to-edge with ctx.drawImage and nothing behind them to composite
    against at runtime, so any pixel alpha < 255 baked into the PNG would
    blend against the canvas clear color instead of the tile art itself."""
    px = img.load()
    w, h = img.size
    frac = alpha / 255.0
    for x in range(w):
        r, g, b, a = px[x, h - 1]
        px[x, h - 1] = (*blend((r, g, b), color, frac), 255)
    for y in range(h):
        r, g, b, a = px[w - 1, y]
        px[w - 1, y] = (*blend((r, g, b), color, frac), 255)

def drop_shadow_ellipse(img, cx, cy, rx, ry, alpha=70, color=(20, 30, 15)):
    """A soft-ish elliptical ground shadow, pre-blended (not drawn with
    partial alpha -- see ao_edge_shade for why) into the existing pixels
    so it stays a fully opaque part of the baked tile art."""
    px = img.load()
    w, h = img.size
    frac = alpha / 255.0
    for y in range(max(0, cy - ry), min(h, cy + ry + 1)):
        for x in range(max(0, cx - rx), min(w, cx + rx + 1)):
            nx = (x - cx) / rx if rx else 0
            ny = (y - cy) / ry if ry else 0
            if nx * nx + ny * ny <= 1.0:
                r, g, b, a = px[x, y]
                px[x, y] = (*blend((r, g, b), color, frac), 255)

# ---- Individual tile builders -------------------------------------------

def tile_grass():
    img = new_tile()
    speckle(img, (84, 156, 60), variance=16, density=0.55)
    d = ImageDraw.Draw(img)
    # small blade tufts for texture
    for _ in range(6):
        x, y = random.randint(1, TILE - 2), random.randint(2, TILE - 2)
        shade = random.choice([(58, 126, 42), (108, 178, 78)])
        d.line([(x, y), (x, y - random.choice([1, 2]))], fill=(*shade, 255))
    # gentle top-left highlight, bottom-right shade for a touch of volume
    for x in range(TILE):
        for y in range(TILE):
            px = img.load()
            if (x + y) < 6:
                r, g, b, a = px[x, y]
                px[x, y] = (min(255, r + 10), min(255, g + 14), min(255, b + 8), a)
    ao_edge_shade(img, alpha=35)
    return img

def tile_grass_flowers():
    img = tile_grass()
    d = ImageDraw.Draw(img)
    colors = [(255, 235, 90), (245, 245, 245), (255, 140, 170), (255, 190, 80)]
    for _ in range(3):
        x, y = random.randint(1, TILE - 2), random.randint(1, TILE - 2)
        c = random.choice(colors)
        d.point((x, y), fill=(*c, 255))
        d.point((x, y - 1), fill=(70, 140, 50, 255))  # tiny green stem pixel
    return img

def tile_dirt_path():
    img = new_tile()
    speckle(img, (172, 136, 88), variance=16, density=0.5)
    d = ImageDraw.Draw(img)
    # pebbles
    for _ in range(5):
        x, y = random.randint(0, TILE - 1), random.randint(0, TILE - 1)
        c = random.choice([(140, 108, 68), (196, 168, 120), (120, 92, 58)])
        d.point((x, y), fill=(*c, 255))
    # a couple of tiny crack lines
    for _ in range(2):
        x, y = random.randint(2, TILE - 3), random.randint(2, TILE - 3)
        d.line([(x, y), (x + random.choice([-1, 1]), y + 2)], fill=(128, 98, 60, 255))
    ao_edge_shade(img, alpha=30)
    return img

def tile_water(frame=0):
    img = new_tile()
    base = (52, 112, 192)
    deep = (34, 82, 156)
    speckle(img, base, variance=8, density=0.3)
    # deeper-water vignette toward the edges for a touch of depth
    for x in range(TILE):
        for y in range(TILE):
            edge = min(x, y, TILE - 1 - x, TILE - 1 - y)
            if edge == 0:
                px = img.load()
                r, g, b, a = px[x, y]
                px[x, y] = (*blend((r, g, b), deep, 0.35), a)
    # animated shimmer bands: phase shifts per frame so cycling frames 0/1/2
    # reads as gentle water movement. Blended by hand (not drawn with
    # partial alpha) so the PNG stays fully opaque -- see ao_edge_shade.
    px = img.load()
    phase = frame * 2
    shimmer = (150, 205, 245)
    for y in range(-2 + phase % 4, TILE, 4):
        if 0 <= y < TILE:
            for x in range(TILE):
                r, g, b, a = px[x, y]
                px[x, y] = (*blend((r, g, b), shimmer, 0.55), 255)
    # a few bright sparkle pixels that relocate each frame (twinkle)
    spark_rand = random.Random(1000 + frame)
    sparkle = (225, 245, 255)
    for _ in range(3):
        x, y = spark_rand.randint(1, TILE - 2), spark_rand.randint(1, TILE - 2)
        r, g, b, a = px[x, y]
        px[x, y] = (*blend((r, g, b), sparkle, 0.8), 255)
    return img

def tile_sand():
    img = new_tile()
    speckle(img, (220, 197, 138), variance=12, density=0.45)
    d = ImageDraw.Draw(img)
    for _ in range(3):
        x, y = random.randint(0, TILE - 1), random.randint(0, TILE - 1)
        d.point((x, y), fill=(240, 225, 180, 255))  # light fleck
    for _ in range(2):
        x, y = random.randint(0, TILE - 1), random.randint(0, TILE - 1)
        d.point((x, y), fill=(180, 150, 95, 255))  # dark fleck / shell bit
    ao_edge_shade(img, alpha=25)
    return img

def tile_ground_shadow(base_tile_fn):
    """Grass (or other ground) tile with a soft baked shadow blob, used
    under objects that are drawn as separate overlay sprites (trees) so
    the shadow doesn't move/sway with them."""
    img = base_tile_fn()
    drop_shadow_ellipse(img, cx=9, cy=13, rx=6, ry=3, alpha=65)
    return img

def tile_rock():
    img = tile_grass()
    drop_shadow_ellipse(img, cx=9, cy=13, rx=6, ry=2, alpha=60)
    d = ImageDraw.Draw(img)
    d.ellipse([3, 6, 13, 14], fill=(112, 110, 116, 255))
    d.ellipse([4, 5, 10, 11], fill=(146, 144, 150, 255))
    d.ellipse([5, 5, 8, 8], fill=(172, 170, 176, 255))  # highlight
    d.point((6, 6), fill=(200, 198, 204, 255))
    d.line([(9, 9), (12, 12)], fill=(90, 88, 94, 255))  # crack/shade line
    return img

def tile_fence():
    img = tile_grass()
    d = ImageDraw.Draw(img)
    drop_shadow_ellipse(img, cx=8, cy=15, rx=7, ry=1, alpha=40)
    for post_x in (2, 12):
        d.rectangle([post_x, 4, post_x + 1, 14], fill=(140, 100, 58, 255))
        d.line([(post_x, 4), (post_x, 14)], fill=(168, 126, 78, 255))  # highlight edge
        d.line([(post_x + 1, 4), (post_x + 1, 14)], fill=(104, 72, 40, 255))  # shade edge
    for rail_y in (6, 10):
        d.rectangle([1, rail_y, 14, rail_y + 1], fill=(162, 122, 74, 255))
        d.line([(1, rail_y), (14, rail_y)], fill=(184, 142, 92, 255))
        d.line([(1, rail_y + 1), (14, rail_y + 1)], fill=(120, 88, 52, 255))
    return img

TILES = {
    "grass": tile_grass(),
    "grass2": tile_grass_flowers(),
    "path": tile_dirt_path(),
    "water0": tile_water(0),
    "water1": tile_water(1),
    "water2": tile_water(2),
    "sand": tile_sand(),
    "tree_ground": tile_ground_shadow(tile_grass),
    "rock": tile_rock(),
    "fence": tile_fence(),
}

# Build a tileset strip in a fixed order (index used by client/server map
# data for the base 8 logical tiles; the 3 water frames are additional
# strip entries the client cycles through client-side for shimmer, and
# tree_ground is the shadow-only ground tile drawn under the animated
# tree overlay sprite -- see tree.png below).
TILE_ORDER = ["grass", "grass2", "path", "water0", "sand", "tree_ground", "rock", "fence", "water1", "water2"]

sheet = Image.new("RGBA", (TILE * len(TILE_ORDER), TILE), (0, 0, 0, 0))
for i, name in enumerate(TILE_ORDER):
    sheet.paste(TILES[name], (i * TILE, 0))
sheet_path = os.path.join(OUT_DIR, "tileset.png")
sheet.save(sheet_path)
print("wrote", sheet_path, "tiles:", TILE_ORDER)

# ---- Standalone animated tree sprite --------------------------------------
# Taller than one tile so the canopy overflows into the tile above (anchored
# at bottom-center = the tile's bottom-center). Drawn by the client with a
# per-frame skew transform around its base for a wind-sway effect. No baked
# shadow here -- that lives in the "tree_ground" tile so it doesn't sway.

TREE_W, TREE_H = 18, 30

def make_tree():
    img = Image.new("RGBA", (TREE_W, TREE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = TREE_W // 2
    base_y = TREE_H - 1

    # trunk with grain shading
    d.rectangle([cx - 1, base_y - 9, cx + 1, base_y], fill=(88, 58, 36, 255))
    d.line([(cx - 1, base_y - 9), (cx - 1, base_y)], fill=(112, 76, 46, 255))
    d.line([(cx + 1, base_y - 9), (cx + 1, base_y)], fill=(64, 40, 24, 255))

    # canopy: layered blobs, dark outline first then lighter fills on top,
    # plus a cluster of small leaf-dabs for texture and a highlight patch.
    canopy_cy = base_y - 16
    d.ellipse([cx - 9, canopy_cy - 8, cx + 9, canopy_cy + 9], fill=(30, 84, 38, 255))
    d.ellipse([cx - 7, canopy_cy - 10, cx + 6, canopy_cy + 3], fill=(40, 104, 46, 255))
    d.ellipse([cx - 4, canopy_cy - 12, cx + 8, canopy_cy - 1], fill=(48, 118, 52, 255))
    d.ellipse([cx - 6, canopy_cy - 9, cx - 1, canopy_cy - 3], fill=(66, 142, 66, 255))  # highlight
    leaf_rand = random.Random(7)
    for _ in range(10):
        lx = cx + leaf_rand.randint(-8, 8)
        ly = canopy_cy + leaf_rand.randint(-9, 8)
        if (lx - cx) ** 2 + (ly - canopy_cy) ** 2 <= 81:
            shade = leaf_rand.choice([(26, 74, 34), (54, 124, 56), (36, 96, 42)])
            d.point((lx, ly), fill=(*shade, 255))
    return img

tree_img = make_tree()
tree_path = os.path.join(OUT_DIR, "tree.png")
tree_img.save(tree_path)
print("wrote", tree_path, "size:", tree_img.size)

# ---- Bird sprite (2-frame flap, for occasional fly-bys) -------------------

BIRD_W, BIRD_H = 12, 10

def make_bird(wings_up):
    img = Image.new("RGBA", (BIRD_W, BIRD_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    body = (46, 42, 58)
    # small body
    d.ellipse([4, 4, 8, 7], fill=(*body, 255))
    d.point((8, 4), fill=(*body, 255))  # tiny beak nub
    if wings_up:
        d.line([(5, 4), (1, 0)], fill=(*body, 255))
        d.line([(7, 4), (11, 0)], fill=(*body, 255))
    else:
        d.line([(5, 5), (0, 6)], fill=(*body, 255))
        d.line([(7, 5), (12, 6)], fill=(*body, 255))
    return img

bird_sheet = Image.new("RGBA", (BIRD_W * 2, BIRD_H), (0, 0, 0, 0))
bird_sheet.paste(make_bird(True), (0, 0))
bird_sheet.paste(make_bird(False), (BIRD_W, 0))
bird_path = os.path.join(OUT_DIR, "bird.png")
bird_sheet.save(bird_path)
print("wrote", bird_path, "frame size:", (BIRD_W, BIRD_H))

# ---- Ornate 9-slice frame for the nearby-player cards ---------------------
# A gold pixel-art bevel frame with small corner gems. Used as a CSS
# border-image so the card's own background shows through the transparent
# center.

FRAME = 48
SLICE = 14  # matches CSS border-image-slice

def make_ornate_frame():
    img = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    gold_dark = (120, 88, 20)
    gold = (196, 152, 42)
    gold_light = (244, 213, 120)
    gold_hi = (255, 240, 190)

    t = 6  # border thickness
    # base border band with a bevel: light on the outer edge, dark on inner
    d.rectangle([0, 0, FRAME - 1, FRAME - 1], outline=gold_dark, width=1)
    d.rectangle([1, 1, FRAME - 2, FRAME - 2], outline=gold_light, width=1)
    d.rectangle([2, 2, FRAME - 3, FRAME - 3], outline=gold, width=t - 4)
    d.rectangle([t - 1, t - 1, FRAME - t, FRAME - t], outline=gold_dark, width=1)

    # corner gem accents (small diamonds) at each corner
    def gem(cx, cy):
        pts = [(cx, cy - 4), (cx + 4, cy), (cx, cy + 4), (cx - 4, cy)]
        d.polygon(pts, fill=(176, 40, 46, 255))
        d.polygon([(cx, cy - 3), (cx + 2, cy), (cx, cy + 1), (cx - 2, cy)], fill=(232, 96, 96, 255))
        d.point((cx - 1, cy - 1), fill=(255, 200, 200, 255))

    m = t + 1
    gem(m, m)
    gem(FRAME - 1 - m, m)
    gem(m, FRAME - 1 - m)
    gem(FRAME - 1 - m, FRAME - 1 - m)

    # clear the center so the card's own background shows through
    inner = t + 5
    d.rectangle([inner, inner, FRAME - 1 - inner, FRAME - 1 - inner], fill=(0, 0, 0, 0))
    return img

frame_img = make_ornate_frame()
frame_path = os.path.join(OUT_DIR, "ornate_frame.png")
frame_img.save(frame_path)
print("wrote", frame_path, "size:", frame_img.size, "slice:", SLICE)

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
    stride = [0, 1, -1][frame]

    shirt_light = blend(shirt, (255, 255, 255), 0.25)
    shirt_dark = blend(shirt, (0, 0, 0), 0.25)

    # legs
    d.rectangle([6, 12 + bob, 7, 15], fill=(50, 50, 70, 255))
    d.rectangle([9, 12 + bob, 10, 15], fill=(50, 50, 70, 255))
    if direction in ("left", "right"):
        d.rectangle([6, 12 + bob, 7, 14 + (1 if stride > 0 else 0)], fill=(50, 50, 70, 255))
        d.rectangle([9, 12 + bob, 10, 14 - (1 if stride > 0 else 0)], fill=(50, 50, 70, 255))

    # body / shirt with a little shading for volume
    d.rectangle([5, 7 + bob, 11, 13 + bob], fill=(*shirt, 255))
    d.line([(5, 7 + bob), (5, 13 + bob)], fill=(*shirt_light, 255))
    d.line([(11, 7 + bob), (11, 13 + bob)], fill=(*shirt_dark, 255))
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

# ---------------------------------------------------------------------------
# ---- Race-based character sprites -----------------------------------------
# 4 races (human/elf/orc/goblin), each with a distinct height/build/skin/
# ear-shape/hair, and cloth armor tinted to whatever swatch color the player
# picked at login. Canvas is taller than the old flat 16x16 so the tallest
# (elf) and shortest (goblin) races can actually differ in on-screen height;
# the client anchors every sprite by its FEET (bottom row) rather than by a
# fixed square, exactly like the tree/bird overlay sprites already are, so
# variable-height art "just works" without changing collision/tile logic.
# ---------------------------------------------------------------------------

CHAR_NATIVE_W, CHAR_NATIVE_H = 20, 26
DEFAULT_ARMOR = (150, 150, 162)  # neutral "steel" used for character-select portraits

COLOR_RGB = {
    "red": (214, 64, 58), "blue": (58, 108, 214), "green": (66, 158, 84), "yellow": (222, 182, 48),
    "purple": (140, 70, 190), "teal": (48, 170, 170), "orange": (230, 126, 34), "pink": (230, 110, 160),
}

RACES = ["human", "elf", "orc", "goblin"]

RACE_PROFILES = {
    "human": dict(leg_h=7, torso_h=7, torso_w=3, head_r=3,
                  skin=(235, 194, 154), hair=(74, 48, 36), ear="round", tusks=False, hair_style="short"),
    "elf": dict(leg_h=8, torso_h=7, torso_w=2, head_r=3,
                skin=(230, 206, 180), hair=(222, 202, 142), ear="pointed", tusks=False, hair_style="long"),
    "orc": dict(leg_h=7, torso_h=8, torso_w=4, head_r=4,
                skin=(102, 136, 70), hair=(26, 22, 18), ear="small", tusks=True, hair_style="mohawk"),
    "goblin": dict(leg_h=4, torso_h=5, torso_w=2, head_r=3,
                   skin=(150, 172, 90), hair=None, ear="big", tusks=False, hair_style="bald"),
}

def draw_race_frame(race, armor_color_name, frame, direction):
    """One 20x26 frame of a race's walk cycle, feet anchored to the bottom
    row (row CHAR_NATIVE_H-1) so every race can have a different total
    height while still standing on the same ground line."""
    prof = RACE_PROFILES[race]
    cw, ch = CHAR_NATIVE_W, CHAR_NATIVE_H
    img = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cw // 2
    feet_y = ch - 1
    bob = 0 if frame == 1 else 1        # tiny vertical bob on the two "stepping" frames
    stride = [0, 1, -1][frame]           # leg fore/aft offset per walk frame

    leg_h, torso_h, torso_w, head_r = prof["leg_h"], prof["torso_h"], prof["torso_w"], prof["head_r"]
    skin, hair = prof["skin"], prof["hair"]

    torso_bottom = feet_y - leg_h
    torso_top = torso_bottom - torso_h + 1
    head_bottom = torso_top - 1
    head_cy = head_bottom - head_r
    head_top = head_cy - head_r

    armor = COLOR_RGB.get(armor_color_name, DEFAULT_ARMOR)
    armor_light = blend(armor, (255, 255, 255), 0.28)
    armor_dark = blend(armor, (0, 0, 0), 0.28)
    leg_color = (46, 42, 54)
    leg_light = blend(leg_color, (255, 255, 255), 0.2)

    # legs -- opposite feet offset by `stride` so a walk cycle reads clearly
    lx1, lx2 = cx - torso_w + 1, cx + torso_w - 2
    for lx, s in ((lx1, stride), (lx2, -stride)):
        top = torso_bottom + 1 + bob
        bottom = feet_y - (1 if s > 0 else 0)
        d.rectangle([lx, top, lx + 1, max(top, bottom)], fill=(*leg_color, 255))
        d.line([(lx, top), (lx, max(top, bottom))], fill=(*leg_light, 255))

    # torso / cloth armor, tinted to the chosen login color
    d.rectangle([cx - torso_w, torso_top + bob, cx + torso_w - 1, torso_bottom + bob], fill=(*armor, 255))
    d.line([(cx - torso_w, torso_top + bob), (cx - torso_w, torso_bottom + bob)], fill=(*armor_light, 255))
    d.line([(cx + torso_w - 1, torso_top + bob), (cx + torso_w - 1, torso_bottom + bob)], fill=(*armor_dark, 255))
    belt_y = torso_bottom + bob - 1
    d.line([(cx - torso_w, belt_y), (cx + torso_w - 1, belt_y)], fill=(60, 44, 26, 255))
    d.rectangle([cx - torso_w - 1, torso_top + bob, cx - torso_w, torso_top + bob + 1], fill=(*armor_light, 255))
    d.rectangle([cx + torso_w - 1, torso_top + bob, cx + torso_w, torso_top + bob + 1], fill=(*armor_light, 255))

    # arms (bare skin below the short sleeves)
    arm_top, arm_bottom = torso_top + 1 + bob, torso_bottom - 1 + bob
    d.rectangle([cx - torso_w - 2, arm_top, cx - torso_w - 1, arm_bottom], fill=(*skin, 255))
    d.rectangle([cx + torso_w, arm_top, cx + torso_w + 1, arm_bottom], fill=(*skin, 255))

    # head
    d.ellipse([cx - head_r, head_top + bob, cx + head_r, head_bottom + bob], fill=(*skin, 255))

    ear = prof["ear"]
    ey = head_cy + bob
    if ear == "pointed":
        d.polygon([(cx - head_r - 2, ey - 1), (cx - head_r, ey - 3), (cx - head_r, ey + 1)], fill=(*skin, 255))
        d.polygon([(cx + head_r + 2, ey - 1), (cx + head_r, ey - 3), (cx + head_r, ey + 1)], fill=(*skin, 255))
    elif ear == "big":
        d.ellipse([cx - head_r - 3, ey - 3, cx - head_r + 1, ey + 3], fill=(*skin, 255))
        d.ellipse([cx + head_r - 1, ey - 3, cx + head_r + 3, ey + 3], fill=(*skin, 255))
    else:
        d.ellipse([cx - head_r - 1, ey - 2, cx - head_r + 1, ey + 2], fill=(*skin, 255))
        d.ellipse([cx + head_r - 1, ey - 2, cx + head_r + 1, ey + 2], fill=(*skin, 255))

    if prof["tusks"]:
        d.line([(cx - 2, head_bottom + bob), (cx - 2, head_bottom + bob + 2)], fill=(235, 230, 210, 255))
        d.line([(cx + 2, head_bottom + bob), (cx + 2, head_bottom + bob + 2)], fill=(235, 230, 210, 255))

    if hair:
        style = prof["hair_style"]
        if style == "mohawk":
            d.rectangle([cx - 1, head_top + bob - 2, cx + 1, head_top + bob + 1], fill=(*hair, 255))
        elif style == "long":
            d.rectangle([cx - head_r, head_top + bob - 1, cx + head_r, head_top + bob + 1], fill=(*hair, 255))
            d.rectangle([cx - head_r - 1, head_top + bob, cx - head_r, head_bottom + bob + 3], fill=(*hair, 255))
            d.rectangle([cx + head_r, head_top + bob, cx + head_r + 1, head_bottom + bob + 3], fill=(*hair, 255))
        else:
            d.rectangle([cx - head_r, head_top + bob - 1, cx + head_r, head_top + bob + 1], fill=(*hair, 255))

    eye_y = head_cy + bob
    if direction == "down":
        d.point((cx - 2, eye_y), fill=(30, 30, 30, 255))
        d.point((cx + 2, eye_y), fill=(30, 30, 30, 255))
    elif direction == "left":
        d.point((cx - 2, eye_y), fill=(30, 30, 30, 255))
    elif direction == "right":
        d.point((cx + 2, eye_y), fill=(30, 30, 30, 255))
    # "up" (back of head): no face drawn

    return img

def make_race_spritesheet(race, armor_color_name):
    sheet = Image.new("RGBA", (CHAR_NATIVE_W * FRAMES, CHAR_NATIVE_H * len(DIRS)), (0, 0, 0, 0))
    for row, direction in enumerate(DIRS):
        for frame in range(FRAMES):
            spr = draw_race_frame(race, armor_color_name, frame, direction)
            sheet.paste(spr, (frame * CHAR_NATIVE_W, row * CHAR_NATIVE_H))
    return sheet

for race in RACES:
    for color_name in COLOR_RGB:
        sheet = make_race_spritesheet(race, color_name)
        path = os.path.join(OUT_DIR, f"race_{race}_{color_name}.png")
        sheet.save(path)
    print("wrote race spritesheets for", race, "x", len(COLOR_RGB), "colors")

print("RACE CHAR SIZE:", CHAR_NATIVE_W, CHAR_NATIVE_H)

# ---- Character-select portraits (one per race, neutral steel armor) -------

PORTRAIT_BG = {
    "human": (60, 70, 54), "elf": (40, 70, 60), "orc": (70, 40, 34), "goblin": (54, 64, 34),
}
PORTRAIT_W, PORTRAIT_H = 120, 150

def make_portrait(race):
    img = Image.new("RGBA", (PORTRAIT_W, PORTRAIT_H), (0, 0, 0, 255))
    d = ImageDraw.Draw(img)
    bg = PORTRAIT_BG.get(race, (50, 50, 60))
    bg_light = blend(bg, (255, 255, 255), 0.18)
    bg_dark = blend(bg, (0, 0, 0), 0.4)
    for y in range(PORTRAIT_H):
        t = y / PORTRAIT_H
        c = blend(bg_light, bg_dark, t)
        d.line([(0, y), (PORTRAIT_W - 1, y)], fill=(*c, 255))
    d.rectangle([0, 0, PORTRAIT_W - 1, PORTRAIT_H - 1], outline=(20, 16, 10, 255), width=2)
    d.rectangle([4, 4, PORTRAIT_W - 5, PORTRAIT_H - 5], outline=(196, 152, 42, 255), width=1)

    char_frame = draw_race_frame(race, "steel", 1, "down")
    scale = 4
    char_big = char_frame.resize((CHAR_NATIVE_W * scale, CHAR_NATIVE_H * scale), Image.NEAREST)
    px = (PORTRAIT_W - char_big.width) // 2
    py = PORTRAIT_H - char_big.height - 14

    shadow = Image.new("RGBA", (PORTRAIT_W, PORTRAIT_H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse([px + char_big.width * 0.15, py + char_big.height - 6,
                px + char_big.width * 0.85, py + char_big.height + 4], fill=(0, 0, 0, 90))
    img.alpha_composite(shadow)
    img.alpha_composite(char_big, (px, py))
    return img

for race in RACES:
    portrait = make_portrait(race)
    path = os.path.join(OUT_DIR, f"race_portrait_{race}.png")
    portrait.save(path)
    print("wrote", path)

# ---- Sword sprite (rotated client-side around the hilt for swings) --------

SWORD_W, SWORD_H = 24, 8

def make_sword():
    img = Image.new("RGBA", (SWORD_W, SWORD_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 3, 3, 5], fill=(90, 60, 30, 255))       # grip
    d.rectangle([3, 1, 4, 7], fill=(180, 150, 60, 255))      # cross-guard
    d.polygon([(4, 4), (22, 3), (23, 4), (22, 5)], fill=(210, 214, 222, 255))  # blade
    d.line([(4, 4), (22, 4)], fill=(240, 244, 250, 255))     # blade centerline highlight
    d.line([(4, 3), (20, 3)], fill=(150, 156, 168, 255))     # blade top edge shade
    return img

sword_img = make_sword()
sword_path = os.path.join(OUT_DIR, "sword.png")
sword_img.save(sword_path)
print("wrote", sword_path, "size:", sword_img.size, "-- pivot (hilt center) at (2,4)")

# ---- Smoke puff (monster death poof, 4-frame expand+fade) -----------------
# Unlike tiles, this is an overlay effect drawn on top of an already-
# rendered scene, so real partial alpha is exactly correct here (nothing
# like the tile-baking issue -- see ao_edge_shade's docstring above).

SMOKE_SIZE = 20
SMOKE_FRAMES = 4

def make_smoke_frame(i):
    img = Image.new("RGBA", (SMOKE_SIZE, SMOKE_SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    t = i / (SMOKE_FRAMES - 1)
    base_r = 3 + t * 6
    alpha = int(210 * (1 - t * 0.85))
    cx = cy = SMOKE_SIZE // 2
    rnd = random.Random(500 + i)
    for _ in range(5):
        ox = rnd.uniform(-3, 3) * (1 + t)
        oy = rnd.uniform(-3, 3) * (1 + t)
        r = base_r * rnd.uniform(0.6, 1.0)
        col = rnd.choice([(180, 180, 190), (150, 150, 160), (210, 210, 218)])
        d.ellipse([cx + ox - r, cy + oy - r, cx + ox + r, cy + oy + r], fill=(*col, alpha))
    return img

smoke_sheet = Image.new("RGBA", (SMOKE_SIZE * SMOKE_FRAMES, SMOKE_SIZE), (0, 0, 0, 0))
for i in range(SMOKE_FRAMES):
    smoke_sheet.paste(make_smoke_frame(i), (i * SMOKE_SIZE, 0), make_smoke_frame(i))
smoke_path = os.path.join(OUT_DIR, "smoke.png")
smoke_sheet.save(smoke_path)
print("wrote", smoke_path, "frames:", SMOKE_FRAMES, "frame size:", SMOKE_SIZE)

# ---- Monster sprites (rat / bat / spider), 4-dir x 2-frame walk cycle -----

MONSTER_CW, MONSTER_CH = 16, 16
MONSTER_FRAMES = 2
MONSTER_TYPES_ART = ["rat", "bat", "spider"]

def draw_monster_frame(mtype, frame, direction):
    img = Image.new("RGBA", (MONSTER_CW, MONSTER_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = 8, 9
    bob = 0 if frame == 0 else 1
    face_right = direction == "right"
    face_left = direction == "left"

    if mtype == "rat":
        body, belly = (120, 96, 78), (196, 178, 150)
        d.ellipse([cx - 5, cy - 3 + bob, cx + 3, cy + 3 + bob], fill=(*body, 255))
        d.ellipse([cx - 3, cy - 1 + bob, cx + 2, cy + 2 + bob], fill=(*belly, 255))
        tail_dir = 1 if not face_left else -1
        d.line([(cx + 3 * tail_dir, cy + bob), (cx + 7 * tail_dir, cy - 2 + bob)], fill=(*body, 255))
        d.ellipse([cx - 5, cy - 6 + bob, cx - 2, cy - 3 + bob], fill=(*body, 255))
        d.ellipse([cx - 1, cy - 6 + bob, cx + 2, cy - 3 + bob], fill=(*body, 255))
        eye_x = cx + 2 if face_right else cx - 3
        d.point((eye_x, cy - 2 + bob), fill=(20, 10, 10, 255))
        leg_off = 1 if frame == 1 else 0
        d.line([(cx - 3, cy + 3 + bob), (cx - 3, cy + 5 + bob - leg_off)], fill=(60, 50, 42, 255))
        d.line([(cx + 1, cy + 3 + bob), (cx + 1, cy + 5 + bob + leg_off)], fill=(60, 50, 42, 255))
    elif mtype == "bat":
        body = (60, 50, 70)
        d.ellipse([cx - 3, cy - 2 + bob, cx + 3, cy + 3 + bob], fill=(*body, 255))
        wing_spread = 6 if frame == 0 else 3
        d.polygon([(cx - 2, cy), (cx - 2 - wing_spread, cy - 4), (cx - 2 - wing_spread, cy + 1), (cx - 2, cy + 2)], fill=(*body, 255))
        d.polygon([(cx + 2, cy), (cx + 2 + wing_spread, cy - 4), (cx + 2 + wing_spread, cy + 1), (cx + 2, cy + 2)], fill=(*body, 255))
        d.point((cx - 1, cy - 1 + bob), fill=(200, 40, 40, 255))
        d.point((cx + 1, cy - 1 + bob), fill=(200, 40, 40, 255))
    elif mtype == "spider":
        body, highlight = (40, 36, 44), (70, 64, 76)
        d.ellipse([cx - 4, cy - 3 + bob, cx + 4, cy + 4 + bob], fill=(*body, 255))
        d.ellipse([cx - 2, cy - 2 + bob, cx + 1, cy + 1 + bob], fill=(*highlight, 255))
        leg_flex = 1 if frame == 1 else 0
        for i, dx in enumerate([-5, -3, 3, 5]):
            ly = (cy - 2 - leg_flex) if i % 2 == 0 else (cy + 2 + leg_flex)
            d.line([(cx + dx * 0.5, cy + bob), (cx + dx, ly + bob)], fill=(*body, 255))
        d.point((cx - 1, cy - 1 + bob), fill=(200, 30, 30, 255))
        d.point((cx + 1, cy - 1 + bob), fill=(200, 30, 30, 255))

    return img

for mtype in MONSTER_TYPES_ART:
    sheet = Image.new("RGBA", (MONSTER_CW * MONSTER_FRAMES, MONSTER_CH * len(DIRS)), (0, 0, 0, 0))
    for row, direction in enumerate(DIRS):
        for frame in range(MONSTER_FRAMES):
            spr = draw_monster_frame(mtype, frame, direction)
            sheet.paste(spr, (frame * MONSTER_CW, row * MONSTER_CH))
    path = os.path.join(OUT_DIR, f"monster_{mtype}.png")
    sheet.save(path)
    print("wrote", path, "size:", sheet.size)

print("Asset generation complete.")
