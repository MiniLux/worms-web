import {
  TERRAIN_WIDTH,
  TERRAIN_HEIGHT,
  WATER_LEVEL,
  encodeBitmap,
  setBitmapPixel,
  getBitmapPixel,
} from "@worms/shared";
import type { TerrainData, TerrainTheme } from "@worms/shared";

// ─── Seeded PRNG (Mulberry32) ───────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── High-quality hash & gradient noise ─────────────────

/** High-quality integer hash (xxhash-inspired), returns [0, 0xFFFFFFFF] */
function hash1(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}

/** Hash two ints to [0, 0xFFFFFFFF] */
function hash2(a: number, b: number): number {
  let h = a | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = (h + Math.imul(b | 0, 0xcc9e2d51)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash three ints to [0, 0xFFFFFFFF] */
function hash3(a: number, b: number, c: number): number {
  return hash2(hash2(a, b), c);
}

/** Quintic smoothstep (6t^5 - 15t^4 + 10t^3) for smooth derivatives */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 1D gradient noise: returns [-1, 1] */
function gradNoise1D(seed: number, x: number, frequency: number): number {
  const fx = x * frequency;
  const ix = Math.floor(fx);
  const frac = fx - ix;

  // Random gradients at integer positions (either +1 or -1, but with variation)
  const g0 = (hash1(seed + ix * 6971) / 0xffffffff) * 2 - 1;
  const g1 = (hash1(seed + (ix + 1) * 6971) / 0xffffffff) * 2 - 1;

  // Dot product of gradient and distance
  const d0 = g0 * frac;
  const d1 = g1 * (frac - 1);

  const t = fade(frac);
  return d0 + t * (d1 - d0);
}

/** 2D gradient noise (Perlin-style): returns approx [-0.7, 0.7] */
function gradNoise2D(
  seed: number,
  x: number,
  y: number,
  frequency: number,
): number {
  const fx = x * frequency;
  const fy = y * frequency;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const fracX = fx - ix;
  const fracY = fy - iy;

  // 2D gradient vectors from hash (8 directions)
  const grad = (hx: number, hy: number, dx: number, dy: number): number => {
    const h = hash3(seed, hx, hy) & 7;
    const GRADS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    const g = GRADS[h];
    return g[0] * dx + g[1] * dy;
  };

  const n00 = grad(ix, iy, fracX, fracY);
  const n10 = grad(ix + 1, iy, fracX - 1, fracY);
  const n01 = grad(ix, iy + 1, fracX, fracY - 1);
  const n11 = grad(ix + 1, iy + 1, fracX - 1, fracY - 1);

  const u = fade(fracX);
  const v = fade(fracY);

  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}

/** Fractal Brownian motion (1D) */
function fbm1D(
  seed: number,
  x: number,
  octaves: number,
  baseFreq: number,
): number {
  let value = 0;
  let freq = baseFreq;
  let amp = 1;
  let maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    value += gradNoise1D(seed + o * 7919, x, freq) * amp;
    maxAmp += amp;
    freq *= 2.17; // non-integer ratio avoids repeating patterns
    amp *= 0.48;
  }
  return value / maxAmp;
}

/** Fractal Brownian motion (2D) */
function fbm2D(
  seed: number,
  x: number,
  y: number,
  octaves: number,
  baseFreq: number,
): number {
  let value = 0;
  let freq = baseFreq;
  let amp = 1;
  let maxAmp = 0;
  for (let o = 0; o < octaves; o++) {
    value += gradNoise2D(seed + o * 3571, x, y, freq) * amp;
    maxAmp += amp;
    freq *= 2.13;
    amp *= 0.5;
  }
  return value / maxAmp;
}

// ─── Terrain Generation ─────────────────────────────────

const BITMAP_ROW_BYTES = Math.ceil(TERRAIN_WIDTH / 8);

export function generateTerrain(
  seed: number,
  theme: TerrainTheme,
): TerrainData {
  const rng = mulberry32(seed);
  const bitmap = new Uint8Array(BITMAP_ROW_BYTES * TERRAIN_HEIGHT);
  const heightmap: number[] = new Array(TERRAIN_WIDTH);

  // ── Height profile: dramatic hills + valleys like Worms 2 ──
  const baseY = TERRAIN_HEIGHT * 0.42;
  const amplitude = TERRAIN_HEIGHT * 0.35; // ±35% — more dramatic than before

  // Pick 1-2 valley positions that dip down near water, creating distinct landmasses
  const numValleys = 1 + Math.floor(rng() * 2); // 1-2 valleys
  const valleys: { center: number; width: number; depth: number }[] = [];
  for (let i = 0; i < numValleys; i++) {
    valleys.push({
      center: 0.2 + rng() * 0.6, // normalized [0.2, 0.8]
      width: 0.05 + rng() * 0.08, // narrow gap
      depth: 0.7 + rng() * 0.3, // how deep (0.7-1.0, 1.0 = to water)
    });
  }

  // Pick 4-8 flat platform spots for worm placement
  const numPlatforms = 4 + Math.floor(rng() * 5);
  const platforms: { center: number; width: number }[] = [];
  for (let i = 0; i < numPlatforms; i++) {
    platforms.push({
      center: 0.08 + rng() * 0.84,
      width: 30 + rng() * 50,
    });
  }

  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    const nx = x / TERRAIN_WIDTH; // normalized [0,1]

    // Organic fbm noise for natural terrain profile
    const h = fbm1D(seed, x, 6, 0.002);

    // Edge fade — terrain tapers off at edges creating an island shape
    const edgeFade = Math.min(1, nx * 6, (1 - nx) * 6); // sharp taper within ~17% of edges
    const edgePush = 1 - edgeFade; // 0 in middle, 1 at extreme edges

    // Valley cuts — deep notches creating distinct landmasses
    let valleyMul = 1;
    for (const v of valleys) {
      const dist = Math.abs(nx - v.center);
      if (dist < v.width) {
        const t = 1 - dist / v.width;
        const valleyShape = t * t * (3 - 2 * t); // smoothstep
        valleyMul = Math.min(valleyMul, 1 - valleyShape * v.depth);
      }
    }

    let surfaceY = baseY + h * amplitude;

    // Apply valley: push surface down toward water
    if (valleyMul < 1) {
      surfaceY = surfaceY + (WATER_LEVEL - 5 - surfaceY) * (1 - valleyMul);
    }

    // Apply edge fade: push surface down toward water at edges
    if (edgePush > 0) {
      surfaceY = surfaceY + (WATER_LEVEL - 5 - surfaceY) * edgePush;
    }

    heightmap[x] = Math.max(
      30,
      Math.min(WATER_LEVEL - 10, Math.round(surfaceY)),
    );
  }

  // Flatten platform areas gently (blend toward local average)
  for (const plat of platforms) {
    const cx = Math.round(plat.center * TERRAIN_WIDTH);
    const halfW = Math.round(plat.width / 2);
    const startX = Math.max(0, cx - halfW);
    const endX = Math.min(TERRAIN_WIDTH - 1, cx + halfW);
    const midY = heightmap[Math.min(TERRAIN_WIDTH - 1, cx)];
    for (let x = startX; x <= endX; x++) {
      const t = 1 - Math.abs(x - cx) / halfW;
      const blend = t * t * (3 - 2 * t); // smoothstep
      heightmap[x] = Math.round(
        heightmap[x] * (1 - blend * 0.7) + midY * blend * 0.7,
      );
    }
  }

  // Fill bitmap: solid below surface, air above
  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    const surface = heightmap[x];
    for (let y = surface; y < WATER_LEVEL; y++) {
      setBitmapPixel(bitmap, x, y, true);
    }
  }

  // ── 2D noise cave system ──
  // Carve connected tunnels using thresholded fbm2D
  const caveThreshold = 0.28 + rng() * 0.1; // randomize density per map
  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    const surface = heightmap[x];
    const minCaveY = surface + 25; // don't carve too close to surface
    for (let y = minCaveY; y < WATER_LEVEL - 15; y++) {
      const n = fbm2D(seed + 9999, x, y, 4, 0.008);
      if (n > caveThreshold) {
        setBitmapPixel(bitmap, x, y, false);
      }
    }
  }

  // Supplement with 2-4 random circle caves for variety
  const numCircleCaves = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < numCircleCaves; i++) {
    const cx = Math.floor(rng() * TERRAIN_WIDTH);
    const surfaceAtCx = heightmap[Math.max(0, Math.min(TERRAIN_WIDTH - 1, cx))];
    const cy = Math.floor(
      surfaceAtCx + 30 + rng() * (WATER_LEVEL - surfaceAtCx - 70),
    );
    const r = 25 + Math.floor(rng() * 35);
    carveCircle(bitmap, cx, cy, r);
  }

  // ── Floating islands above the main terrain ──
  const numIslands = 3 + Math.floor(rng() * 4); // 3-6 floating islands
  for (let i = 0; i < numIslands; i++) {
    const ix = Math.floor(TERRAIN_WIDTH * (0.1 + rng() * 0.8));
    const mainSurface = heightmap[Math.max(0, Math.min(TERRAIN_WIDTH - 1, ix))];
    // Place island 40-120px above the main terrain surface
    const iy = Math.max(30, mainSurface - 40 - Math.floor(rng() * 80));
    const islandW = 50 + Math.floor(rng() * 80); // 50-130px wide
    const islandH = 20 + Math.floor(rng() * 20); // 20-40px tall

    // Draw an elliptical island shape with a flat top
    const halfW = Math.floor(islandW / 2);
    for (let dx = -halfW; dx <= halfW; dx++) {
      const px = ix + dx;
      if (px < 0 || px >= TERRAIN_WIDTH) continue;
      // Elliptical: height tapers at edges
      const edgeT = 1 - (dx * dx) / (halfW * halfW);
      const colH = Math.max(4, Math.floor(islandH * edgeT));
      // Flat top, rounded bottom
      for (let dy = 0; dy < colH; dy++) {
        const py = iy + dy;
        if (py >= 0 && py < TERRAIN_HEIGHT) {
          setBitmapPixel(bitmap, px, py, true);
        }
      }
    }
  }

  // ── Recalculate heightmap after cave carving and floating islands ──
  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    let found = false;
    for (let y = 0; y < TERRAIN_HEIGHT; y++) {
      if (getBitmapPixel(bitmap, x, y)) {
        heightmap[x] = y;
        found = true;
        break;
      }
    }
    if (!found) {
      heightmap[x] = WATER_LEVEL;
    }
  }

  return {
    bitmap: encodeBitmap(bitmap),
    heightmap,
    seed,
    theme,
  };
}

