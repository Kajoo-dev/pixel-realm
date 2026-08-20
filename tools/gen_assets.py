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

def silhouette_shade(img, light_frac=0.14, dark_frac=0.24,
                      light_color=(255, 255, 255), dark_color=(8, 8, 14)):
    """Simple top-light / bottom-shadow gradient across any sprite with a
    transparent background (characters, monsters, the dragon): each opaque
    pixel is nudged toward `light_color` near the top of the sprite's own
    bounding box and toward `dark_color` near the bottom, reading as a
    little contour/depth instead of a flat cutout. Silhouette and alpha are
    untouched -- purely a color nudge, so it's safe to run on every frame of
    every sheet without affecting collision, hitboxes, or animation."""
    px = img.load()
    w, h = img.size
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 0:
                if x < minx: minx = x
                if y < miny: miny = y
                if x > maxx: maxx = x
                if y > maxy: maxy = y
    if maxx < minx:
        return img
    bh = max(1, maxy - miny)
    for y in range(miny, maxy + 1):
        t = (y - miny) / bh  # 0 = top, 1 = bottom
        if t < 0.45:
            frac = light_frac * (1 - t / 0.45)
            color = light_color
        elif t > 0.55:
            frac = dark_frac * ((t - 0.55) / 0.45)
            color = dark_color
        else:
            continue
        for x in range(minx, maxx + 1):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            px[x, y] = (*blend((r, g, b), color, frac), a)
    return img

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

def tile_cave_floor():
    img = new_tile()
    base = (96, 92, 100)
    speckle(img, base, variance=14, density=0.5)
    d = ImageDraw.Draw(img)
    # flagstone-ish crack lines
    cracks = random.Random(77)
    for _ in range(3):
        x, y = cracks.randint(1, TILE - 2), cracks.randint(1, TILE - 2)
        x2 = x + cracks.choice([-3, -2, 2, 3])
        y2 = y + cracks.choice([-3, -2, 2, 3])
        d.line([(x, y), (max(0, min(TILE - 1, x2)), max(0, min(TILE - 1, y2)))], fill=(64, 60, 68, 255))
    # a few lighter pebble flecks
    for _ in range(4):
        x, y = cracks.randint(0, TILE - 1), cracks.randint(0, TILE - 1)
        d.point((x, y), fill=(130, 126, 136, 255))
    ao_edge_shade(img, alpha=45, color=(20, 18, 24))
    return img

def tile_cave_wall():
    img = new_tile()
    base = (54, 50, 58)
    speckle(img, base, variance=10, density=0.6)
    d = ImageDraw.Draw(img)
    # jagged rock-face facets for a "solid wall" read
    facets = random.Random(88)
    for _ in range(5):
        x, y = facets.randint(0, TILE - 1), facets.randint(0, TILE - 1)
        r = facets.randint(1, 2)
        shade = facets.choice([(38, 35, 42), (70, 66, 76), (30, 28, 34)])
        d.ellipse([x - r, y - r, x + r, y + r], fill=(*shade, 255))
    # a bright top-edge highlight so walls read as vertical/raised
    for x in range(TILE):
        px = img.load()
        r, g, b, a = px[x, 0]
        px[x, 0] = (*blend((r, g, b), (100, 96, 108), 0.5), 255)
        r, g, b, a = px[x, 1]
        px[x, 1] = (*blend((r, g, b), (90, 86, 98), 0.3), 255)
    ao_edge_shade(img, alpha=70, color=(10, 9, 12))
    return img

def tile_tavern_floor():
    img = new_tile()
    base = (120, 88, 56)
    speckle(img, base, variance=10, density=0.45)
    d = ImageDraw.Draw(img)
    # wooden plank seams
    planks = random.Random(99)
    for py in (0, 5, 10, 15):
        d.line([(0, py), (TILE - 1, py)], fill=(78, 54, 32, 255))
    for _ in range(5):
        x = planks.randint(1, TILE - 2)
        y0 = planks.choice([0, 5, 10])
        d.line([(x, y0), (x, min(TILE - 1, y0 + 4))], fill=(96, 68, 42, 255))
    ao_edge_shade(img, alpha=40, color=(30, 20, 12))
    return img

def tile_tavern_wall():
    img = new_tile()
    base = (94, 66, 44)
    speckle(img, base, variance=8, density=0.4)
    d = ImageDraw.Draw(img)
    # horizontal timber courses
    mortar = random.Random(64)
    for py in (0, 6, 12):
        d.line([(0, py), (TILE - 1, py)], fill=(52, 36, 22, 255))
    for _ in range(4):
        x, y = mortar.randint(0, TILE - 1), mortar.randint(0, TILE - 1)
        d.point((x, y), fill=(130, 98, 64, 255))
    for x in range(TILE):
        px = img.load()
        r, g, b, a = px[x, 0]
        px[x, 0] = (*blend((r, g, b), (150, 118, 80), 0.4), 255)
    ao_edge_shade(img, alpha=65, color=(18, 12, 8))
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
    "cave_floor": tile_cave_floor(),
    "cave_wall": tile_cave_wall(),
    "tavern_wall": tile_tavern_wall(),
    "tavern_floor": tile_tavern_floor(),
}

# Build a tileset strip in a fixed order matching TILE_IDS in server/map.js
# (grass..fence occupy 0-7, cave_floor/cave_wall are 8-9 for the dragon's
# cave, tavern_wall/tavern_floor are 10-11). water1/water2 are extra strip
# entries -- not real map tile ids -- that the client cycles through
# client-side for shimmer animation.
TILE_ORDER = ["grass", "grass2", "path", "water0", "sand", "tree_ground", "rock", "fence",
              "cave_floor", "cave_wall", "tavern_wall", "tavern_floor", "water1", "water2"]

sheet = Image.new("RGBA", (TILE * len(TILE_ORDER), TILE), (0, 0, 0, 0))
for i, name in enumerate(TILE_ORDER):
    sheet.paste(TILES[name], (i * TILE, 0))
sheet_path = os.path.join(OUT_DIR, "tileset.png")
sheet.save(sheet_path)
print("wrote", sheet_path, "tiles:", TILE_ORDER)

# ---- Edge-dither mask (for softening the hard tile grid) -------------------
# A small alpha-only strip (real, un-baked transparency is fine here since
# it's composited as a runtime OVERLAY on top of an already-drawn scene --
# unlike the base tiles above, nothing is relying on it being edge-to-edge
# opaque). The client tints this per neighboring-tile-type at load time
# (via an offscreen canvas + 'destination-in') and stamps it along any tile
# edge that borders a different ground type, so transitions dissolve
# instead of reading as a hard grid line. Alpha fades from strong at the
# tile edge to nothing a few px in; only the alpha channel is used.
EDGE_W, EDGE_H = TILE, 6

def make_edge_dither_mask():
    img = Image.new("RGBA", (EDGE_W, EDGE_H), (0, 0, 0, 0))
    px = img.load()
    rnd = random.Random(321)
    for y in range(EDGE_H):
        base_alpha = max(0, 235 - y * 62)
        for x in range(EDGE_W):
            if rnd.random() < 0.82:
                a = max(0, base_alpha - rnd.randint(0, 60))
                px[x, y] = (255, 255, 255, a)
    return img

edge_mask_img = make_edge_dither_mask()
edge_mask_path = os.path.join(OUT_DIR, "edge_dither_mask.png")
edge_mask_img.save(edge_mask_path)
print("wrote", edge_mask_path, "size:", edge_mask_img.size)

# ---- Standalone animated tree sprites (4 varieties) ------------------------
# Taller than one tile so the canopy overflows into the tile above (anchored
# at bottom-center = the tile's bottom-center). Drawn by the client with a
# per-frame skew transform around its base for a wind-sway effect. No baked
# shadow here -- that lives in the "tree_ground" tile so it doesn't sway.
# All 4 variants share one canvas size and are laid out side by side in
# trees.png; the client picks a variant per tile deterministically from a
# hash of its (row, col) so the choice is stable but varied across the map.

TREE_W, TREE_H = 18, 32

