import {
  TERRAIN_WIDTH,
  TERRAIN_HEIGHT,
  WATER_LEVEL,
  WORM_WIDTH,
  encodeBitmap,
  setBitmapPixel,
  getBitmapPixel,
  findSurfaceY,
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

// ─── Simplex-like 1D noise (seeded) ────────────────────

function seededNoise1D(
  rng: () => number,
  octaves: number,
  x: number,
  frequency: number,
  amplitude: number
): number {
  // Generate a permutation table from the RNG
  // We cache this via closure in generateTerrain
  let val = 0;
  let freq = frequency;
  let amp = amplitude;
  for (let o = 0; o < octaves; o++) {
    val += smoothNoise(rng, x * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return val;
}

// Simple interpolated noise using seeded hash
function smoothNoise(rng: () => number, x: number): number {
  const ix = Math.floor(x);
  const fx = x - ix;
  // Use rng seeded values at integer positions
  const a = hashFloat(ix);
  const b = hashFloat(ix + 1);
  // Cosine interpolation
  const t = (1 - Math.cos(fx * Math.PI)) / 2;
  return a * (1 - t) + b * t;
}

// Simple hash for integer → [0,1]
function hashFloat(n: number): number {
  let x = ((n * 1103515245 + 12345) & 0x7fffffff) >>> 0;
  x = ((x * 1103515245 + 12345) & 0x7fffffff) >>> 0;
  return (x & 0xfffff) / 0xfffff;
}

// ─── Terrain Generation ─────────────────────────────────

const BITMAP_ROW_BYTES = Math.ceil(TERRAIN_WIDTH / 8);

export function generateTerrain(seed: number, theme: TerrainTheme): TerrainData {
  const rng = mulberry32(seed);
  const bitmap = new Uint8Array(BITMAP_ROW_BYTES * TERRAIN_HEIGHT);
  const heightmap: number[] = new Array(TERRAIN_WIDTH);

  // Generate height profile using layered noise
  const baseY = TERRAIN_HEIGHT * 0.45; // baseline around 45% from top
  const amplitude = TERRAIN_HEIGHT * 0.25; // ±25% variation

  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    // Multi-octave noise for interesting terrain
    let h = 0;
    h += Math.sin((x / TERRAIN_WIDTH) * Math.PI) * 0.3; // gentle arch
    h += hashNoise(seed, x, 0.003) * 0.5; // large hills
    h += hashNoise(seed + 1000, x, 0.01) * 0.25; // medium bumps
    h += hashNoise(seed + 2000, x, 0.03) * 0.1; // small detail

    const surfaceY = Math.round(baseY + h * amplitude);
    heightmap[x] = Math.max(20, Math.min(WATER_LEVEL - 20, surfaceY));
  }

  // Fill bitmap: solid below surface, air above
  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    const surface = heightmap[x];
    for (let y = surface; y < WATER_LEVEL; y++) {
      setBitmapPixel(bitmap, x, y, true);
    }
  }

  // Add some caves (random circles carved out)
  const numCaves = 3 + Math.floor(rng() * 5);
  for (let i = 0; i < numCaves; i++) {
    const cx = Math.floor(rng() * TERRAIN_WIDTH);
    const minSurface = heightmap[Math.max(0, Math.min(TERRAIN_WIDTH - 1, cx))];
    const cy = Math.floor(minSurface + rng() * (WATER_LEVEL - minSurface - 40));
    const r = 20 + Math.floor(rng() * 30);
    carveCircle(bitmap, cx, cy, r);
  }

  return {
    bitmap: encodeBitmap(bitmap),
    heightmap,
    seed,
    theme,
  };
}

function hashNoise(seed: number, x: number, frequency: number): number {
  const fx = x * frequency;
  const ix = Math.floor(fx);
  const frac = fx - ix;
  const a = hashFloat(seed * 7919 + ix);
  const b = hashFloat(seed * 7919 + ix + 1);
  const t = (1 - Math.cos(frac * Math.PI)) / 2;
  return (a * (1 - t) + b * t) * 2 - 1; // range [-1, 1]
}

function carveCircle(bitmap: Uint8Array, cx: number, cy: number, radius: number): void {
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
  count: number
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
