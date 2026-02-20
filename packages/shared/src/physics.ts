import {
  TERRAIN_WIDTH,
  TERRAIN_HEIGHT,
  WATER_LEVEL,
  GRAVITY,
  PHYSICS_STEP_MS,
  MAX_TRAJECTORY_STEPS,
  FALL_DAMAGE_THRESHOLD,
  FALL_DAMAGE_PER_PIXEL,
  FIRE_POWER_MULTIPLIER,
  WORM_WIDTH,
  WORM_HEIGHT,
  WORM_WALK_SPEED,
  WORM_MAX_CLIMB,
  WORM_FRICTION_GROUND,
} from "./constants";
import type { TrajectoryPoint } from "./types";

// ─── Bitmap Helpers ─────────────────────────────────────

const BITMAP_ROW_BYTES = Math.ceil(TERRAIN_WIDTH / 8);

/** Decode a base64 bitmap string to Uint8Array */
export function decodeBitmap(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node.js
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** Encode a Uint8Array bitmap to base64 */
export function encodeBitmap(bitmap: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bitmap.length; i++) {
      binary += String.fromCharCode(bitmap[i]);
    }
    return btoa(binary);
  }
  return Buffer.from(bitmap).toString("base64");
}

/** Check if a pixel is solid in the bitmap */
export function getBitmapPixel(
  bitmap: Uint8Array,
  x: number,
  y: number,
): boolean {
  if (x < 0 || x >= TERRAIN_WIDTH || y < 0 || y >= TERRAIN_HEIGHT) return false;
  const byteIndex = y * BITMAP_ROW_BYTES + Math.floor(x / 8);
  const bitIndex = 7 - (x % 8);
  return ((bitmap[byteIndex] >> bitIndex) & 1) === 1;
}

/** Set a pixel in the bitmap */
export function setBitmapPixel(
  bitmap: Uint8Array,
  x: number,
  y: number,
  solid: boolean,
): void {
  if (x < 0 || x >= TERRAIN_WIDTH || y < 0 || y >= TERRAIN_HEIGHT) return;
  const byteIndex = y * BITMAP_ROW_BYTES + Math.floor(x / 8);
  const bitIndex = 7 - (x % 8);
  if (solid) {
    bitmap[byteIndex] |= 1 << bitIndex;
  } else {
    bitmap[byteIndex] &= ~(1 << bitIndex);
  }
}

/** Erase a circle from the bitmap. Returns number of pixels erased. */
export function eraseCircleFromBitmap(
  bitmap: Uint8Array,
  cx: number,
  cy: number,
  radius: number,
): number {
  let erased = 0;
  const r2 = radius * radius;
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(TERRAIN_WIDTH - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(TERRAIN_HEIGHT - 1, Math.ceil(cy + radius));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        if (getBitmapPixel(bitmap, x, y)) {
          setBitmapPixel(bitmap, x, y, false);
          erased++;
        }
      }
    }
  }
  return erased;
}

// ─── Ballistic Simulation ───────────────────────────────

export interface BallisticResult {
  trajectory: TrajectoryPoint[];
  impactX: number;
  impactY: number;
  impactTime: number;
  hitType: "terrain" | "water" | "outofbounds" | "fuse" | "worm";
  hitWormId?: string;
}

