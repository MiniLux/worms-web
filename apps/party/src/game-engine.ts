import type {
  GameState,
  GameServerMessage,
  PlayerState,
  WormState,
  WeaponId,
  GameInitPayload,
  ExplosionEvent,
  DamageEvent,
  WormDeathEvent,
  TerrainDestructionEvent,
  TrajectoryPoint,
} from "@worms/shared";
import {
  DEFAULT_HP,
  DEFAULT_WORMS_PER_TEAM,
  DEFAULT_TURN_TIME,
  MAX_WIND,
  WATER_LEVEL,
  WORM_WIDTH,
  WORM_HEIGHT,
  WORM_WALK_SPEED,
  WORM_JUMP_VX,
  WORM_JUMP_VY,
  WORM_BACKFLIP_VX,
  WORM_BACKFLIP_VY,
  WEAPON_DEFINITIONS,
  MVP_WEAPON_IDS,
  simulateBallistic,
  computeKnockback,
  computeFallDamage,
  decodeBitmap,
  eraseCircleFromBitmap,
  encodeBitmap,
  getBitmapPixel,
  findSurfaceY,
  raycast,
} from "@worms/shared";
import { generateTerrain, getSpawnPoints } from "./terrain";
import type { SpawnPoint } from "./terrain";

// ─── Game Initialization ────────────────────────────────

export function initializeGame(payload: GameInitPayload): GameState {
  const seed = Date.now();
  const theme = payload.config.terrainTheme || "forest";
  const terrain = generateTerrain(seed, theme);
  const hp = payload.config.hp || DEFAULT_HP;
  const wormsPerTeam = payload.config.wormsPerTeam || DEFAULT_WORMS_PER_TEAM;
  const turnTime = payload.config.turnTime || DEFAULT_TURN_TIME;

  const bitmap = decodeBitmap(terrain.bitmap);
  const totalWorms = payload.players.length * wormsPerTeam;
  const spawnPoints = getSpawnPoints(bitmap, totalWorms);

  // Shuffle spawn points so teams are randomly interleaved across the map
  for (let i = spawnPoints.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [spawnPoints[i], spawnPoints[j]] = [spawnPoints[j], spawnPoints[i]];
  }

  let spawnCounter = 0;
  const players: PlayerState[] = payload.players.map((p, playerIdx) => {
    const worms: WormState[] = [];
    for (let w = 0; w < wormsPerTeam; w++) {
      const spawn = spawnPoints[spawnCounter] || {
        x: 100 + spawnCounter * 200,
        y: 300,
      };
      spawnCounter++;
      const customName = p.wormNames?.[w];
      worms.push({
        id: `${p.id}-worm-${w}`,
        name:
          customName && customName.trim() ? customName.trim() : `Worm ${w + 1}`,
        playerId: p.id,
        health: hp,
        x: spawn.x,
        y: spawn.y,
        vx: 0,
        vy: 0,
        facing: playerIdx % 2 === 0 ? "right" : "left",
        isAlive: true,
        isActive: false,
      });
    }

    // Initialize ammo for each weapon
    const ammo: Record<WeaponId, number> = {} as Record<WeaponId, number>;
    for (const wid of MVP_WEAPON_IDS) {
      const def = WEAPON_DEFINITIONS[wid];
      ammo[wid] = def.ammo; // -1 means infinite
    }

    return {
      id: p.id,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl,
      teamColor: p.teamColor,
      worms,
      ammo,
      isConnected: false,
      lastWormIndex: -1,
    };
  });

  // Set first worm of first player as active
  const firstWorm = players[0].worms[0];
  firstWorm.isActive = true;
  players[0].lastWormIndex = 0;

  const wind = generateWind();

  return {
    phase: "playing",
    players,
    activePlayerId: players[0].id,
    activeWormId: firstWorm.id,
    turnNumber: 1,
    turnTimeRemaining: turnTime,
    wind,
    terrain,
  };
}

// ─── Wind ───────────────────────────────────────────────

function generateWind(): number {
  return Math.round((Math.random() * 2 - 1) * MAX_WIND);
}

// ─── Turn Management ────────────────────────────────────