function carveCircle(
  bitmap: Uint8Array,
  cx: number,
  cy: number,
  radius: number,
): void {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) {
        setBitmapPixel(bitmap, cx + dx, cy + dy, false);
      }
    }
  }
}

// ─── Spawn Points ───────────────────────────────────────

export interface SpawnPoint {
  x: number;
  y: number;
}

/**
 * Find spawn points on the terrain surface, evenly spaced.
 * Returns `count` points that are on solid ground with air above.
 */
export function getSpawnPoints(
  bitmap: Uint8Array,
  count: number,
): SpawnPoint[] {
  const margin = 100;
  const usableWidth = TERRAIN_WIDTH - 2 * margin;
  const spacing = usableWidth / (count + 1);
  const points: SpawnPoint[] = [];

  for (let i = 0; i < count; i++) {
    const targetX = Math.round(margin + spacing * (i + 1));
    // Find surface at this X
    const surfaceY = findSurfaceYLocal(bitmap, targetX);
    // Place worm on top of terrain
    points.push({ x: targetX, y: surfaceY - 12 }); // half worm height above surface
  }

  return points;
}

function findSurfaceYLocal(bitmap: Uint8Array, x: number): number {
  const col = Math.max(0, Math.min(TERRAIN_WIDTH - 1, x));
  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    if (getBitmapPixel(bitmap, col, y)) {
      return y;
    }
  }
  return WATER_LEVEL;
}