def make_tree_round():
    """The original leafy round canopy."""
    img = Image.new("RGBA", (TREE_W, TREE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = TREE_W // 2
    base_y = TREE_H - 1
    d.rectangle([cx - 1, base_y - 9, cx + 1, base_y], fill=(88, 58, 36, 255))
    d.line([(cx - 1, base_y - 9), (cx - 1, base_y)], fill=(112, 76, 46, 255))
    d.line([(cx + 1, base_y - 9), (cx + 1, base_y)], fill=(64, 40, 24, 255))
    canopy_cy = base_y - 16
    d.ellipse([cx - 9, canopy_cy - 8, cx + 9, canopy_cy + 9], fill=(30, 84, 38, 255))
    d.ellipse([cx - 7, canopy_cy - 10, cx + 6, canopy_cy + 3], fill=(40, 104, 46, 255))
    d.ellipse([cx - 4, canopy_cy - 12, cx + 8, canopy_cy - 1], fill=(48, 118, 52, 255))
    d.ellipse([cx - 6, canopy_cy - 9, cx - 1, canopy_cy - 3], fill=(66, 142, 66, 255))
    leaf_rand = random.Random(7)
    for _ in range(10):
        lx = cx + leaf_rand.randint(-8, 8)
        ly = canopy_cy + leaf_rand.randint(-9, 8)
        if (lx - cx) ** 2 + (ly - canopy_cy) ** 2 <= 81:
            shade = leaf_rand.choice([(26, 74, 34), (54, 124, 56), (36, 96, 42)])
            d.point((lx, ly), fill=(*shade, 255))
    return img

def make_tree_pine():
    """A layered conifer -- stacked triangular tiers, narrower silhouette."""
    img = Image.new("RGBA", (TREE_W, TREE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = TREE_W // 2
    base_y = TREE_H - 1
    d.rectangle([cx - 1, base_y - 6, cx + 1, base_y], fill=(80, 54, 34, 255))
    d.line([(cx - 1, base_y - 6), (cx - 1, base_y)], fill=(104, 72, 44, 255))
    dark, mid, light = (18, 66, 40), (26, 88, 50), (44, 116, 62)
    tiers = [
        (base_y - 6, 9, dark), (base_y - 6, 9, dark),
        (base_y - 13, 7, mid),
        (base_y - 19, 5, light),
        (base_y - 24, 3, light),
    ]
    seen_y = set()
    for i, (tip_base_y, half_w, color) in enumerate(tiers):
        if tip_base_y in seen_y:
            continue
        seen_y.add(tip_base_y)
        top_y = tip_base_y - (7 if half_w > 6 else 6 if half_w > 4 else 5)
        d.polygon([(cx, top_y), (cx - half_w, tip_base_y), (cx + half_w, tip_base_y)], fill=(*color, 255))
    # a few snow-cap / highlight flecks near the top
    d.point((cx, base_y - 25), fill=(210, 230, 210, 255))
    d.point((cx - 1, base_y - 20), fill=(*light, 255))
    return img

def make_tree_autumn():
    """Same round-canopy silhouette as the classic tree, but warm autumn
    foliage colors for map variety."""
    img = Image.new("RGBA", (TREE_W, TREE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = TREE_W // 2
    base_y = TREE_H - 1
    d.rectangle([cx - 1, base_y - 9, cx + 1, base_y], fill=(94, 62, 38, 255))
    d.line([(cx - 1, base_y - 9), (cx - 1, base_y)], fill=(118, 82, 50, 255))
    d.line([(cx + 1, base_y - 9), (cx + 1, base_y)], fill=(68, 44, 26, 255))
    canopy_cy = base_y - 16
    d.ellipse([cx - 9, canopy_cy - 8, cx + 9, canopy_cy + 9], fill=(150, 62, 24, 255))
    d.ellipse([cx - 7, canopy_cy - 10, cx + 6, canopy_cy + 3], fill=(196, 96, 30, 255))
    d.ellipse([cx - 4, canopy_cy - 12, cx + 8, canopy_cy - 1], fill=(222, 138, 40, 255))
    d.ellipse([cx - 6, canopy_cy - 9, cx - 1, canopy_cy - 3], fill=(238, 176, 66, 255))
    leaf_rand = random.Random(19)
    for _ in range(12):
        lx = cx + leaf_rand.randint(-8, 8)
        ly = canopy_cy + leaf_rand.randint(-9, 8)
        if (lx - cx) ** 2 + (ly - canopy_cy) ** 2 <= 81:
            shade = leaf_rand.choice([(210, 70, 30), (236, 150, 40), (176, 44, 28), (244, 196, 90)])
            d.point((lx, ly), fill=(*shade, 255))
    return img

def make_tree_willow():
    """A tall, slender tree with a sparse drooping canopy."""
    img = Image.new("RGBA", (TREE_W, TREE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = TREE_W // 2
    base_y = TREE_H - 1
    d.rectangle([cx, base_y - 14, cx + 1, base_y], fill=(84, 66, 44, 255))
    d.line([(cx, base_y - 14), (cx, base_y)], fill=(106, 84, 56, 255))
    canopy_cy = base_y - 22
    d.ellipse([cx - 6, canopy_cy - 6, cx + 7, canopy_cy + 5], fill=(46, 110, 64, 255))
    d.ellipse([cx - 4, canopy_cy - 8, cx + 5, canopy_cy - 1], fill=(60, 130, 74, 255))
    # drooping frond lines hanging down from the canopy
    frond_rand = random.Random(31)
    for _ in range(7):
        fx = cx + frond_rand.randint(-6, 6)
        fy0 = canopy_cy + frond_rand.randint(-2, 4)
        drop = frond_rand.randint(4, 10)
        shade = frond_rand.choice([(52, 118, 66), (70, 142, 82)])
        d.line([(fx, fy0), (fx + frond_rand.randint(-1, 1), fy0 + drop)], fill=(*shade, 255))
    return img

TREE_BUILDERS = [make_tree_round, make_tree_pine, make_tree_autumn, make_tree_willow]
trees_sheet = Image.new("RGBA", (TREE_W * len(TREE_BUILDERS), TREE_H), (0, 0, 0, 0))
for i, builder in enumerate(TREE_BUILDERS):
    trees_sheet.paste(builder(), (i * TREE_W, 0))
trees_path = os.path.join(OUT_DIR, "trees.png")
trees_sheet.save(trees_path)
print("wrote", trees_path, "variants:", len(TREE_BUILDERS), "cell size:", (TREE_W, TREE_H))

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

    # Facial detail: brows, nose, and a mouth line, on top of the base eye
    # dots -- kept to a couple of extra pixels each so it still reads
    # clearly at this tiny resolution instead of turning to mud.
    brow = blend(hair, (0, 0, 0), 0.2) if hair else blend(skin, (0, 0, 0), 0.45)
    nose_shade = blend(skin, (0, 0, 0), 0.22)
    mouth_color = blend(skin, (150, 60, 50), 0.55)

    eye_y = head_cy + bob
    if direction == "down":
        d.point((cx - 2, eye_y - 1), fill=(*brow, 255))
        d.point((cx + 2, eye_y - 1), fill=(*brow, 255))
        d.point((cx - 2, eye_y), fill=(30, 30, 30, 255))
        d.point((cx + 2, eye_y), fill=(30, 30, 30, 255))
        d.point((cx, eye_y + 1), fill=(*nose_shade, 255))
        d.line([(cx - 1, eye_y + 2), (cx + 1, eye_y + 2)], fill=(*mouth_color, 255))
    elif direction == "left":
        d.point((cx - 2, eye_y - 1), fill=(*brow, 255))
        d.point((cx - head_r, eye_y + 1), fill=(*nose_shade, 255))  # tiny nose bump on the profile
        d.line([(cx - 2, eye_y + 2), (cx - 1, eye_y + 2)], fill=(*mouth_color, 255))
        d.point((cx - 2, eye_y), fill=(30, 30, 30, 255))
    elif direction == "right":
        d.point((cx + 2, eye_y - 1), fill=(*brow, 255))
        d.point((cx + head_r, eye_y + 1), fill=(*nose_shade, 255))
        d.line([(cx + 1, eye_y + 2), (cx + 2, eye_y + 2)], fill=(*mouth_color, 255))
        d.point((cx + 2, eye_y), fill=(30, 30, 30, 255))
    # "up" (back of head): no face drawn

    return img

def make_race_spritesheet(race, armor_color_name):
    sheet = Image.new("RGBA", (CHAR_NATIVE_W * FRAMES, CHAR_NATIVE_H * len(DIRS)), (0, 0, 0, 0))
    for row, direction in enumerate(DIRS):
        for frame in range(FRAMES):
            spr = draw_race_frame(race, armor_color_name, frame, direction)
            silhouette_shade(spr)
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

# ---- Flaming sword sprite (same footprint/pivot as sword.png so it drops
# into the existing swing-rotation rendering path unchanged) --------------

def make_flaming_sword():
    img = Image.new("RGBA", (SWORD_W, SWORD_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 3, 3, 5], fill=(90, 60, 30, 255))        # grip
    d.rectangle([3, 1, 4, 7], fill=(220, 160, 40, 255))       # cross-guard (golden)
    d.polygon([(4, 4), (22, 3), (23, 4), (22, 5)], fill=(255, 140, 40, 255))   # blade (orange-hot)
    d.line([(4, 4), (22, 4)], fill=(255, 230, 140, 255))      # blade centerline (white-hot)
    d.line([(4, 3), (20, 3)], fill=(230, 90, 20, 255))        # blade top edge shade
    return img

flaming_sword_img = make_flaming_sword()
flaming_sword_path = os.path.join(OUT_DIR, "flaming_sword.png")
flaming_sword_img.save(flaming_sword_path)
print("wrote", flaming_sword_path, "size:", flaming_sword_img.size, "-- pivot (hilt center) at (2,4)")

# ---- Barrel sprite (tavern decor / dropped ground-item backdrop) --------

BARREL_SIZE = 16

def make_barrel():
    img = Image.new("RGBA", (BARREL_SIZE, BARREL_SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    drop_shadow_ellipse(Image.new("RGBA", (BARREL_SIZE, BARREL_SIZE), (0, 0, 0, 0)), 8, 14, 6, 2, alpha=0)
    d.ellipse([3, 13, 12, 15], fill=(30, 20, 10, 160))  # faint ground contact shadow
    d.rounded_rectangle([2, 2, 13, 13], radius=3, fill=(120, 78, 40, 255), outline=(70, 44, 20, 255))
    for band_y in (3, 7, 11):
        d.rectangle([2, band_y, 13, band_y + 1], fill=(60, 42, 24, 255))
    d.line([(5, 3), (5, 12)], fill=(150, 104, 56, 255))  # highlight stave
    d.line([(10, 3), (10, 12)], fill=(90, 58, 28, 255))   # shade stave
    return img

barrel_img = make_barrel()
barrel_path = os.path.join(OUT_DIR, "barrel.png")
barrel_img.save(barrel_path)
print("wrote", barrel_path, "size:", barrel_img.size)

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
            silhouette_shade(spr, light_frac=0.16, dark_frac=0.28)
            sheet.paste(spr, (frame * MONSTER_CW, row * MONSTER_CH))
    path = os.path.join(OUT_DIR, f"monster_{mtype}.png")
    sheet.save(path)
    print("wrote", path, "size:", sheet.size)

# ---- The dragon boss --------------------------------------------------
# A big (4x3 tile footprint) guardian, kept in the same flat top-down
# "chibi" visual language as the rest of the game (big round body, small
# attached head with directional eye/snout placement) rather than a
# realistic side-profile creature, so it reads as part of the same world.
# Three sheets, each 4-dir x 2-frame: walking, a claw swipe, and a fire
# breath -- the client swaps sheets based on which attack the server says
# landed.

DRAGON_CW, DRAGON_CH = 88, 68
DRAGON_FRAMES = 2

def _dragon_base(d, cx, base_y, bob, wing_spread, tail_dir):
    """Shared body/wings/tail/legs, drawn before the direction-specific head."""
    dark = (110, 18, 18)
    body = (176, 40, 34)
    body_light = (218, 82, 56)
    belly = (232, 194, 116)
    wing_c = (96, 22, 26)
    wing_edge = (140, 40, 38)
    leg_c = (70, 16, 16)
    claw_c = (36, 32, 30)

    torso_cy = base_y - 26 + bob

    # tail, curling out opposite the facing direction
    tx0, ty0 = cx - tail_dir * 18, torso_cy + 10
    tx1, ty1 = cx - tail_dir * 30, torso_cy + 2
    d.line([(cx - tail_dir * 6, torso_cy + 14), (tx0, ty0)], fill=(*dark, 255), width=6)
    d.line([(tx0, ty0), (tx1, ty1)], fill=(*dark, 255), width=4)
    d.polygon([(tx1, ty1), (tx1 - tail_dir * 6, ty1 - 4), (tx1 - tail_dir * 2, ty1 + 5)], fill=(*dark, 255))

    # wings (behind the body), angle widens for the "spread" flap frame
    for side in (-1, 1):
        base_x = cx + side * 14
        tip_x = cx + side * (30 + wing_spread * 10)
        d.polygon([
            (base_x, torso_cy - 6),
            (tip_x, torso_cy - 20 - wing_spread * 6),
            (base_x + side * 10, torso_cy + 6),
        ], fill=(*wing_c, 255))
        d.line([(base_x, torso_cy - 6), (tip_x, torso_cy - 20 - wing_spread * 6)], fill=(*wing_edge, 255), width=2)

    # 4 stubby legs
    leg_off = 3 if wing_spread else 0
    for side in (-1, 1):
        for depth, dy in ((-1, -6), (1, 8)):
            lx = cx + side * (16 + (3 if depth < 0 else 0))
            ly = base_y - 4 + (leg_off if (side * depth) > 0 else -leg_off) // 2
            d.ellipse([lx - 5, ly - 5, lx + 5, ly + 6], fill=(*leg_c, 255))
            d.polygon([(lx - 4, ly + 5), (lx - 6, ly + 9), (lx - 2, ly + 6)], fill=(*claw_c, 255))
            d.polygon([(lx + 1, ly + 6), (lx + 1, ly + 10), (lx + 4, ly + 6)], fill=(*claw_c, 255))

    # torso
    d.ellipse([cx - 22, torso_cy - 18, cx + 22, torso_cy + 16], fill=(*dark, 255))
    d.ellipse([cx - 19, torso_cy - 16, cx + 19, torso_cy + 12], fill=(*body, 255))
    d.ellipse([cx - 10, torso_cy - 6, cx + 10, torso_cy + 12], fill=(*belly, 255))
    d.ellipse([cx - 14, torso_cy - 14, cx - 2, torso_cy - 2], fill=(*body_light, 255))  # highlight
    # back spines
    spine = random.Random(5)
    for i in range(5):
        sx = cx - 12 + i * 6
        sy = torso_cy - 16 - abs(2 - i)
        d.polygon([(sx - 2, torso_cy - 14), (sx, sy), (sx + 2, torso_cy - 14)], fill=(*dark, 255))

    return torso_cy

def _dragon_head(d, cx, torso_cy, bob, direction, mouth_open, mouth_flame):
    dark = (110, 18, 18)
    body = (176, 40, 34)
    horn_c = (58, 50, 46)
    horn_light = (88, 78, 70)
    eye_glow = (255, 214, 60)
    teeth = (245, 240, 220)

    if direction == "down":
        hx, hy = cx, torso_cy + 20
    elif direction == "up":
        hx, hy = cx, torso_cy - 22
    elif direction == "left":
        hx, hy = cx - 20, torso_cy - 2
    else:
        hx, hy = cx + 20, torso_cy - 2

    d.ellipse([hx - 11, hy - 10, hx + 11, hy + 10], fill=(*body, 255))
    d.ellipse([hx - 8, hy - 8, hx + 8, hy + 6], fill=(*dark, 255))

    # horns
    for side in (-1, 1):
        bx = hx + side * 7
        d.polygon([(bx, hy - 7), (bx + side * 6, hy - 18), (bx + side * 2, hy - 6)], fill=(*horn_c, 255))
        d.line([(bx + side * 1, hy - 8), (bx + side * 5, hy - 17)], fill=(*horn_light, 255), width=1)

    if direction == "up":
        return  # back of the head -- no face

    # snout, offset toward the facing direction
    if direction == "down":
        sx, sy = hx, hy + 9
        d.ellipse([sx - 6, sy - 4, sx + 6, sy + 5], fill=(*body, 255))
        d.point((hx - 4, hy - 1), fill=(*eye_glow, 255))
        d.point((hx + 4, hy - 1), fill=(*eye_glow, 255))
        mx0, mx1, my = sx - 5, sx + 5, sy + 3
    elif direction == "left":
        sx, sy = hx - 9, hy + 2
        d.ellipse([sx - 5, sy - 4, sx + 5, sy + 5], fill=(*body, 255))
        d.point((hx - 3, hy - 2), fill=(*eye_glow, 255))
        mx0, mx1, my = sx - 5, sx + 3, sy + 3
    else:
        sx, sy = hx + 9, hy + 2
        d.ellipse([sx - 5, sy - 4, sx + 5, sy + 5], fill=(*body, 255))
        d.point((hx + 3, hy - 2), fill=(*eye_glow, 255))
        mx0, mx1, my = sx - 3, sx + 5, sy + 3

    if mouth_open:
        d.line([(mx0, my), (mx1, my)], fill=(30, 8, 8, 255), width=2)
        d.point((mx0 + 1, my - 1), fill=(*teeth, 255))
        d.point((mx1 - 1, my - 1), fill=(*teeth, 255))
    else:
        d.line([(mx0, my), (mx1, my)], fill=(60, 14, 12, 255), width=1)

def make_dragon_walk_frame(direction, frame):
    img = Image.new("RGBA", (DRAGON_CW, DRAGON_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, base_y = DRAGON_CW // 2, DRAGON_CH - 3
    bob = 0 if frame == 1 else 2
    tail_dir = {"down": 0, "up": 0, "left": 1, "right": -1}[direction] or 1
    torso_cy = _dragon_base(d, cx, base_y, bob, wing_spread=frame, tail_dir=tail_dir)
    _dragon_head(d, cx, torso_cy, bob, direction, mouth_open=False, mouth_flame=False)
    silhouette_shade(img, light_frac=0.1, dark_frac=0.2)
    return img

def make_dragon_claw_frame(direction, frame):
    """frame 0 = windup (claw drawn back), frame 1 = strike (claw extended
    forward with slash marks)."""
    img = Image.new("RGBA", (DRAGON_CW, DRAGON_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, base_y = DRAGON_CW // 2, DRAGON_CH - 3
    tail_dir = {"down": 0, "up": 0, "left": 1, "right": -1}[direction] or 1
    torso_cy = _dragon_base(d, cx, base_y, bob=0, wing_spread=1, tail_dir=tail_dir)
    _dragon_head(d, cx, torso_cy, 0, direction, mouth_open=True, mouth_flame=False)

    claw_c = (70, 16, 16)
    talon = (36, 32, 30)
    slash = (255, 244, 210)
    fx = {"down": (0, 1), "up": (0, -1), "left": (-1, 0), "right": (1, 0)}[direction]
    reach = 6 if frame == 0 else 30
    ax = cx + fx[0] * (14 + reach)
    ay = torso_cy + fx[1] * (14 + reach) + 6
    d.ellipse([ax - 8, ay - 8, ax + 8, ay + 8], fill=(*claw_c, 255))
    for i in range(3):
        tx = ax + fx[0] * 8 + (i - 1) * 5 * (1 if fx[0] == 0 else 0)
        ty = ay + fx[1] * 8 + (i - 1) * 5 * (1 if fx[1] == 0 else 0)
        d.polygon([(ax + (i - 1) * 4, ay), (tx, ty), (ax + (i - 1) * 4 + 2, ay)], fill=(*talon, 255))
    if frame == 1:
        for i in range(3):
            ox, oy = i * 4 - 4, i * 3 - 3
            d.line([(ax - fx[0] * 14 + ox, ay - fx[1] * 14 + oy),
                    (ax + fx[0] * 6 + ox, ay + fx[1] * 6 + oy)], fill=(*slash, 220), width=2)
    silhouette_shade(img, light_frac=0.1, dark_frac=0.2)
    return img

def make_dragon_fire_frame(direction, frame):
    """frame 0 = small burst, frame 1 = full flame cone, for a pulsing
    breath animation."""
    img = Image.new("RGBA", (DRAGON_CW, DRAGON_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, base_y = DRAGON_CW // 2, DRAGON_CH - 3
    tail_dir = {"down": 0, "up": 0, "left": 1, "right": -1}[direction] or 1
    torso_cy = _dragon_base(d, cx, base_y, bob=0, wing_spread=1, tail_dir=tail_dir)
    _dragon_head(d, cx, torso_cy, 0, direction, mouth_open=True, mouth_flame=True)

    fx = {"down": (0, 1), "up": (0, -1), "left": (-1, 0), "right": (1, 0)}[direction]
    hx = cx + fx[0] * 26
    hy = torso_cy + 20 + 6 if direction == "down" else torso_cy + fx[1] * 20 + 6
    length = 16 if frame == 0 else 34
    width0 = 6 if frame == 0 else 9
    tip_x = hx + fx[0] * length
    tip_y = hy + fx[1] * length
    perp = (-fx[1], fx[0])
    colors = [((255, 224, 100), 1.0), ((255, 150, 40), 0.75), ((214, 40, 20), 0.5)]
    for color, frac in colors:
        w = width0 * frac
        l = length * frac
        tx, ty = hx + fx[0] * l, hy + fx[1] * l
        d.polygon([
            (hx + perp[0] * w * 0.4, hy + perp[1] * w * 0.4),
            (hx - perp[0] * w * 0.4, hy - perp[1] * w * 0.4),
            (tx, ty),
        ], fill=(*color, 255))
    return img

def assemble_dragon_sheet(builder, filename):
    sheet = Image.new("RGBA", (DRAGON_CW * DRAGON_FRAMES, DRAGON_CH * len(DIRS)), (0, 0, 0, 0))
    for row, direction in enumerate(DIRS):
        for frame in range(DRAGON_FRAMES):
            spr = builder(direction, frame)
            sheet.paste(spr, (frame * DRAGON_CW, row * DRAGON_CH))
    path = os.path.join(OUT_DIR, filename)
    sheet.save(path)
    print("wrote", path, "size:", sheet.size)

assemble_dragon_sheet(make_dragon_walk_frame, "dragon_walk.png")
assemble_dragon_sheet(make_dragon_claw_frame, "dragon_claw.png")
assemble_dragon_sheet(make_dragon_fire_frame, "dragon_fire.png")
print("DRAGON CELL SIZE:", DRAGON_CW, DRAGON_CH)

# ---------------------------------------------------------------------------
# Tavern furniture -- drawn as decor sprites (position + image), the same
# pattern already used for barrels, rather than baked into the tile grid.
# That lets the layout copy the uploaded reference photo's arrangement
# (table/fireplace/bar positions) freely without needing new tile ids.
# ---------------------------------------------------------------------------

def make_stool():
    img = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([1, 7, 8, 9], fill=(20, 14, 8, 130))
    d.ellipse([1, 1, 8, 8], fill=(96, 64, 34, 255), outline=(60, 40, 20, 255))
    d.ellipse([2, 2, 6, 5], fill=(124, 86, 48, 255))
    return img

make_stool().save(os.path.join(OUT_DIR, "stool.png"))
print("wrote", os.path.join(OUT_DIR, "stool.png"))


def make_table(shape):
    w, h = (30, 22) if shape == "rect" else (26, 24)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if shape == "rect":
        d.ellipse([2, h - 6, w - 2, h - 1], fill=(20, 14, 8, 100))
        d.rounded_rectangle([1, 2, w - 2, h - 6], radius=3, fill=(132, 92, 50, 255), outline=(74, 50, 26, 255))
        for i in range(4):
            x = 4 + i * (w - 8) / 3
            d.line([(x, 4), (x, h - 8)], fill=(150, 108, 62, 200))
        d.line([(2, 3), (w - 3, 3)], fill=(168, 124, 72, 200))
        mug_positions = [(6, h - 11), (w - 10, h - 14)]
        cx, cy = w // 2, h - 12
    else:
        d.ellipse([2, h - 6, w - 2, h - 1], fill=(20, 14, 8, 100))
        d.ellipse([1, 1, w - 1, h - 5], fill=(132, 92, 50, 255), outline=(74, 50, 26, 255))
        d.ellipse([5, 4, w - 5, h - 10], outline=(150, 108, 62, 180))
        mug_positions = [(w // 2 - 9, h // 2 - 3), (w // 2 + 4, h // 2 - 5)]
        cx, cy = w // 2, h // 2 - 8

    for (mx, my) in mug_positions:
        d.rectangle([mx, my, mx + 3, my + 4], fill=(202, 202, 212, 255), outline=(122, 122, 132, 255))
        d.point((mx + 1, my + 1), fill=(230, 230, 238, 255))
    # Candle sits at (cx, cy); the client uses this as the flicker-glow
    # anchor (same trick as the flaming sword / tavern lights elsewhere).
    d.rectangle([cx - 1, cy - 2, cx + 1, cy + 3], fill=(232, 222, 192, 255))
    d.ellipse([cx - 1, cy - 5, cx + 1, cy - 2], fill=(255, 200, 80, 255))
    d.ellipse([cx, cy - 4, cx, cy - 3], fill=(255, 240, 200, 255))
    return img, (cx, cy - 3)

_table_rect_img, TABLE_RECT_FLAME = make_table("rect")
_table_round_img, TABLE_ROUND_FLAME = make_table("round")
_table_rect_img.save(os.path.join(OUT_DIR, "table_rect.png"))
_table_round_img.save(os.path.join(OUT_DIR, "table_round.png"))
print("table flame offsets (from sprite center): rect", TABLE_RECT_FLAME, "round", TABLE_ROUND_FLAME,
      "sizes:", _table_rect_img.size, _table_round_img.size)


def make_fireplace():
    w, h = 30, 36
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 4, w - 1, h - 1], radius=4, fill=(92, 92, 98, 255), outline=(50, 50, 56, 255))
    d.rounded_rectangle([4, h - 20, w - 5, h - 2], radius=3, fill=(28, 18, 14, 255))
    d.rectangle([8, h - 8, w - 10, h - 6], fill=(70, 44, 24, 255))
    d.rectangle([9, h - 11, w - 11, h - 9], fill=(86, 54, 30, 255))
    fx, fy = w // 2, h - 10
    for (color, size) in [((255, 224, 100), 10), ((255, 150, 40), 7), ((214, 40, 20), 4)]:
        d.polygon([(fx - size * 0.5, fy), (fx + size * 0.5, fy), (fx, fy - size * 1.4)], fill=(*color, 255))
    for y in range(0, 4):
        for x in range(w):
            px = img.load()
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (*blend((r, g, b), (150, 118, 80), 0.35), 255)
    return img, (fx, fy - 6)

_fireplace_img, FIREPLACE_FLAME = make_fireplace()
_fireplace_img.save(os.path.join(OUT_DIR, "fireplace.png"))
print("fireplace flame offset:", FIREPLACE_FLAME, "size:", _fireplace_img.size)


def make_bar_unit():
    # One repeatable counter+shelf segment; the client tiles this across
    # the counter's tile-span so any room width works without new art.
    w, h = TILE, 30
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w - 1, 9], fill=(72, 50, 30, 255))
    d.rectangle([0, 9, w - 1, 10], fill=(40, 26, 14, 255))
    bottle_colors = [(60, 110, 70), (120, 40, 40), (150, 130, 40), (40, 70, 110)]
    rnd = random.Random(55)
    for i in range(3):
        bx = 2 + i * 5
        bc = rnd.choice(bottle_colors)
        d.rectangle([bx, 2, bx + 2, 7], fill=(*bc, 255))
    d.rounded_rectangle([0, 15, w - 1, h - 1], radius=2, fill=(142, 100, 56, 255), outline=(80, 54, 28, 255))
    d.line([(0, 17), (w - 1, 17)], fill=(170, 124, 72, 255))
    return img

make_bar_unit().save(os.path.join(OUT_DIR, "bar_unit.png"))
print("wrote", os.path.join(OUT_DIR, "bar_unit.png"))


def make_sign():
    w, h = 84, 30
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=3, fill=(96, 66, 36, 255), outline=(48, 32, 16, 255))
    d.rounded_rectangle([2, 2, w - 3, h - 3], radius=2, outline=(160, 120, 66, 255))
    line1, line2 = "Welcome to", "Dirtywood"
    tw1 = d.textlength(line1)
    tw2 = d.textlength(line2)
    d.text(((w - tw1) / 2, 5), line1, fill=(255, 226, 156, 255))
    d.text(((w - tw2) / 2, 16), line2, fill=(255, 226, 156, 255))
    return img

make_sign().save(os.path.join(OUT_DIR, "sign_dirtywood.png"))
print("wrote", os.path.join(OUT_DIR, "sign_dirtywood.png"))


def make_booze_sign():
    # Same wood-board look as make_sign, just a wider board (three lines of
    # text) and a warning-red border instead of the welcome sign's warm tan,
    # so it reads as a "back off" notice rather than a friendly greeting --
    # posted next to the booze barrels on the cliff (see server/cliff.js).
    w, h = 96, 40
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=3, fill=(80, 30, 26, 255), outline=(40, 14, 12, 255))
    d.rounded_rectangle([2, 2, w - 3, h - 3], radius=2, outline=(200, 90, 70, 255))
    lines = ["Goblin Booze,", "do not touch!"]
    y = 8
    for line in lines:
        tw = d.textlength(line)
        d.text(((w - tw) / 2, y), line, fill=(255, 214, 156, 255))
        y += 12
    return img


make_booze_sign().save(os.path.join(OUT_DIR, "sign_booze.png"))
print("wrote", os.path.join(OUT_DIR, "sign_booze.png"))

# ---------------------------------------------------------------------------
# Cave treasure -- purely decorative gold/gem piles scattered around the
# cave floor; only the flaming sword / bow items are ever actually pickable.
# ---------------------------------------------------------------------------

def make_treasure_pile(variant):
    w, h = 18, 14
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rnd = random.Random(700 + variant)
    d.ellipse([1, h - 5, w - 1, h - 1], fill=(20, 16, 6, 120))
    for _ in range(12):
        cx = rnd.randint(2, w - 3)
        cy = rnd.randint(h - 10, h - 3)
        r = rnd.randint(1, 2)
        shade = rnd.choice([(255, 215, 90), (230, 180, 60), (255, 235, 140), (200, 150, 40)])
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*shade, 255), outline=(120, 84, 16, 255))
    if variant == 1:
        d.polygon([(w // 2 - 2, 1), (w // 2 + 2, 1), (w // 2 + 3, 4), (w // 2, 7), (w // 2 - 3, 4)],
                   fill=(130, 70, 230, 255))
    elif variant == 2:
        d.rectangle([w // 2 - 2, 1, w // 2 + 2, 6], fill=(210, 210, 220, 255), outline=(140, 140, 150, 255))
    return img

for _i in range(3):
    make_treasure_pile(_i).save(os.path.join(OUT_DIR, f"treasure_{_i}.png"))
print("wrote treasure_0/1/2.png")

# ---------------------------------------------------------------------------
# Golden bow + arrow (second weapon pickup)
# ---------------------------------------------------------------------------

BOW_W, BOW_H = 20, 24

def make_bow():
    img = Image.new("RGBA", (BOW_W, BOW_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.arc([2, 0, BOW_W - 6, BOW_H - 1], start=245, end=115, fill=(232, 184, 64, 255), width=2)
    d.arc([3, 1, BOW_W - 7, BOW_H - 2], start=245, end=115, fill=(255, 224, 140, 255), width=1)
    d.line([(BOW_W - 6, 1), (BOW_W - 6, BOW_H - 2)], fill=(235, 235, 226, 255), width=1)
    return img

make_bow().save(os.path.join(OUT_DIR, "bow_gold.png"))
print("wrote", os.path.join(OUT_DIR, "bow_gold.png"), "-- pivot (grip center) at", (BOW_W // 2, BOW_H // 2))

ARROW_W, ARROW_H = 16, 6

def make_arrow():
    img = Image.new("RGBA", (ARROW_W, ARROW_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.line([(1, 3), (12, 3)], fill=(142, 100, 58, 255), width=2)
    d.polygon([(11, 0), (ARROW_W - 1, 3), (11, 6)], fill=(206, 206, 216, 255))
    d.polygon([(0, 1), (4, 3), (0, 5)], fill=(224, 224, 226, 255))
    return img

make_arrow().save(os.path.join(OUT_DIR, "arrow.png"))
print("wrote", os.path.join(OUT_DIR, "arrow.png"), "-- points right by default, pivot at center")

# ---------------------------------------------------------------------------
# ---- Side-scroller "cavern depths" level art -------------------------------
# A whole second art style for the new Metroid-style side-view level behind
# the dragon's cave: a profile-view player sheet per login color (idle/walk/
# jump/crouch/sword/bow), goblin + troll enemies, a platform ledge tile, a
# dark cave-depths background tile, and a door sprite for both ends of the
# transition. Everything is drawn facing right; the client mirrors
# horizontally (ctx.scale(-1,1)) for left-facing instead of drawing a
# second copy, same trick used for a lot of 2D platformers.
# ---------------------------------------------------------------------------

CAVERN_CW, CAVERN_CH = 24, 30
CAVERN_ACTIONS = ["idle", "walk", "jump", "crouch", "sword", "bow"]
CAVERN_FRAME_COUNTS = {"idle": 1, "walk": 2, "jump": 1, "crouch": 1, "sword": 2, "bow": 2}
CAVERN_MAX_FRAMES = max(CAVERN_FRAME_COUNTS.values())

def draw_cavern_frame(race, color_name, action, frame):
    """One CAVERN_CW x CAVERN_CH profile-view frame, feet anchored to the
    bottom of the canvas, facing right. Uses the same RACE_PROFILES
    (skin/hair/proportions) as the outside-world top-down sprite so a
    player's selected race+color carries over into the cavern instead of
    everyone looking like a generic human there."""
    prof = RACE_PROFILES[race]
    color = COLOR_RGB.get(color_name, DEFAULT_ARMOR)
    color_light = blend(color, (255, 255, 255), 0.25)
    color_dark = blend(color, (0, 0, 0), 0.25)
    skin = prof["skin"]
    hair = prof["hair"]
    leg_color = (44, 40, 52)
    leg_light = blend(leg_color, (255, 255, 255), 0.2)

    img = Image.new("RGBA", (CAVERN_CW, CAVERN_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = CAVERN_CW // 2 - 2  # body sits slightly left so a forward arm/weapon has room on the right
    feet_y = CAVERN_CH - 2

    crouch = action == "crouch"
    jumping = action == "jump"
    # Base proportions scaled from the race's top-down profile so the same
    # race reads as taller/shorter/stockier here too (goblin short & slight,
    # orc stocky, elf tall & slim) rather than one fixed human build.
    torso_h = (prof["torso_h"] + 2) - (3 if crouch else 0)
    torso_w = prof["torso_w"] + 2
    leg_h = (prof["leg_h"] + 1) - (4 if crouch else 0)
    head_r = prof["head_r"] + 1

    torso_bottom = feet_y - leg_h
    torso_top = torso_bottom - torso_h
    head_cy = torso_top - head_r
    head_top = head_cy - head_r

    # legs
    if jumping:
        # Both knees tucked up mid-air -- deliberately SHORTER than the
        # standing silhouette (feet don't reach feet_y at all) rather than
        # just redrawing the same standing leg span in two pieces, so the
        # pose visibly compacts/lifts instead of reading identical to idle
        # at small on-screen scale (the previous version had this bug: same
        # total leg length, just split into a "thigh" + "shin" rectangle).
        tuck_h = max(3, round(leg_h * 0.5))
        d.rectangle([cx - torso_w + 1, torso_bottom + 1, cx - 1, torso_bottom + tuck_h], fill=(*leg_color, 255))
        d.rectangle([cx + 1, torso_bottom + 1, cx + torso_w - 1, torso_bottom + tuck_h], fill=(*leg_color, 255))
    elif action == "walk":
        stride = 3 if frame == 0 else -3
        back_x = cx - 1 - (stride if stride > 0 else 0)
        fwd_x = cx + 1 + (abs(stride) if stride < 0 else stride)
        d.rectangle([back_x - 1, torso_bottom + 1, back_x + 1, feet_y - (2 if stride > 0 else 0)], fill=(*leg_color, 255))
        d.rectangle([fwd_x - 1, torso_bottom + 1, fwd_x + 1, feet_y - (2 if stride < 0 else 0)], fill=(*leg_color, 255))
    else:
        d.rectangle([cx - torso_w + 1, torso_bottom + 1, cx - 1, feet_y], fill=(*leg_color, 255))
        d.rectangle([cx + 1, torso_bottom + 1, cx + torso_w - 1, feet_y], fill=(*leg_color, 255))
    d.line([(cx - torso_w + 1, torso_bottom + 1), (cx - torso_w + 1, feet_y)], fill=(*leg_light, 255))

    # torso
    d.rectangle([cx - torso_w, torso_top, cx + torso_w - 1, torso_bottom], fill=(*color, 255))
    d.line([(cx - torso_w, torso_top), (cx - torso_w, torso_bottom)], fill=(*color_light, 255))
    d.line([(cx + torso_w - 1, torso_top), (cx + torso_w - 1, torso_bottom)], fill=(*color_dark, 255))
    d.line([(cx - torso_w, torso_bottom), (cx + torso_w - 1, torso_bottom)], fill=(60, 44, 26, 255))

    # back arm (mostly hidden behind torso -- just a sliver so the silhouette
    # doesn't read as one-armed from the side)
    d.rectangle([cx - torso_w - 1, torso_top + 2, cx - torso_w, torso_bottom - 1], fill=(*skin, 255))

    # head + simple side-swept hair -- race-distinguishing ear/tusk detail
    # mirrors draw_race_frame's top-down version, just adapted to profile.
    d.ellipse([cx - head_r, head_top, cx + head_r + 2, head_top + head_r * 2], fill=(*skin, 255))
    if hair:
        d.pieslice([cx - head_r, head_top - 1, cx + head_r + 2, head_top + head_r], start=180, end=360, fill=(*hair, 255))
    ear = prof["ear"]
    ear_y = head_cy
    if ear == "pointed":
        d.polygon([(cx - head_r - 2, ear_y), (cx - head_r, ear_y - 3), (cx - head_r, ear_y + 1)], fill=(*skin, 255))
    elif ear == "big":
        d.ellipse([cx - head_r - 3, ear_y - 3, cx - head_r + 1, ear_y + 3], fill=(*skin, 255))
    if prof["tusks"]:
        d.point((cx + head_r, head_top + head_r * 2 - 1), fill=(235, 230, 210, 255))
    d.point((cx + head_r - 1, head_top + head_r), fill=(30, 30, 30, 255))  # eye, facing right

    # forward arm + weapon/pose, drawn last so it sits over the torso
    shoulder_x, shoulder_y = cx + torso_w - 2, torso_top + 2
    if action == "sword":
        if frame == 0:  # windup: blade drawn back and up
            d.line([(shoulder_x, shoulder_y), (shoulder_x - 3, shoulder_y - 4)], fill=(*skin, 255), width=2)
            d.line([(shoulder_x - 3, shoulder_y - 4), (shoulder_x - 9, shoulder_y - 8)], fill=(210, 214, 222, 255), width=2)
        else:  # strike: blade swung forward, low and extended
            d.line([(shoulder_x, shoulder_y), (shoulder_x + 5, shoulder_y + 2)], fill=(*skin, 255), width=2)
            d.line([(shoulder_x + 5, shoulder_y + 2), (shoulder_x + 15, shoulder_y + 5)], fill=(230, 234, 240, 255), width=2)
    elif action == "bow":
        bx, by = shoulder_x + 4, torso_top + torso_h // 2
        d.arc([bx - 2, by - 6, bx + 4, by + 6], start=260, end=100, fill=(180, 130, 60, 255), width=2)
        pull = 5 if frame == 0 else 1  # frame 0 = drawn back, frame 1 = just released
        d.line([(shoulder_x, shoulder_y + 2), (bx - pull, by)], fill=(*skin, 255), width=2)
        d.line([(bx, by - 6), (bx - pull, by), (bx, by + 6)], fill=(235, 235, 226, 255), width=1)
    elif jumping:
        # Arm thrown up/back for momentum, distinct from the idle pose's
        # relaxed downward arm -- extra readability at small on-screen
        # scale, on top of the shortened tucked-leg silhouette above.
        d.line([(shoulder_x, shoulder_y), (shoulder_x + 3, shoulder_y - 5)], fill=(*skin, 255), width=2)
    else:
        d.line([(shoulder_x, shoulder_y), (shoulder_x + 1, shoulder_y + 5)], fill=(*skin, 255), width=2)

    silhouette_shade(img, light_frac=0.12, dark_frac=0.22)
    return img

def make_cavern_sheet(race, color_name):
    sheet = Image.new("RGBA", (CAVERN_CW * CAVERN_MAX_FRAMES, CAVERN_CH * len(CAVERN_ACTIONS)), (0, 0, 0, 0))
    for row, action in enumerate(CAVERN_ACTIONS):
        for frame in range(CAVERN_FRAME_COUNTS[action]):
            spr = draw_cavern_frame(race, color_name, action, frame)
            sheet.paste(spr, (frame * CAVERN_CW, row * CAVERN_CH), spr)
    return sheet

# One sheet per race+color combo (same cross product as the outside-world
# race_<race>_<color>.png sheets) so a player's selected character model
# carries over into the cavern/cliff instead of everyone looking like a
# generic human there.
for _race in RACES:
    for _color in COLOR_RGB:
        _sheet = make_cavern_sheet(_race, _color)
        _path = os.path.join(OUT_DIR, f"cavern_player_{_race}_{_color}.png")
        _sheet.save(_path)
    print("wrote cavern_player_<color>.png for race", _race, "x", len(COLOR_RGB), "colors")
print("CAVERN PLAYER SIZE:", CAVERN_CW * CAVERN_MAX_FRAMES, CAVERN_CH * len(CAVERN_ACTIONS))
print("CAVERN_ACTIONS order:", CAVERN_ACTIONS, "FRAME_COUNTS:", CAVERN_FRAME_COUNTS, "CELL SIZE:", CAVERN_CW, CAVERN_CH)

# ---- Goblin (melee) and troll (ranged) enemies, side view -----------------

CAVERN_ENEMY_CW, CAVERN_ENEMY_CH = 20, 24
CAVERN_ENEMY_ACTIONS = ["walk", "attack"]
CAVERN_ENEMY_FRAME_COUNTS = {"walk": 2, "attack": 2}

def draw_goblin_frame(action, frame, body=(74, 110, 58), belly=(140, 168, 96)):
    img = Image.new("RGBA", (CAVERN_ENEMY_CW, CAVERN_ENEMY_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, feet_y = CAVERN_ENEMY_CW // 2 - 1, CAVERN_ENEMY_CH - 2
    torso_h, torso_w, leg_h, head_r = 8, 4, 6, 4
    torso_bottom = feet_y - leg_h
    torso_top = torso_bottom - torso_h
    head_cy = torso_top - head_r

    stride = (2 if frame == 0 else -2) if action == "walk" else 0
    d.rectangle([cx - torso_w + 1 - stride // 2, torso_bottom + 1, cx - 1 - stride // 2, feet_y], fill=(58, 44, 34, 255))
    d.rectangle([cx + 1 + stride // 2, torso_bottom + 1, cx + torso_w - 1 + stride // 2, feet_y], fill=(58, 44, 34, 255))

    d.rectangle([cx - torso_w, torso_top, cx + torso_w - 1, torso_bottom], fill=(*body, 255))
    d.rectangle([cx - torso_w + 1, torso_top + 2, cx + torso_w - 3, torso_bottom - 1], fill=(*belly, 255))
    d.ellipse([cx - head_r, head_cy - head_r, cx + head_r + 1, head_cy + head_r], fill=(*body, 255))
    d.polygon([(cx - head_r - 2, head_cy - 1), (cx - head_r, head_cy - 3), (cx - head_r, head_cy + 1)], fill=(*body, 255))
    d.polygon([(cx + head_r + 3, head_cy - 1), (cx + head_r + 1, head_cy - 3), (cx + head_r + 1, head_cy + 1)], fill=(*body, 255))
    d.point((cx + head_r - 1, head_cy - 1), fill=(220, 30, 30, 255))

    shoulder_x, shoulder_y = cx + torso_w - 2, torso_top + 2
    if action == "attack" and frame == 1:
        d.line([(shoulder_x, shoulder_y), (shoulder_x + 6, shoulder_y + 4)], fill=(*belly, 255), width=2)
        d.line([(shoulder_x + 6, shoulder_y + 4), (shoulder_x + 14, shoulder_y + 7)], fill=(200, 204, 210, 255), width=2)
    elif action == "attack":
        d.line([(shoulder_x, shoulder_y), (shoulder_x - 2, shoulder_y - 5)], fill=(*belly, 255), width=2)
        d.line([(shoulder_x - 2, shoulder_y - 5), (shoulder_x - 7, shoulder_y - 9)], fill=(200, 204, 210, 255), width=2)
    else:
        d.line([(shoulder_x, shoulder_y), (shoulder_x + 1, shoulder_y + 5)], fill=(*belly, 255), width=2)
    silhouette_shade(img, light_frac=0.14, dark_frac=0.26)
    return img

def draw_troll_frame(action, frame):
    img = Image.new("RGBA", (CAVERN_ENEMY_CW, CAVERN_ENEMY_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    body, belly = (108, 100, 116), (150, 142, 158)
    cx, feet_y = CAVERN_ENEMY_CW // 2 - 1, CAVERN_ENEMY_CH - 1
    torso_h, torso_w, leg_h, head_r = 10, 5, 6, 4
    torso_bottom = feet_y - leg_h
    torso_top = torso_bottom - torso_h
    head_cy = torso_top - head_r

    stride = (2 if frame == 0 else -2) if action == "walk" else 0
    d.rectangle([cx - torso_w + 2 - stride // 2, torso_bottom + 1, cx - stride // 2, feet_y], fill=(70, 62, 50, 255))
    d.rectangle([cx + stride // 2, torso_bottom + 1, cx + torso_w - 2 + stride // 2, feet_y], fill=(70, 62, 50, 255))

    d.rectangle([cx - torso_w, torso_top, cx + torso_w - 1, torso_bottom], fill=(*body, 255))
    d.rectangle([cx - torso_w + 1, torso_top + 2, cx + torso_w - 3, torso_bottom - 1], fill=(*belly, 255))
    d.ellipse([cx - head_r, head_cy - head_r, cx + head_r + 1, head_cy + head_r], fill=(*body, 255))
    d.point((cx + head_r - 1, head_cy - 1), fill=(230, 200, 40, 255))

    shoulder_x, shoulder_y = cx + torso_w - 2, torso_top + 3
    if action == "attack":
        bx, by = shoulder_x + 4, torso_top + torso_h // 2
        d.arc([bx - 2, by - 7, bx + 5, by + 7], start=260, end=100, fill=(120, 84, 40, 255), width=2)
        pull = 6 if frame == 0 else 1
        d.line([(shoulder_x, shoulder_y), (bx - pull, by)], fill=(*belly, 255), width=2)
        d.line([(bx, by - 7), (bx - pull, by), (bx, by + 7)], fill=(230, 230, 220, 255), width=1)
    else:
        d.line([(shoulder_x, shoulder_y), (shoulder_x + 1, shoulder_y + 6)], fill=(*belly, 255), width=2)
    silhouette_shade(img, light_frac=0.12, dark_frac=0.24)
    return img

def make_enemy_sheet(draw_fn, *args):
    sheet = Image.new("RGBA", (CAVERN_ENEMY_CW * 2, CAVERN_ENEMY_CH * len(CAVERN_ENEMY_ACTIONS)), (0, 0, 0, 0))
    for row, action in enumerate(CAVERN_ENEMY_ACTIONS):
        for frame in range(CAVERN_ENEMY_FRAME_COUNTS[action]):
            spr = draw_fn(action, frame, *args)
            sheet.paste(spr, (frame * CAVERN_ENEMY_CW, row * CAVERN_ENEMY_CH), spr)
    return sheet

# Cavern goblins are "fire goblins" -- 3 randomly-assigned red shades (no
# plain-green variant anymore) instead of one fixed color, per the same
# draw_goblin_frame silhouette just recolored.
FIRE_GOBLIN_SHADES = [
    ((198, 64, 32), (230, 120, 60)),   # shade 1: bright orange-red
    ((168, 40, 28), (210, 90, 50)),    # shade 2: medium red
    ((120, 24, 20), (160, 60, 40)),    # shade 3: dark maroon-red
]
for _i, (_body, _belly) in enumerate(FIRE_GOBLIN_SHADES, start=1):
    make_enemy_sheet(draw_goblin_frame, _body, _belly).save(os.path.join(OUT_DIR, f"cavern_goblin_fire{_i}.png"))
make_enemy_sheet(draw_troll_frame).save(os.path.join(OUT_DIR, "cavern_troll.png"))
print("wrote cavern_goblin_fire1/2/3.png, cavern_troll.png size:", CAVERN_ENEMY_CW * 2, CAVERN_ENEMY_CH * len(CAVERN_ENEMY_ACTIONS))

# ---- Fire bat: small red glowing swoop-attack hazard -----------------------
# A distinct creature (not a reskinned goblin, unlike the troll above) --
# simple 2-frame wing-flap, drawn facing right, warm red/orange body with a
# brighter glow-core so it reads as "on fire" even at a tiny size.
BAT_CW, BAT_CH = 22, 16
BAT_FRAMES = 2

def draw_bat_frame(frame):
    img = Image.new("RGBA", (BAT_CW, BAT_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = BAT_CW // 2, BAT_CH // 2 + 1
    body = (200, 40, 30)
    glow = (255, 150, 60)
    core = (255, 220, 140)
    wing_up = frame == 0

    # wings -- simple angular triangles, flap between "up" and "down"
    wing_dy = -5 if wing_up else 3
    d.polygon([(cx - 2, cy - 1), (cx - 11, cy + wing_dy), (cx - 5, cy + 2)], fill=(*body, 230))
    d.polygon([(cx + 2, cy - 1), (cx + 11, cy + wing_dy), (cx + 5, cy + 2)], fill=(*body, 230))

    # body + glow core
    d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=(*glow, 255))
    d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=(*body, 255))
    d.ellipse([cx - 2, cy - 2, cx + 1, cy + 1], fill=(*core, 255))

    # tiny eyes
    d.point((cx - 1, cy - 1), fill=(255, 255, 200, 255))
    d.point((cx + 1, cy - 1), fill=(255, 255, 200, 255))

    silhouette_shade(img, light_frac=0.2, dark_frac=0.2)
    return img

def make_bat_sheet():
    sheet = Image.new("RGBA", (BAT_CW * BAT_FRAMES, BAT_CH), (0, 0, 0, 0))
    for frame in range(BAT_FRAMES):
        spr = draw_bat_frame(frame)
        sheet.paste(spr, (frame * BAT_CW, 0), spr)
    return sheet

make_bat_sheet().save(os.path.join(OUT_DIR, "cavern_fire_bat.png"))
print("wrote cavern_fire_bat.png size:", BAT_CW * BAT_FRAMES, BAT_CH, "cell size:", BAT_CW, BAT_CH)
print("CAVERN_ENEMY_ACTIONS order:", CAVERN_ENEMY_ACTIONS, "CELL SIZE:", CAVERN_ENEMY_CW, CAVERN_ENEMY_CH)

# ---- Platform ledge tile + cave-depths background tile + door -------------

CAVERN_PLATFORM_W, CAVERN_PLATFORM_H = 16, 10

def make_cavern_platform():
    img = Image.new("RGBA", (CAVERN_PLATFORM_W, CAVERN_PLATFORM_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    stone, stone_light, stone_dark = (94, 88, 96), (128, 120, 130), (58, 54, 60)
    d.rectangle([0, 0, CAVERN_PLATFORM_W - 1, CAVERN_PLATFORM_H - 1], fill=(*stone, 255))
    d.rectangle([0, 0, CAVERN_PLATFORM_W - 1, 2], fill=(*stone_light, 255))
    for x in range(0, CAVERN_PLATFORM_W, 4):
        d.line([(x, 3), (x, CAVERN_PLATFORM_H - 1)], fill=(*stone_dark, 180))
    d.rectangle([0, CAVERN_PLATFORM_H - 2, CAVERN_PLATFORM_W - 1, CAVERN_PLATFORM_H - 1], fill=(*stone_dark, 255))
    return img

make_cavern_platform().save(os.path.join(OUT_DIR, "cavern_platform.png"))
print("wrote cavern_platform.png")

CAVERN_BG_W = CAVERN_BG_H = TILE

def make_cavern_bg():
    img = new_tile(CAVERN_BG_W)
    d = ImageDraw.Draw(img)
    base = (26, 22, 30)
    d.rectangle([0, 0, CAVERN_BG_W - 1, CAVERN_BG_H - 1], fill=(*base, 255))
    speckle(img, base, variance=14, density=0.45)
    rng = random.Random(77)
    for _ in range(3):
        x = rng.randint(1, CAVERN_BG_W - 2)
        d.line([(x, 0), (x + rng.randint(-2, 2), rng.randint(3, 7))], fill=(14, 12, 16, 255))
    return img

make_cavern_bg().save(os.path.join(OUT_DIR, "cavern_bg.png"))
print("wrote cavern_bg.png")

# ---- Cave environment variety: wall torches, stalactites, crystal clusters -
# Scattered along the cavern by generateCavernLevel's deterministic decor
# list (server/cavern.js) -- purely decorative, drawn behind the gameplay
# layer, to break up what was a flat repeating dark-brick background.

TORCH_W, TORCH_H = 14, 26

def make_cavern_torch():
    img = Image.new("RGBA", (TORCH_W, TORCH_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bracket, wood = (60, 56, 62), (90, 62, 40)
    cx = TORCH_W // 2
    d.rectangle([cx - 1, 14, cx + 1, TORCH_H - 1], fill=(*wood, 255))
    d.rectangle([cx - 3, 12, cx + 3, 15], fill=(*bracket, 255))
    # flame -- layered warm ellipses, brightest at the core
    d.ellipse([cx - 5, 2, cx + 5, 16], fill=(214, 90, 30, 235))
    d.ellipse([cx - 3, 3, cx + 3, 13], fill=(240, 150, 40, 245))
    d.ellipse([cx - 2, 5, cx + 2, 11], fill=(255, 220, 120, 255))
    return img

make_cavern_torch().save(os.path.join(OUT_DIR, "cavern_torch.png"))
print("wrote cavern_torch.png")

STALACTITE_W, STALACTITE_H = 16, 30

def make_cavern_stalactite():
    img = Image.new("RGBA", (STALACTITE_W, STALACTITE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rock, rock_light = (52, 46, 56), (74, 66, 78)
    cx = STALACTITE_W // 2
    d.polygon([(2, 0), (STALACTITE_W - 2, 0), (cx + 2, STALACTITE_H - 4), (cx, STALACTITE_H - 1), (cx - 2, STALACTITE_H - 4)], fill=(*rock, 255))
    d.polygon([(3, 0), (cx, 0), (cx, STALACTITE_H - 3)], fill=(*rock_light, 140))
    return img

make_cavern_stalactite().save(os.path.join(OUT_DIR, "cavern_stalactite.png"))
print("wrote cavern_stalactite.png")

CRYSTAL_W, CRYSTAL_H = 20, 22

def make_cavern_crystal():
    img = Image.new("RGBA", (CRYSTAL_W, CRYSTAL_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    glow, mid, core = (70, 60, 150), (110, 130, 230), (190, 210, 255)
    shards = [
        (10, 0, 14, 12, 8, 22, 4, 12),
        (3, 6, 8, 18, 2, 20, 0, 10),
        (16, 8, 19, 18, 14, 20, 12, 12),
    ]
    for x1, y1, x2, y2, x3, y3, x4, y4 in shards:
        d.polygon([(x1, y1), (x2, y2), (x3, y3), (x4, y4)], fill=(*glow, 220))
    d.polygon([(9, 3), (12, 12), (9, 19), (6, 12)], fill=(*mid, 235))
    d.polygon([(9, 6), (11, 12), (9, 16), (7, 12)], fill=(*core, 255))
    return img

make_cavern_crystal().save(os.path.join(OUT_DIR, "cavern_crystal.png"))
print("wrote cavern_crystal.png")

CAVERN_DOOR_W, CAVERN_DOOR_H = 18, 26

def make_cavern_door():
    img = Image.new("RGBA", (CAVERN_DOOR_W, CAVERN_DOOR_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    frame_c, wood, wood_dark = (70, 62, 50), (96, 66, 40), (60, 40, 24)
    d.rectangle([0, 0, CAVERN_DOOR_W - 1, CAVERN_DOOR_H - 1], fill=(*frame_c, 255))
    d.rectangle([2, 2, CAVERN_DOOR_W - 3, CAVERN_DOOR_H - 1], fill=(*wood, 255))
    for x in (5, CAVERN_DOOR_W - 6):
        d.line([(x, 3), (x, CAVERN_DOOR_H - 2)], fill=(*wood_dark, 255))
    d.ellipse([CAVERN_DOOR_W - 7, CAVERN_DOOR_H // 2 - 1, CAVERN_DOOR_W - 5, CAVERN_DOOR_H // 2 + 1], fill=(210, 180, 90, 255))
    return img

make_cavern_door().save(os.path.join(OUT_DIR, "cavern_door.png"))
print("wrote cavern_door.png")

# ---- Giant goblin boss (end of the now-5x-longer cavern) ------------------
# ~8 character-heights tall (CAVERN_CH=30 -> 8x = 240px native), same
# fire-goblin silhouette family as the regular cave enemies but scaled way
# up, wielding a huge club. Poses: idle (subtle bob), windup (club raised
# overhead -- this is the frame the client shows while the slam target is
# telegraphed, so players get a fair chance to dodge), slam (club swinging
# down through a big arc to impact), shout (mouth wide open, roaring).

BOSS_CW, BOSS_CH = 176, 240
BOSS_ACTIONS = ["idle", "windup", "slam", "shout"]
BOSS_FRAME_COUNTS = {"idle": 2, "windup": 2, "slam": 2, "shout": 2}
BOSS_MAX_FRAMES = max(BOSS_FRAME_COUNTS.values())

def draw_boss_frame(action, frame):
    img = Image.new("RGBA", (BOSS_CW, BOSS_CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    body, belly = (150, 32, 24), (200, 90, 60)  # deep fire-red, same family as the cave fire goblins
    cx, feet_y = BOSS_CW // 2, BOSS_CH - 6
    torso_h, torso_w, leg_h, head_r = 70, 40, 46, 34
    torso_bottom = feet_y - leg_h
    torso_top = torso_bottom - torso_h
    head_cy = torso_top - head_r + 6

    bob = 4 if (action == "idle" and frame == 1) else 0

    d.rectangle([cx - torso_w + 6, torso_bottom + 1, cx - 6, feet_y - bob // 2], fill=(58, 44, 34, 255))
    d.rectangle([cx + 6, torso_bottom + 1, cx + torso_w - 6, feet_y - bob // 2], fill=(58, 44, 34, 255))

    d.rectangle([cx - torso_w, torso_top - bob, cx + torso_w - 1, torso_bottom - bob], fill=(*body, 255))
    d.rectangle([cx - torso_w + 6, torso_top + 10 - bob, cx + torso_w - 16, torso_bottom - 6 - bob], fill=(*belly, 255))

    d.ellipse([cx - head_r, head_cy - head_r - bob, cx + head_r, head_cy + head_r - bob], fill=(*body, 255))
    d.polygon([(cx - head_r - 10, head_cy - 4 - bob), (cx - head_r, head_cy - 14 - bob), (cx - head_r, head_cy + 6 - bob)], fill=(*body, 255))
    d.polygon([(cx + head_r + 10, head_cy - 4 - bob), (cx + head_r, head_cy - 14 - bob), (cx + head_r, head_cy + 6 - bob)], fill=(*body, 255))
    eye_color = (255, 220, 40, 255) if action in ("windup", "slam") else (230, 30, 30, 255)
    d.ellipse([cx + head_r - 16, head_cy - 6 - bob, cx + head_r - 6, head_cy + 2 - bob], fill=eye_color)

    if action == "shout":
        mw = 18 if frame == 0 else 26
        d.ellipse([cx - mw // 2, head_cy + head_r - 14, cx + mw // 2, head_cy + head_r + 10], fill=(30, 10, 10, 255))

    # off-arm (non-club side), just a small stub that bobs with idle
    d.line([(cx - torso_w + 4, torso_top + 12 - bob), (cx - torso_w - 8, torso_top + 30 - bob)], fill=(*belly, 255), width=10)

    # club-arm + club -- geometry depends on pose so the telegraph/impact read clearly
    shoulder_x, shoulder_y = cx + torso_w - 8, torso_top + 12 - bob
    club_head, club_shaft = (90, 78, 60), (70, 58, 44)
    if action == "idle":
        elbow, hand = (shoulder_x + 14, shoulder_y + 30), (shoulder_x + 10, shoulder_y + 64)
    elif action == "windup":
        lift = 10 if frame == 1 else 0  # frame 1 = deeper into the windup, higher overhead
        elbow, hand = (shoulder_x + 6, shoulder_y - 40 - lift), (shoulder_x - 24, shoulder_y - 78 - lift)
    elif action == "slam":
        if frame == 0:  # mid-arc, swinging down
            elbow, hand = (shoulder_x - 20, shoulder_y - 10), (shoulder_x - 54, shoulder_y + 40)
        else:  # impact
            elbow, hand = (shoulder_x - 30, shoulder_y + 30), (shoulder_x - 60, shoulder_y + 92)
    else:  # shout -- arms down, roaring
        elbow, hand = (shoulder_x + 8, shoulder_y + 30), (shoulder_x + 6, shoulder_y + 58)

    d.line([(shoulder_x, shoulder_y), elbow], fill=(*body, 255), width=13)
    d.line([elbow, hand], fill=(*belly, 255), width=11)
    if action in ("windup", "slam"):
        ang_dx, ang_dy = hand[0] - elbow[0], hand[1] - elbow[1]
        ang_len = max(1, math.hypot(ang_dx, ang_dy))
        ux, uy = ang_dx / ang_len, ang_dy / ang_len
        shaft_end = (hand[0] + ux * 34, hand[1] + uy * 34)
        d.line([hand, shaft_end], fill=club_shaft, width=8)
        d.ellipse([shaft_end[0] - 14, shaft_end[1] - 14, shaft_end[0] + 14, shaft_end[1] + 14], fill=club_head)
    else:
        d.ellipse([hand[0] - 8, hand[1] - 8, hand[0] + 8, hand[1] + 8], fill=(*belly, 255))

    silhouette_shade(img, light_frac=0.16, dark_frac=0.30)
    return img

def make_boss_sheet():
    sheet = Image.new("RGBA", (BOSS_CW * BOSS_MAX_FRAMES, BOSS_CH * len(BOSS_ACTIONS)), (0, 0, 0, 0))
    for row, action in enumerate(BOSS_ACTIONS):
        for frame in range(BOSS_FRAME_COUNTS[action]):
            spr = draw_boss_frame(action, frame)
            sheet.paste(spr, (frame * BOSS_CW, row * BOSS_CH), spr)
    return sheet

make_boss_sheet().save(os.path.join(OUT_DIR, "cavern_boss.png"))
print("wrote cavern_boss.png size:", BOSS_CW * BOSS_MAX_FRAMES, BOSS_CH * len(BOSS_ACTIONS))
print("BOSS_ACTIONS order:", BOSS_ACTIONS, "FRAME_COUNTS:", BOSS_FRAME_COUNTS, "CELL SIZE:", BOSS_CW, BOSS_CH)

# ---- Cliff area backdrop: a faded, distant view of the starting village ---
# Reached through the door the giant boss unlocks. Not tiled -- one wide
# panorama stretched behind the walkable ledge. Everything in it is blended
# heavily toward the hazy sky color so it reads as "far away in the
# distance" rather than a crisp scene (the actual starting area is recreated
# only as silhouette shapes -- a roof, a few trees -- not a literal replica).
CLIFF_BG_W, CLIFF_BG_H = 260, 120

def make_cliff_bg():
    img = Image.new("RGBA", (CLIFF_BG_W, CLIFF_BG_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sky_top, sky_bot = (58, 66, 96), (150, 140, 156)
    for y in range(CLIFF_BG_H):
        t = y / CLIFF_BG_H
        d.line([(0, y), (CLIFF_BG_W, y)], fill=(*blend(sky_top, sky_bot, t), 255))

    hill_color = blend(sky_bot, (70, 90, 70), 0.35)
    hy = CLIFF_BG_H * 0.62
    rng = random.Random(555)
    pts = [(0, CLIFF_BG_H)]
    x = 0
    while x <= CLIFF_BG_W:
        pts.append((x, hy + rng.randint(-6, 6)))
        x += 18
    pts.append((CLIFF_BG_W, CLIFF_BG_H))
    d.polygon(pts, fill=(*hill_color, 255))

    # A faint tavern-roof silhouette + a scatter of tree silhouettes, all
    # heavily faded toward the sky color.
    village_color = blend(sky_bot, (60, 45, 35), 0.3)
    roof_x, roof_y = CLIFF_BG_W * 0.42, hy - 9
    d.polygon([(roof_x - 14, roof_y), (roof_x, roof_y - 12), (roof_x + 14, roof_y)], fill=(*village_color, 210))
    d.rectangle([roof_x - 10, roof_y, roof_x + 10, roof_y + 9], fill=(*village_color, 190))

    tree_color = blend(sky_bot, (40, 60, 35), 0.32)
    for tx in (CLIFF_BG_W * 0.16, CLIFF_BG_W * 0.24, CLIFF_BG_W * 0.66, CLIFF_BG_W * 0.75, CLIFF_BG_W * 0.9):
        ty = hy - 1
        d.line([(tx, ty), (tx, ty + 5)], fill=(*tree_color, 180), width=2)
        d.ellipse([tx - 5, ty - 15, tx + 5, ty - 3], fill=(*tree_color, 190))

    # A soft haze band low over the hills to sell atmospheric distance.
    haze = Image.new("RGBA", (CLIFF_BG_W, CLIFF_BG_H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(haze)
    hd.rectangle([0, hy - 14, CLIFF_BG_W, hy + 10], fill=(*sky_bot, 70))
    img = Image.alpha_composite(img, haze)
    return img

make_cliff_bg().save(os.path.join(OUT_DIR, "cliff_bg.png"))
print("wrote cliff_bg.png size:", CLIFF_BG_W, CLIFF_BG_H)

# ---------------------------------------------------------------------------
# Graveyard headstones -- purely decorative, scattered around the outside
# world's respawn area (see world.graveyard in server/map.js). 3 variants:
# a rounded slab, a cross, and a jagged broken stone, each with a carved
# line or two and a small ground shadow so they read as "planted" in the
# dirt rather than floating.
# ---------------------------------------------------------------------------

HEADSTONE_W, HEADSTONE_H = 16, 22

def make_headstone(variant):
    img = Image.new("RGBA", (HEADSTONE_W, HEADSTONE_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    stone, stone_dark, stone_light = (120, 118, 122), (74, 72, 78), (155, 154, 158)
    cx = HEADSTONE_W // 2
    d.ellipse([2, HEADSTONE_H - 5, HEADSTONE_W - 2, HEADSTONE_H - 1], fill=(20, 16, 10, 110))
    if variant == 0:
        # rounded slab
        d.rounded_rectangle([cx - 6, 3, cx + 6, HEADSTONE_H - 4], radius=5, fill=(*stone, 255), outline=(*stone_dark, 255))
        d.line([(cx - 3, 9), (cx + 3, 9)], fill=(*stone_dark, 200))
        d.line([(cx - 2, 13), (cx + 2, 13)], fill=(*stone_dark, 200))
        d.line([(cx - 5, 4), (cx - 2, 4)], fill=(*stone_light, 200))
    elif variant == 1:
        # cross
        d.rectangle([cx - 2, 2, cx + 2, HEADSTONE_H - 4], fill=(*stone, 255), outline=(*stone_dark, 255))
        d.rectangle([cx - 6, 6, cx + 6, 10], fill=(*stone, 255), outline=(*stone_dark, 255))
        d.line([(cx - 1, 3), (cx - 1, 7)], fill=(*stone_light, 200))
    else:
        # jagged broken stone
        d.polygon([(cx - 6, HEADSTONE_H - 4), (cx - 7, 8), (cx - 2, 2), (cx + 3, 5), (cx + 7, 10), (cx + 6, HEADSTONE_H - 4)],
                   fill=(*stone, 255), outline=(*stone_dark, 255))
        d.line([(cx - 3, 10), (cx + 1, 12)], fill=(*stone_dark, 200))
    silhouette_shade(img, light_frac=0.15, dark_frac=0.25)
    return img

for _i in range(3):
    make_headstone(_i).save(os.path.join(OUT_DIR, f"headstone_{_i}.png"))
print("wrote headstone_0/1/2.png")

print("Asset generation complete.")