export function advanceTurn(state: GameState): GameServerMessage[] {
  const messages: GameServerMessage[] = [];

  // Deactivate current worm
  const currentWorm = findWorm(state, state.activeWormId);
  if (currentWorm) currentWorm.isActive = false;

  // Check for game over
  const alivePlayers = state.players.filter((p) =>
    p.worms.some((w) => w.isAlive),
  );

  if (alivePlayers.length <= 1) {
    state.phase = "finished";
    const winnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null;
    messages.push({
      type: "GAME_OVER",
      winnerId,
      reason: winnerId ? `${alivePlayers[0].displayName} wins!` : "Draw!",
    });
    return messages;
  }

  // Find next player (round-robin among alive players)
  const currentPlayerIdx = state.players.findIndex(
    (p) => p.id === state.activePlayerId,
  );
  let nextPlayerIdx = (currentPlayerIdx + 1) % state.players.length;

  // Skip players with no alive worms
  let attempts = 0;
  while (
    !state.players[nextPlayerIdx].worms.some((w) => w.isAlive) &&
    attempts < state.players.length
  ) {
    nextPlayerIdx = (nextPlayerIdx + 1) % state.players.length;
    attempts++;
  }

  const nextPlayer = state.players[nextPlayerIdx];

  // Find next alive worm for this player (round-robin using lastWormIndex)
  const aliveWorms = nextPlayer.worms.filter((w) => w.isAlive);
  if (aliveWorms.length === 0) {
    // Shouldn't happen given the check above, but just in case
    return advanceTurn(state);
  }

  // Pick next worm in sequence — advance from lastWormIndex
  // lastWormIndex is -1 when the player hasn't had a turn yet (picks worm 0 first)
  const lastIdx = nextPlayer.lastWormIndex ?? -1;
  let idx = (lastIdx + 1) % nextPlayer.worms.length;
  let safety = 0;
  while (!nextPlayer.worms[idx].isAlive && safety < nextPlayer.worms.length) {
    idx = (idx + 1) % nextPlayer.worms.length;
    safety++;
  }
  const nextWorm = nextPlayer.worms[idx];
  nextPlayer.lastWormIndex = idx;

  nextWorm.isActive = true;
  state.activePlayerId = nextPlayer.id;
  state.activeWormId = nextWorm.id;
  state.turnNumber++;
  state.wind = generateWind();
  state.turnTimeRemaining = DEFAULT_TURN_TIME;
  state.phase = "playing";

  messages.push({
    type: "TURN_START",
    activePlayerId: nextPlayer.id,
    activeWormId: nextWorm.id,
    wind: state.wind,
    turnTime: DEFAULT_TURN_TIME,
  });

  return messages;
}

// ─── Process Actions ────────────────────────────────────

export function processMove(
  state: GameState,
  direction: "left" | "right",
): GameServerMessage[] {
  const worm = findWorm(state, state.activeWormId);
  if (!worm || !worm.isAlive) return [];

  const bitmap = decodeBitmap(state.terrain.bitmap);
  const dx =
    direction === "left" ? -WORM_WALK_SPEED * 0.1 : WORM_WALK_SPEED * 0.1;
  const newX = Math.max(
    WORM_WIDTH / 2,
    Math.min(1920 - WORM_WIDTH / 2, worm.x + dx),
  );

  // Check if can walk (terrain below, air at new position)
  const headY = worm.y - WORM_HEIGHT / 2;
  const feetY = worm.y + WORM_HEIGHT / 2;
  const targetX = Math.round(newX);

  // Simple ground-following: find surface at target X
  let surfaceY = -1;
  for (let y = Math.round(headY - 10); y < Math.round(feetY + 20); y++) {
    if (y >= 0 && getBitmapPixel(bitmap, targetX, y)) {
      surfaceY = y;
      break;
    }
  }

  if (surfaceY >= 0 && surfaceY - worm.y < 12) {
    // Can walk: step up small inclines
    worm.x = newX;
    worm.y = surfaceY - WORM_HEIGHT / 2;
  } else if (surfaceY < 0) {
    // No ground at target — check below for a longer drop (don't walk off cliffs during move)
    // Allow move only if there's ground within a short distance below
    for (let y = Math.round(feetY); y < Math.round(feetY + 40); y++) {
      if (y >= 0 && y < WATER_LEVEL && getBitmapPixel(bitmap, targetX, y)) {
        worm.x = newX;
        worm.y = y - WORM_HEIGHT / 2;
        break;
      }
    }
  }

  worm.facing = direction;

  return [
    {
      type: "WORM_MOVED",
      wormId: worm.id,
      x: worm.x,
      y: worm.y,
      facing: worm.facing,
    },
  ];
}

