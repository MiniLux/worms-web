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
  const totalPixels = TERRAIN_WIDTH * TERRAIN_HEIGHT;

  // Use a flat boolean-ish byte array for fast manipulation during generation,
  // then pack into the 1-bit bitmap at the end.
  const grid = new Uint8Array(totalPixels); // 0=air, 1=solid

  const idx = (x: number, y: number) => y * TERRAIN_WIDTH + x;
  const inBounds = (x: number, y: number) =>
    x >= 0 && x < TERRAIN_WIDTH && y >= 0 && y < TERRAIN_HEIGHT;

  // ── Step 1: Generate 2D Perlin noise field and threshold ──
  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    for (let x = 0; x < TERRAIN_WIDTH; x++) {
      const noise = fbm2D(seed, x, y, 5, 0.004);

      // Vertical bias: more solid toward bottom, less toward top
      const ny = y / TERRAIN_HEIGHT; // 0=top, 1=bottom
      const vertBias = (ny - 0.35) * 0.8; // negative above 35%, positive below

      // Edge fade: push threshold up at edges so terrain doesn't touch borders
      const nx = x / TERRAIN_WIDTH;
      const edgeX = Math.min(nx * 5, (1 - nx) * 5, 1.0); // fade within 20% of edges
      const edgeY = Math.min(ny * 4, 1.0); // fade within 25% of top
      const edgeFade = edgeX * edgeY;

      // Water boundary: no terrain at or below water level
      const waterFade = y >= WATER_LEVEL - 10 ? 0 : 1;

      const threshold = -0.02 + (1 - edgeFade) * 0.6;
      const value = noise + vertBias;

      if (value > threshold && waterFade > 0) {
        grid[idx(x, y)] = 1;
      }
    }
  }

  // ── Step 2: Flood fill from bottom-center to keep only connected terrain ──
  // Find a solid seed point near bottom-center
  let seedX = Math.floor(TERRAIN_WIDTH / 2);
  let seedY = WATER_LEVEL - 20;
  // Search for a solid pixel near the seed point
  let foundSeed = false;
  for (let r = 0; r < 200 && !foundSeed; r++) {
    for (let dy = -r; dy <= r && !foundSeed; dy++) {
      for (let dx = -r; dx <= r && !foundSeed; dx++) {
        const sx = seedX + dx;
        const sy = seedY + dy;
        if (inBounds(sx, sy) && grid[idx(sx, sy)] === 1) {
          seedX = sx;
          seedY = sy;
          foundSeed = true;
        }
      }
    }
  }

  if (foundSeed) {
    // BFS flood fill to find connected component
    const visited = new Uint8Array(totalPixels);
    const queue: number[] = [seedX, seedY];
    visited[idx(seedX, seedY)] = 1;

    let head = 0;
    while (head < queue.length) {
      const qx = queue[head++];
      const qy = queue[head++];

      const neighbors = [
        [qx - 1, qy],
        [qx + 1, qy],
        [qx, qy - 1],
        [qx, qy + 1],
      ];
      for (const [nx2, ny2] of neighbors) {
        if (
          inBounds(nx2, ny2) &&
          grid[idx(nx2, ny2)] === 1 &&
          !visited[idx(nx2, ny2)]
        ) {
          visited[idx(nx2, ny2)] = 1;
          queue.push(nx2, ny2);
        }
      }
    }

    // Keep only the connected component
    for (let i = 0; i < totalPixels; i++) {
      if (grid[i] === 1 && !visited[i]) {
        grid[i] = 0;
      }
    }
  }

  // ── Step 3: Morphological close (dilation then erosion) ──
  // This fills small holes and thin gaps
  const morphRadius = 4;
  const dilated = new Uint8Array(totalPixels);
  const eroded = new Uint8Array(totalPixels);

  // Dilation: expand solid pixels
  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    for (let x = 0; x < TERRAIN_WIDTH; x++) {
      if (grid[idx(x, y)] === 1) {
        // Mark all pixels within radius as solid in dilated
        for (let dy = -morphRadius; dy <= morphRadius; dy++) {
          for (let dx = -morphRadius; dx <= morphRadius; dx++) {
            if (dx * dx + dy * dy <= morphRadius * morphRadius) {
              const nx2 = x + dx;
              const ny2 = y + dy;
              if (inBounds(nx2, ny2) && ny2 < WATER_LEVEL) {
                dilated[idx(nx2, ny2)] = 1;
              }
            }
          }
        }
      }
    }
  }

  // Erosion: shrink back by same radius (on the dilated result)
  // A pixel survives erosion if ALL pixels within radius are solid in dilated
  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    for (let x = 0; x < TERRAIN_WIDTH; x++) {
      if (dilated[idx(x, y)] === 0) continue;
      let allSolid = true;
      for (let dy = -morphRadius; dy <= morphRadius && allSolid; dy++) {
        for (let dx = -morphRadius; dx <= morphRadius && allSolid; dx++) {
          if (dx * dx + dy * dy <= morphRadius * morphRadius) {
            const nx2 = x + dx;
            const ny2 = y + dy;
            if (!inBounds(nx2, ny2) || dilated[idx(nx2, ny2)] === 0) {
              allSolid = false;
            }
          }
        }
      }
      if (allSolid) {
        eroded[idx(x, y)] = 1;
      }
    }
  }

  // Copy eroded result back to grid
  grid.set(eroded);

  // ── Step 4: Remove small interior holes ──
  // Flood fill air from all edges; any air not reached is an interior hole
  const airVisited = new Uint8Array(totalPixels);
  const airQueue: number[] = [];

  // Seed from all border pixels that are air
  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    if (grid[idx(x, 0)] === 0 && !airVisited[idx(x, 0)]) {
      airVisited[idx(x, 0)] = 1;
      airQueue.push(x, 0);
    }
    const bottomY = TERRAIN_HEIGHT - 1;
    if (grid[idx(x, bottomY)] === 0 && !airVisited[idx(x, bottomY)]) {
      airVisited[idx(x, bottomY)] = 1;
      airQueue.push(x, bottomY);
    }
  }
  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    if (grid[idx(0, y)] === 0 && !airVisited[idx(0, y)]) {
      airVisited[idx(0, y)] = 1;
      airQueue.push(0, y);
    }
    const rightX = TERRAIN_WIDTH - 1;
    if (grid[idx(rightX, y)] === 0 && !airVisited[idx(rightX, y)]) {
      airVisited[idx(rightX, y)] = 1;
      airQueue.push(rightX, y);
    }
  }

  // BFS flood fill air
  let airHead = 0;
  while (airHead < airQueue.length) {
    const ax = airQueue[airHead++];
    const ay = airQueue[airHead++];
    const airNeighbors = [
      [ax - 1, ay],
      [ax + 1, ay],
      [ax, ay - 1],
      [ax, ay + 1],
    ];
    for (const [anx, any2] of airNeighbors) {
      if (
        inBounds(anx, any2) &&
        grid[idx(anx, any2)] === 0 &&
        !airVisited[idx(anx, any2)]
      ) {
        airVisited[idx(anx, any2)] = 1;
        airQueue.push(anx, any2);
      }
    }
  }

  // Fill interior holes (air not reached from outside)
  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    for (let x = 0; x < TERRAIN_WIDTH; x++) {
      if (grid[idx(x, y)] === 0 && !airVisited[idx(x, y)] && y < WATER_LEVEL) {
        grid[idx(x, y)] = 1;
      }
    }
  }

  // ── Step 5: Smooth edges (cellular automata smoothing) ──
  for (let pass = 0; pass < 3; pass++) {
    const smoothed = new Uint8Array(grid);
    for (let y = 1; y < TERRAIN_HEIGHT - 1; y++) {
      for (let x = 1; x < TERRAIN_WIDTH - 1; x++) {
        // Count solid neighbors in 5x5 window
        let count = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx2 = x + dx;
            const ny2 = y + dy;
            if (inBounds(nx2, ny2) && grid[idx(nx2, ny2)] === 1) {
              count++;
            }
          }
        }
        // 5x5 window has 25 cells
        if (count >= 13) {
          smoothed[idx(x, y)] = 1;
        } else if (count <= 11) {
          smoothed[idx(x, y)] = 0;
        }
        // else keep current value (hysteresis)
      }
    }
    grid.set(smoothed);
  }

  // ── Step 6: Fill terrain down to water level ──
  // For each column, find the lowest solid pixel and fill everything below it
  // down to WATER_LEVEL. This prevents terrain from "floating" above water.
  for (let x = 0; x < TERRAIN_WIDTH; x++) {
    let lowestSolid = -1;
    for (let y = WATER_LEVEL - 1; y >= 0; y--) {
      if (grid[idx(x, y)] === 1) {
        lowestSolid = y;
        break;
      }
    }
    if (lowestSolid >= 0) {
      for (let y = lowestSolid + 1; y < WATER_LEVEL; y++) {
        grid[idx(x, y)] = 1;
      }
    }
  }
  // Clear below water level
  for (let y = WATER_LEVEL; y < TERRAIN_HEIGHT; y++) {
    for (let x = 0; x < TERRAIN_WIDTH; x++) {
      grid[idx(x, y)] = 0;
    }
  }
  // Clear small margin at left/right edges
  const edgeMargin = 20;
  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    for (let x = 0; x < edgeMargin; x++) {
      grid[idx(x, y)] = 0;
      grid[idx(TERRAIN_WIDTH - 1 - x, y)] = 0;
    }
  }

  // ── Step 7: Add floating islands for gameplay variety ──
  const numIslands = 2 + Math.floor(rng() * 3); // 2-4 floating islands
  for (let i = 0; i < numIslands; i++) {
    const ix = Math.floor(TERRAIN_WIDTH * (0.1 + rng() * 0.8));
    // Find the main terrain surface at this X
    let mainSurface = WATER_LEVEL;
    for (let y = 0; y < TERRAIN_HEIGHT; y++) {
      if (grid[idx(Math.min(TERRAIN_WIDTH - 1, ix), y)] === 1) {
        mainSurface = y;
        break;
      }
    }
    const iy = Math.max(25, mainSurface - 40 - Math.floor(rng() * 80));
    const islandW = 50 + Math.floor(rng() * 80);
    const islandH = 20 + Math.floor(rng() * 20);
    const halfW = Math.floor(islandW / 2);
    for (let dx = -halfW; dx <= halfW; dx++) {
      const px = ix + dx;
      if (px < 0 || px >= TERRAIN_WIDTH) continue;
      const edgeT = 1 - (dx * dx) / (halfW * halfW);
      const colH = Math.max(4, Math.floor(islandH * edgeT));
      for (let dy = 0; dy < colH; dy++) {
        const py = iy + dy;
        if (py >= 0 && py < WATER_LEVEL) {
          grid[idx(px, py)] = 1;
        }
      }
    }
  }

  // ── Pack into 1-bit bitmap ──
  const bitmap = new Uint8Array(BITMAP_ROW_BYTES * TERRAIN_HEIGHT);
  const heightmap: number[] = new Array(TERRAIN_WIDTH);

  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    for (let x = 0; x < TERRAIN_WIDTH; x++) {
      if (grid[idx(x, y)] === 1) {
        setBitmapPixel(bitmap, x, y, true);
      }
    }
  }

  // Calculate heightmap
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