export interface BallisticWorm {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Simulate a ballistic projectile trajectory deterministically.
 * Returns the full trajectory and impact information.
 */
export function simulateBallistic(
  startX: number,
  startY: number,
  angle: number,
  power: number,
  wind: number,
  bitmap: Uint8Array,
  fuseTimeMs: number = 0,
  bounceElasticity: number = 0,
  affectedByWind: boolean = true,
  worms: BallisticWorm[] = [],
): BallisticResult {
  const speed = power * FIRE_POWER_MULTIPLIER;
  let vx = Math.cos(angle) * speed;
  let vy = Math.sin(angle) * speed;
  let x = startX;
  let y = startY;
  const dt = PHYSICS_STEP_MS / 1000;
  const windForce = affectedByWind ? wind * 5.0 : 0;

  const trajectory: TrajectoryPoint[] = [{ x, y, t: 0 }];

  for (let step = 1; step <= MAX_TRAJECTORY_STEPS; step++) {
    const t = step * PHYSICS_STEP_MS;

    // Apply forces
    vy += GRAVITY * dt;
    vx += windForce * dt;

    // Move
    x += vx * dt;
    y += vy * dt;

    trajectory.push({ x: Math.round(x), y: Math.round(y), t });

    // Check fuse
    if (fuseTimeMs > 0 && t >= fuseTimeMs) {
      return {
        trajectory,
        impactX: Math.round(x),
        impactY: Math.round(y),
        impactTime: t,
        hitType: "fuse",
      };
    }

    // Check water
    if (y >= WATER_LEVEL) {
      return {
        trajectory,
        impactX: Math.round(x),
        impactY: WATER_LEVEL,
        impactTime: t,
        hitType: "water",
      };
    }

    // Check out of bounds (sides only — allow projectiles to arc high above)
    if (x < -50 || x > TERRAIN_WIDTH + 50 || y < -2000) {
      return {
        trajectory,
        impactX: Math.round(x),
        impactY: Math.round(y),
        impactTime: t,
        hitType: "outofbounds",
      };
    }

    // Check worm hitbox collision (skip first few steps to avoid self-hit)
    if (step > 3) {
      for (const w of worms) {
        const dx = Math.abs(Math.round(x) - w.x);
        const dy = Math.abs(Math.round(y) - w.y);
        if (dx < w.width / 2 + 4 && dy < w.height / 2 + 4) {
          // Bouncy projectiles (grenades) bounce off worms, don't explode
          if (bounceElasticity > 0) {
            // Bounce off worm — reverse velocity
            const prevX = trajectory[trajectory.length - 2]?.x ?? x;
            const prevY = trajectory[trajectory.length - 2]?.y ?? y;
            x = prevX;
            y = prevY;
            trajectory[trajectory.length - 1] = {
              x: Math.round(x),
              y: Math.round(y),
              t,
            };
            vy = -vy * bounceElasticity;
            vx = -vx * bounceElasticity;
            break;
          }
          return {
            trajectory,
            impactX: Math.round(x),
            impactY: Math.round(y),
            impactTime: t,
            hitType: "worm",
            hitWormId: w.id,
          };
        }
      }
    }

    // Check terrain collision using a small circular hitbox (radius 3)
    const projRadius = 3;
    const rx = Math.round(x);
    const ry = Math.round(y);
    let terrainHit = false;
    if (rx >= 0 && rx < TERRAIN_WIDTH && ry >= 0 && ry < TERRAIN_HEIGHT) {
      // Check center and a ring of points around the projectile
      if (getBitmapPixel(bitmap, rx, ry)) {
        terrainHit = true;
      } else {
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2;
          const cx = Math.round(rx + Math.cos(ang) * projRadius);
          const cy = Math.round(ry + Math.sin(ang) * projRadius);
          if (
            cx >= 0 &&
            cx < TERRAIN_WIDTH &&
            cy >= 0 &&
            cy < TERRAIN_HEIGHT &&
            getBitmapPixel(bitmap, cx, cy)
          ) {
            terrainHit = true;
            break;
          }
        }
      }
    }

    if (terrainHit) {
      if (bounceElasticity > 0) {
        const prevX = trajectory[trajectory.length - 2]?.x ?? x;
        const prevY = trajectory[trajectory.length - 2]?.y ?? y;

        // Compute surface normal by sampling terrain in a wider area
        // Count solid pixels in each direction to determine the surface orientation
        const sampleRadius = 6;
        let nx = 0;
        let ny = 0;
        for (let sy = -sampleRadius; sy <= sampleRadius; sy++) {
          for (let sx = -sampleRadius; sx <= sampleRadius; sx++) {
            const px = rx + sx;
            const py = ry + sy;
            if (
              px >= 0 &&
              px < TERRAIN_WIDTH &&
              py >= 0 &&
              py < TERRAIN_HEIGHT &&
              getBitmapPixel(bitmap, px, py)
            ) {
              // Each solid pixel contributes a normal pointing away from it
              nx -= sx;
              ny -= sy;
            }
          }
        }

        // Normalize
        const nLen = Math.sqrt(nx * nx + ny * ny);

        // Back up to previous position
        x = prevX;
        y = prevY;
        trajectory[trajectory.length - 1] = {
          x: Math.round(x),
          y: Math.round(y),
          t,
        };

        if (nLen > 0.01) {
          // Reflect velocity across the surface normal
          nx /= nLen;
          ny /= nLen;
          const dot = vx * nx + vy * ny;
          vx = (vx - 2 * dot * nx) * bounceElasticity;
          vy = (vy - 2 * dot * ny) * bounceElasticity;
        } else {
          // Fallback: reverse both
          vx = -vx * bounceElasticity;
          vy = -vy * bounceElasticity;
        }

        // If moving too slowly, stop
        if (Math.abs(vx) < 5 && Math.abs(vy) < 5) {
          return {
            trajectory,
            impactX: Math.round(x),
            impactY: Math.round(y),
            impactTime: t,
            hitType: "terrain",
          };
        }
        continue;
      }

      return {
        trajectory,
        impactX: Math.round(x),
        impactY: Math.round(y),
        impactTime: t,
        hitType: "terrain",
      };
    }
  }