export function processJump(
  state: GameState,
  kind: "forward" | "backflip",
): GameServerMessage[] {
  const worm = findWorm(state, state.activeWormId);
  if (!worm || !worm.isAlive) return [];

  // Only allow jump if worm is on the ground (not airborne or being knocked back)
  if (Math.abs(worm.vy) > 5 || Math.abs(worm.vx) > 10) return [];
  // Don't allow jump if one is already pending
  if (worm.pendingJump) return [];

  let vx: number;
  let vy: number;

  if (kind === "backflip") {
    vx = worm.facing === "right" ? WORM_BACKFLIP_VX : -WORM_BACKFLIP_VX;
    vy = WORM_BACKFLIP_VY;
  } else {
    vx = worm.facing === "right" ? WORM_JUMP_VX : -WORM_JUMP_VX;
    vy = WORM_JUMP_VY;
  }

  // Store pending jump — velocity applied after delay so animation can play
  worm.pendingJump = { vx, vy, delayMs: 300 };

  return [{ type: "WORM_JUMPED", wormId: worm.id, vx, vy, kind }];
}

export function processFire(
  state: GameState,
  weaponId: WeaponId,
  angle: number,
  power: number,
  fuseMs?: number,
): GameServerMessage[] {
  const worm = findWorm(state, state.activeWormId);
  if (!worm || !worm.isAlive) return [];

  const player = state.players.find((p) => p.id === state.activePlayerId);
  if (!player) return [];

  const def = WEAPON_DEFINITIONS[weaponId];
  if (!def) return [];

  // Check ammo
  if (player.ammo[weaponId] === 0) return [];
  if (player.ammo[weaponId] > 0) {
    player.ammo[weaponId]--;
  }

  const bitmap = decodeBitmap(state.terrain.bitmap);

  // Fire position: slightly in front of worm
  const fireOffsetX = Math.cos(angle) * 20;
  const fireOffsetY = Math.sin(angle) * 20;
  const startX = worm.x + fireOffsetX;
  const startY = worm.y + fireOffsetY;

  // Build worm hitbox list (exclude firing worm)
  const targetWorms = state.players
    .flatMap((p) => p.worms)
    .filter((w) => w.isAlive && w.id !== worm.id)
    .map((w) => ({
      id: w.id,
      x: w.x,
      y: w.y,
      width: WORM_WIDTH,
      height: WORM_HEIGHT,
    }));

  // Use client-specified fuse time if provided (grenade timer), otherwise weapon default
  const effectiveFuseMs = fuseMs !== undefined ? fuseMs : def.fuseTime;

  const result = simulateBallistic(
    startX,
    startY,
    angle,
    power,
    state.wind,
    bitmap,
    effectiveFuseMs,
    def.bounceElasticity,
    def.affectedByWind,
    targetWorms,
  );

  const messages: GameServerMessage[] = [];
  const explosions: ExplosionEvent[] = [];
  const terrainDestruction: TerrainDestructionEvent[] = [];
  const damages: DamageEvent[] = [];
  const deaths: WormDeathEvent[] = [];

  // If hit terrain, water, or fuse — explode
  if (result.hitType !== "outofbounds" && def.explosionRadius > 0) {
    const ex = result.impactX;
    const ey = result.impactY;
    const radius = def.explosionRadius;

    explosions.push({ x: ex, y: ey, radius });
    terrainDestruction.push({ x: ex, y: ey, radius });

    // Destroy terrain
    eraseCircleFromBitmap(bitmap, ex, ey, radius);
    state.terrain.bitmap = encodeBitmap(bitmap);

    // Damage worms in radius — defer knockback until projectile arrives
    const flightDelayMs = result.impactTime;
    for (const p of state.players) {
      for (const w of p.worms) {
        if (!w.isAlive) continue;
        const kb = computeKnockback(
          w.x,
          w.y,
          ex,
          ey,
          radius,
          def.damage,
          def.knockbackMultiplier,
        );
        if (kb.damage > 0) {
          // Store pending knockback as a server safety net.
          // The client sends APPLY_KNOCKBACK after the projectile animation
          // finishes, which triggers immediate application. The large delay
          // here is only a fallback in case the message is lost.
          w.pendingKnockback = {
            vx: kb.vx,
            vy: kb.vy,
            damage: kb.damage,
            delayMs: flightDelayMs + 5000,
          };
          damages.push({
            wormId: w.id,
            damage: kb.damage,
            newHealth: Math.max(0, w.health - kb.damage),
            knockbackVx: kb.vx,
            knockbackVy: kb.vy,
          });
        }
      }
    }
  }

  // Water/knockback deaths are handled by the physics loop now
  // (worms with vx/vy will be simulated and killed if they hit water)

  messages.push({
    type: "FIRE_RESULT",
    trajectory: result.trajectory,
    weaponId,
    fuseMs: effectiveFuseMs > 0 ? effectiveFuseMs : undefined,
    explosions,
    terrainDestruction,
    damages,
    deaths,
  });

  // Don't set phase to retreat here — the server waits for physics to settle first

  return messages;
}

