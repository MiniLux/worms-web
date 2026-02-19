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
  const windForce = affectedByWind ? wind * 1.0 : 0;

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

    // Check out of bounds (sides and top)
    if (x < -50 || x > TERRAIN_WIDTH + 50 || y < -200) {
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

    // Check terrain collision
    if (
      Math.round(x) >= 0 &&
      Math.round(x) < TERRAIN_WIDTH &&
      Math.round(y) >= 0 &&
      Math.round(y) < TERRAIN_HEIGHT &&
      getBitmapPixel(bitmap, Math.round(x), Math.round(y))
    ) {
      if (bounceElasticity > 0) {
        const prevX = trajectory[trajectory.length - 2]?.x ?? x;
        const prevY = trajectory[trajectory.length - 2]?.y ?? y;

        // Determine if it's a wall or floor hit by checking adjacent pixels
        const rx = Math.round(x);
        const ry = Math.round(y);
        const hitBelow =
          ry + 1 < TERRAIN_HEIGHT && getBitmapPixel(bitmap, rx, ry + 1);
        const hitAbove = ry - 1 >= 0 && getBitmapPixel(bitmap, rx, ry - 1);
        const hitLeft = rx - 1 >= 0 && getBitmapPixel(bitmap, rx - 1, ry);
        const hitRight =
          rx + 1 < TERRAIN_WIDTH && getBitmapPixel(bitmap, rx + 1, ry);

        const verticalWall = (hitLeft || hitRight) && !hitAbove && !hitBelow;
        const horizontalFloor = (hitAbove || hitBelow) && !hitLeft && !hitRight;

        // Back up to previous position
        x = prevX;
        y = prevY;
        trajectory[trajectory.length - 1] = {
          x: Math.round(x),
          y: Math.round(y),
          t,
        };

        if (verticalWall) {
          // Wall hit: reverse horizontal velocity
          vx = -vx * bounceElasticity;
          vy = vy * bounceElasticity;
        } else if (horizontalFloor) {
          // Floor/ceiling hit: reverse vertical velocity
          vx = vx * bounceElasticity;
          vy = -vy * bounceElasticity;
        } else {
          // Corner or ambiguous: reverse both
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
        // Too steep — can't walk there
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

    // Standing still on ground
    return { x, y, vx: 0, vy: 0, landed: false, landingVy: 0, inWater: false };
  }

  // Worm is airborne — apply physics
  vy += GRAVITY * dt;
  const newX = Math.max(halfW, Math.min(TERRAIN_WIDTH - halfW, x + vx * dt));
  const newY = y + vy * dt;

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

  // Check terrain collision at new position
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
        landed: false,
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