  // Max steps reached
  return {
    trajectory,
    impactX: Math.round(x),
    impactY: Math.round(y),
    impactTime: MAX_TRAJECTORY_STEPS * PHYSICS_STEP_MS,
    hitType: "outofbounds",
  };
}

// ─── Hitscan ────────────────────────────────────────────

export interface HitscanResult {
  hitX: number;
  hitY: number;
  hitType: "terrain" | "worm" | "none";
  hitWormId: string | null;
  distance: number;
}

/**
 * Cast a ray from (sx,sy) in direction angle.
 * Check terrain bitmap and worm positions.
 */
export function raycast(
  sx: number,
  sy: number,
  angle: number,
  bitmap: Uint8Array,
  worms: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    alive: boolean;
  }>,
  maxDistance: number = 1500,
  excludeWormId?: string,
): HitscanResult {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const step = 2; // pixels per step

  for (let d = 0; d < maxDistance; d += step) {
    const x = Math.round(sx + dx * d);
    const y = Math.round(sy + dy * d);

    // Out of bounds
    if (x < 0 || x >= TERRAIN_WIDTH || y < 0 || y >= TERRAIN_HEIGHT) {
      if (y >= WATER_LEVEL) {
        return {
          hitX: x,
          hitY: y,
          hitType: "none",
          hitWormId: null,
          distance: d,
        };
      }
      continue;
    }

    // Check worm hit
    for (const worm of worms) {
      if (!worm.alive || worm.id === excludeWormId) continue;
      const hw = worm.width / 2;
      const hh = worm.height / 2;
      if (
        x >= worm.x - hw &&
        x <= worm.x + hw &&
        y >= worm.y - hh &&
        y <= worm.y + hh
      ) {
        return {
          hitX: x,
          hitY: y,
          hitType: "worm",
          hitWormId: worm.id,
          distance: d,
        };
      }
    }

    // Check terrain
    if (getBitmapPixel(bitmap, x, y)) {
      return {
        hitX: x,
        hitY: y,
        hitType: "terrain",
        hitWormId: null,
        distance: d,
      };
    }
  }

  return {
    hitX: Math.round(sx + dx * maxDistance),
    hitY: Math.round(sy + dy * maxDistance),
    hitType: "none",
    hitWormId: null,
    distance: maxDistance,
  };
}

// ─── Explosion Knockback ────────────────────────────────

export interface KnockbackResult {
  damage: number;
  vx: number;
  vy: number;
}

/**
 * Compute damage and knockback for a worm from an explosion.
 * Damage falls off linearly with distance from center.
 */
export function computeKnockback(
  wormX: number,
  wormY: number,
  explosionX: number,
  explosionY: number,
  radius: number,
  baseDamage: number,
  knockbackMultiplier: number = 1.0,
): KnockbackResult {
  const dx = wormX - explosionX;
  const dy = wormY - explosionY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > radius) {
    return { damage: 0, vx: 0, vy: 0 };
  }

  // Smooth falloff: generous damage even near edges (like original Worms)
  // Uses square root curve so damage stays high until near the edge
  const t = dist / radius; // 0 at center, 1 at edge
  const falloff = 1 - t * t;
  const damage = Math.max(1, Math.round(baseDamage * falloff));

  // Knockback direction: away from explosion center
  const knockbackForce = 200 * falloff * knockbackMultiplier;
  const angle = dist > 0 ? Math.atan2(dy, dx) : -Math.PI / 2; // straight up if at center
  const vx = Math.cos(angle) * knockbackForce;
  const vy = Math.sin(angle) * knockbackForce;

  return { damage, vx, vy };
}

// ─── Fall Damage ────────────────────────────────────────

/**
 * Compute fall damage from vertical velocity at landing.
 * Uses velocity as a proxy for fall distance.
 */