export function processHitscan(
  state: GameState,
  weaponId: WeaponId,
  angle: number,
  shotsRemaining: number,
): GameServerMessage[] {
  const worm = findWorm(state, state.activeWormId);
  if (!worm || !worm.isAlive) return [];

  const player = state.players.find((p) => p.id === state.activePlayerId);
  if (!player) return [];

  const def = WEAPON_DEFINITIONS[weaponId];
  if (!def || def.type !== "hitscan") return [];

  const bitmap = decodeBitmap(state.terrain.bitmap);

  const wormTargets = state.players.flatMap((p) =>
    p.worms
      .filter((w) => w.isAlive)
      .map((w) => ({
        id: w.id,
        x: w.x,
        y: w.y,
        width: WORM_WIDTH,
        height: WORM_HEIGHT,
        alive: w.isAlive,
      })),
  );

  const hit = raycast(
    worm.x,
    worm.y,
    angle,
    bitmap,
    wormTargets,
    1500,
    worm.id,
  );

  const explosions: ExplosionEvent[] = [];
  const terrainDestruction: TerrainDestructionEvent[] = [];
  const damages: DamageEvent[] = [];
  const deaths: WormDeathEvent[] = [];

  if (hit.hitType === "terrain" && def.explosionRadius > 0) {
    explosions.push({ x: hit.hitX, y: hit.hitY, radius: def.explosionRadius });
    terrainDestruction.push({
      x: hit.hitX,
      y: hit.hitY,
      radius: def.explosionRadius,
    });
    eraseCircleFromBitmap(bitmap, hit.hitX, hit.hitY, def.explosionRadius);
    state.terrain.bitmap = encodeBitmap(bitmap);
  }

  if (hit.hitWormId) {
    const targetWorm = findWorm(state, hit.hitWormId);
    if (targetWorm) {
      const kb = computeKnockback(
        targetWorm.x,
        targetWorm.y,
        hit.hitX,
        hit.hitY,
        30,
        def.damage,
        def.knockbackMultiplier,
      );
      targetWorm.health = Math.max(0, targetWorm.health - kb.damage);
      targetWorm.vx += kb.vx;
      targetWorm.vy += kb.vy;
      damages.push({
        wormId: targetWorm.id,
        damage: kb.damage,
        newHealth: targetWorm.health,
        knockbackVx: kb.vx,
        knockbackVy: kb.vy,
      });
      if (targetWorm.health <= 0) {
        targetWorm.isAlive = false;
        deaths.push({ wormId: targetWorm.id, cause: "hp" });
      }
    }
  }

  // shotsRemaining is passed in from the server which tracks the count

  return [
    {
      type: "HITSCAN_RESULT",
      weaponId,
      fromX: worm.x,
      fromY: worm.y,
      toX: hit.hitX,
      toY: hit.hitY,
      hitWormId: hit.hitWormId,
      explosions,
      terrainDestruction,
      damages,
      deaths,
      shotsRemaining,
    },
  ];
}