export function computeFallDamage(fallVelocity: number): number {
  // fallVelocity is in px/s. Convert to approximate pixel distance.
  // At gravity 300 px/s², velocity v implies fall of v²/(2*g) pixels
  const fallPixels = (fallVelocity * fallVelocity) / (2 * GRAVITY);
  if (fallPixels <= FALL_DAMAGE_THRESHOLD) return 0;
  return Math.round(
    (fallPixels - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_PER_PIXEL,
  );
}

// ─── Terrain Surface Finder ─────────────────────────────

/**
 * Find the Y coordinate of the terrain surface at a given X.
 * Scans downward from top.
 */
export function findSurfaceY(bitmap: Uint8Array, x: number): number {
  const col = Math.max(0, Math.min(TERRAIN_WIDTH - 1, Math.round(x)));
  for (let y = 0; y < TERRAIN_HEIGHT; y++) {
    if (getBitmapPixel(bitmap, col, y)) {
      return y;
    }
  }
  return WATER_LEVEL; // no terrain found, return water level
}

// ─── Worm Physics Step ──────────────────────────────────

export interface WormPhysicsStepResult {
  x: number;
  y: number;
  vx: number;
  vy: number;
  landed: boolean;
  landingVy: number;
  inWater: boolean;
}

/**
 * Simulate one physics step for a worm against terrain.
 * Handles gravity, terrain collision, terrain-following (walking), and water death.
 *
 * @param x, y — current worm center position
 * @param vx, vy — current velocity
 * @param dt — time step in seconds
 * @param bitmap — terrain bitmap
 * @param isWalking — true if the worm is actively walking (arrow key held)
 * @param walkDirection — -1 for left, +1 for right, 0 if not walking
 */
export function simulateWormStep(
  x: number,
  y: number,
  vx: number,
  vy: number,
  dt: number,
  bitmap: Uint8Array,
  isWalking: boolean,
  walkDirection: number,
): WormPhysicsStepResult {
  const halfW = WORM_WIDTH / 2;
  const halfH = WORM_HEIGHT / 2;
  const feetY = y + halfH;

  // Check if worm is currently on ground
  const onGround =
    feetY < TERRAIN_HEIGHT &&
    feetY >= 0 &&
    getBitmapPixel(bitmap, Math.round(x), Math.round(feetY + 1));

  if (onGround && Math.abs(vx) < 2 && vy >= 0) {
    // Worm is resting on ground
    if (isWalking && walkDirection !== 0) {
      // Walking: move horizontally along terrain surface
      const dx = walkDirection * WORM_WALK_SPEED * dt;
      const newX = Math.max(halfW, Math.min(TERRAIN_WIDTH - halfW, x + dx));
      const targetX = Math.round(newX);

      // Find surface at target X
      // Scan from above current position downward
      const scanStartY = Math.round(y - halfH - WORM_MAX_CLIMB);
      const scanEndY = Math.round(feetY + WORM_MAX_CLIMB + 20);

      let newSurfaceY = -1;
      for (
        let sy = Math.max(0, scanStartY);
        sy < Math.min(TERRAIN_HEIGHT, scanEndY);
        sy++
      ) {
        if (getBitmapPixel(bitmap, targetX, sy)) {
          newSurfaceY = sy;
          break;
        }
      }

      if (newSurfaceY >= 0) {
        const climb = y + halfH - newSurfaceY;
        if (climb > WORM_MAX_CLIMB) {
          // Too steep upward — can't walk there
          return {
            x,
            y,
            vx: 0,
            vy: 0,
            landed: false,
            landingVy: 0,
            inWater: false,
          };
        }
        if (climb >= -WORM_MAX_CLIMB) {
          // Can walk: surface is within climbable range
          return {
            x: newX,
            y: newSurfaceY - halfH,
            vx: 0,
            vy: 0,
            landed: false,
            landingVy: 0,
            inWater: false,
          };
        }
        // Steep drop — walk forward and start falling
      }

      // No ground at target — check if there's a drop
      // Look further below for ground
      for (
        let sy = scanEndY;
        sy < Math.min(TERRAIN_HEIGHT, scanEndY + 40);
        sy++
      ) {
        if (getBitmapPixel(bitmap, targetX, sy)) {
          // There's ground not too far below — move there and let gravity handle it
          return {
            x: newX,
            y: sy - halfH,
            vx: 0,
            vy: 0,
            landed: false,
            landingVy: 0,
            inWater: false,
          };
        }
      }

      // No ground within reach — start falling
      return {
        x: newX,
        y,
        vx: 0,
        vy: 10, // small initial downward velocity to start falling
        landed: false,
        landingVy: 0,
        inWater: false,
      };
    }

    // Standing still on ground — check if body is embedded and push up if needed
    let adjustedY = y;
    if (getBitmapPixel(bitmap, Math.round(x), Math.round(y))) {
      // Center is inside terrain, push up to surface
      for (
        let sy = Math.round(y);
        sy >= Math.max(0, Math.round(y) - 30);
        sy--
      ) {
        if (!getBitmapPixel(bitmap, Math.round(x), sy)) {
          adjustedY = sy - halfH + 1;
          break;
        }
      }
    }
    return {
      x,
      y: adjustedY,
      vx: 0,
      vy: 0,
      landed: false,
      landingVy: 0,
      inWater: false,
    };
  }

  // Worm is airborne — apply physics
  vy += GRAVITY * dt;
  let newX = x + vx * dt; // no clamping — worms can fly off map edges
  let newY = y + vy * dt;

  // Check water
  if (newY + halfH >= WATER_LEVEL) {
    return {
      x: newX,
      y: WATER_LEVEL - halfH,
      vx: 0,
      vy: 0,
      landed: false,
      landingVy: 0,
      inWater: true,
    };
  }

  // --- Side collision: check if worm body hits terrain from the sides ---
  // Sample a few points along the worm's leading edge (direction of travel)
  const rx = Math.round(newX);
  const ry = Math.round(newY);
  if (vx !== 0) {
    const edgeX = Math.round(newX + (vx > 0 ? halfW : -halfW));
    // Check 3 body points on the leading side (top, middle, bottom-ish)
    const bodyChecks = [ry - halfH + 2, ry, ry + halfH - 4];
    let sideHit = false;
    for (const cy of bodyChecks) {
      if (
        cy >= 0 &&
        cy < TERRAIN_HEIGHT &&
        edgeX >= 0 &&
        edgeX < TERRAIN_WIDTH
      ) {
        if (getBitmapPixel(bitmap, edgeX, cy)) {
          sideHit = true;
          break;
        }
      }
    }
    if (sideHit) {
      // Stop horizontal movement, keep vertical
      newX = x;
      vx = -vx * 0.15; // tiny bounce-back
      if (Math.abs(vx) < 5) vx = 0;
    }
  }

  // --- Bottom collision: check if feet hit terrain ---
  const newFeetY = newY + halfH;
  if (
    newFeetY >= 0 &&
    newFeetY < TERRAIN_HEIGHT &&
    Math.round(newX) >= 0 &&
    Math.round(newX) < TERRAIN_WIDTH &&
    getBitmapPixel(bitmap, Math.round(newX), Math.round(newFeetY))
  ) {
    // Hit terrain — find exact surface
    let surfaceY = Math.round(newFeetY);
    for (
      let sy = Math.max(0, Math.round(y + halfH));
      sy <= Math.round(newFeetY);
      sy++
    ) {
      if (getBitmapPixel(bitmap, Math.round(newX), sy)) {
        surfaceY = sy;
        break;
      }
    }

    const landingVy = vy;

    // Apply ground friction to horizontal velocity
    let newVx = vx * WORM_FRICTION_GROUND;
    if (Math.abs(newVx) < 5) newVx = 0;

    // If still has significant horizontal velocity, keep sliding
    if (Math.abs(newVx) >= 5) {
      return {
        x: newX,
        y: surfaceY - halfH,
        vx: newVx,
        vy: -Math.abs(vy) * 0.2, // small bounce
        landed: true,
        landingVy,
        inWater: false,
      };
    }

    // Fully landed
    return {
      x: newX,
      y: surfaceY - halfH,
      vx: 0,
      vy: 0,
      landed: true,
      landingVy,
      inWater: false,
    };
  }

  // --- Head collision: check if top of worm hits terrain (e.g. ceiling) ---
  const headY = Math.round(newY - halfH);
  if (
    headY >= 0 &&
    headY < TERRAIN_HEIGHT &&
    Math.round(newX) >= 0 &&
    Math.round(newX) < TERRAIN_WIDTH &&
    vy < 0 &&
    getBitmapPixel(bitmap, Math.round(newX), headY)
  ) {
    // Bonk head on ceiling — stop upward, start falling
    newY = y;
    vy = Math.abs(vy) * 0.1;
    if (vy < 5) vy = 5;
  }

  // --- Push-out: if worm center is inside terrain, push up to surface ---
  if (
    Math.round(newX) >= 0 &&
    Math.round(newX) < TERRAIN_WIDTH &&
    Math.round(newY) >= 0 &&
    Math.round(newY) < TERRAIN_HEIGHT &&
    getBitmapPixel(bitmap, Math.round(newX), Math.round(newY))
  ) {
    // Worm center is embedded in terrain — push upward to find surface
    let pushY = Math.round(newY);
    for (let sy = pushY; sy >= Math.max(0, pushY - 30); sy--) {
      if (!getBitmapPixel(bitmap, Math.round(newX), sy)) {
        newY = sy - halfH + 1;
        vy = 0;
        break;
      }
    }
  }

  // Still airborne
  return {
    x: newX,
    y: newY,
    vx,
    vy,
    landed: false,
    landingVy: 0,
    inWater: false,
  };
}