export function processMelee(
  state: GameState,
  weaponId: WeaponId,
  direction: "left" | "right",
): GameServerMessage[] {
  const worm = findWorm(state, state.activeWormId);
  if (!worm || !worm.isAlive) return [];

  const def = WEAPON_DEFINITIONS[weaponId];
  if (!def || def.type !== "melee") return [];

  const damages: DamageEvent[] = [];
  const deaths: WormDeathEvent[] = [];

  // Melee: check worms within close range
  const meleeRange = 30;
  const meleeDir = direction === "right" ? 1 : -1;

  for (const p of state.players) {
    for (const w of p.worms) {
      if (!w.isAlive || w.id === worm.id) continue;
      const dx = w.x - worm.x;
      const dy = w.y - worm.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Check if target is in melee range and in the right direction
      if (dist <= meleeRange && dx * meleeDir >= 0) {
        w.health = Math.max(0, w.health - def.damage);
        // Fire punch: knockback upward
        const kbVx = meleeDir * 150 * def.knockbackMultiplier;
        const kbVy = -200 * def.knockbackMultiplier;
        w.vx += kbVx;
        w.vy += kbVy;
        damages.push({
          wormId: w.id,
          damage: def.damage,
          newHealth: w.health,
          knockbackVx: kbVx,
          knockbackVy: kbVy,
        });
        if (w.health <= 0) {
          w.isAlive = false;
          deaths.push({ wormId: w.id, cause: "hp" });
        }
      }
    }
  }

  // Fire punch: punching worm jumps straight up (like original Worms)
  if (weaponId === "fire_punch") {
    worm.vy = -200;
  }

  // Don't set phase to retreat here — the server waits for physics to settle first

  return [{ type: "MELEE_RESULT", weaponId, damages, deaths }];
}

export function processTeleport(
  state: GameState,
  targetX: number,
  targetY: number,
): GameServerMessage[] {
  const worm = findWorm(state, state.activeWormId);
  if (!worm || !worm.isAlive) return [];

  const player = state.players.find((p) => p.id === state.activePlayerId);
  if (!player) return [];

  // Check ammo
  if (player.ammo.teleport === 0) return [];
  if (player.ammo.teleport > 0) {
    player.ammo.teleport--;
  }

  // Clamp to terrain bounds
  const x = Math.max(WORM_WIDTH, Math.min(1920 - WORM_WIDTH, targetX));
  let y = Math.max(WORM_HEIGHT, Math.min(WATER_LEVEL - WORM_HEIGHT, targetY));

  // Prevent teleporting into solid ground — find the surface above the click point
  const bitmap = decodeBitmap(state.terrain.bitmap);
  const feetY = Math.round(y + WORM_HEIGHT / 2);
  if (
    feetY >= 0 &&
    feetY < WATER_LEVEL &&
    getBitmapPixel(bitmap, Math.round(x), feetY)
  ) {
    // Click is inside terrain — scan upward to find open air
    let surfaceY = feetY;
    for (let sy = feetY; sy >= 0; sy--) {
      if (!getBitmapPixel(bitmap, Math.round(x), sy)) {
        surfaceY = sy;
        break;
      }
    }
    y = surfaceY - WORM_HEIGHT / 2;
  }

  worm.x = x;
  worm.y = y;
  worm.vx = 0;
  // Give a tiny downward velocity so the physics loop drops the worm to the ground
  worm.vy = 2;

  return [{ type: "TELEPORT_RESULT", wormId: worm.id, x, y }];
}

// ─── Helpers ────────────────────────────────────────────

function findWorm(state: GameState, wormId: string): WormState | undefined {
  for (const p of state.players) {
    for (const w of p.worms) {
      if (w.id === wormId) return w;
    }
  }
  return undefined;
}

export function checkGameOver(state: GameState): GameServerMessage | null {
  const alivePlayers = state.players.filter((p) =>
    p.worms.some((w) => w.isAlive),
  );

  if (alivePlayers.length <= 1) {
    state.phase = "finished";
    const winnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null;
    return {
      type: "GAME_OVER",
      winnerId,
      reason: winnerId
        ? `${alivePlayers[0].displayName} wins!`
        : "It's a draw!",
    };
  }

  return null;
}
