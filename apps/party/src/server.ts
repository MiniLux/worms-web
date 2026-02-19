import type * as Party from "partykit/server";
import type {
  GameState,
  GameClientMessage,
  GameServerMessage,
  GameInitPayload,
  WeaponId,
} from "@worms/shared";
import {
  DEFAULT_RETREAT_TIME,
  DEFAULT_TURN_TIME,
  PHYSICS_STEP_MS,
  WORM_WIDTH,
  WORM_HEIGHT,
  WEAPON_DEFINITIONS,
  DEATH_EXPLOSION_RADIUS,
  DEATH_EXPLOSION_DAMAGE,
  decodeBitmap,
  encodeBitmap,
  eraseCircleFromBitmap,
  simulateWormStep,
  computeFallDamage,
  computeKnockback,
} from "@worms/shared";
import {
  initializeGame,
  advanceTurn,
  processJump,
  processFire,
  processHitscan,
  processMelee,
  processTeleport,
  checkGameOver,
} from "./game-engine";

export default class GameServer implements Party.Server {
  private state: GameState | null = null;
  private playerConnections: Map<string, Party.Connection> = new Map();
  private pendingJoins: Array<{ playerId: string; conn: Party.Connection }> =
    [];

  // Physics loop
  private physicsInterval: ReturnType<typeof setInterval> | null = null;
  private lastPhysicsTick: number = 0;
  private cachedBitmap: Uint8Array | null = null;

  // Movement
  private movingDirection: "left" | "right" | null = null;

  // Shotgun tracking
  private shotsFiredThisTurn: number = 0;

  // Wait for all worm physics to settle before checking game over
  private waitingForPhysicsSettle: boolean = false;

  constructor(readonly room: Party.Room) {}

  // ─── HTTP: Game Initialization ─────────────────────────

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === "POST") {
      const url = new URL(req.url);
      if (url.pathname === "/init") {
        try {
          const payload = (await req.json()) as GameInitPayload;
          this.state = initializeGame(payload);
          this.invalidateBitmapCache();
          return new Response("OK", { status: 200 });
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }
      }
    }
    return new Response("Not found", { status: 404 });
  }

  // ─── WebSocket Lifecycle ───────────────────────────────

  onConnect(_conn: Party.Connection, _ctx: Party.ConnectionContext): void {
    // Wait for JOIN_GAME message
  }

  onClose(conn: Party.Connection): void {
    for (const [playerId, c] of this.playerConnections) {
      if (c === conn) {
        this.playerConnections.delete(playerId);
        if (this.state) {
          const player = this.state.players.find((p) => p.id === playerId);
          if (player) {
            player.isConnected = false;
            this.broadcastAll({ type: "PLAYER_DISCONNECTED", playerId });
            if (this.state.activePlayerId === playerId) {
              this.room.storage.setAlarm(Date.now() + 10000);
            }
          }
        }
        break;
      }
    }
  }

  onMessage(message: string, sender: Party.Connection): void {
    let msg: GameClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    // INIT_GAME and JOIN_GAME must work before state exists
    switch (msg.type) {
      case "INIT_GAME":
        this.handleInitGame(msg.payload, sender);
        return;
      case "JOIN_GAME":
        this.handleJoinGame(msg.playerId, sender);
        return;
    }

    if (!this.state) return;

    switch (msg.type) {
      case "MOVE_START":
        this.handleMoveStart(msg.direction, sender);
        break;
      case "MOVE_STOP":
        this.handleMoveStop(sender);
        break;
      case "MOVE":
        // Legacy per-frame move — treat as MOVE_START (will be stopped by MOVE_STOP or next tick)
        this.handleMoveStart(msg.direction, sender);
        break;
      case "STOP_MOVE":
        this.handleMoveStop(sender);
        break;
      case "JUMP":
        this.handleJump(msg.kind, sender);
        break;
      case "SELECT_WEAPON":
        this.handleSelectWeapon(msg.weaponId, sender);
        break;
      case "FIRE":
        this.handleFire(msg.weaponId, msg.angle, msg.power, sender, msg.fuseMs);
        break;
      case "FIRE_HITSCAN":
        this.handleHitscan(msg.weaponId, msg.angle, sender);
        break;
      case "FIRE_MELEE":
        this.handleMelee(msg.weaponId, msg.direction, sender);
        break;
      case "USE_TELEPORT":
        this.handleTeleport(msg.x, msg.y, sender);
        break;
      case "SKIP_TURN":
        this.handleSkipTurn(sender);
        break;
      case "PAUSE_TIMER":
        this.handlePauseTimer(sender);
        break;
      case "APPLY_KNOCKBACK":
        this.handleApplyKnockback(sender);
        break;
      case "AIM":
        this.handleAim(msg.angle, sender);
        break;
      case "CHAT":
        this.handleChat(msg.text, sender);
        break;
    }
  }

  // ─── Alarm (Turn Timer) ────────────────────────────────

  async onAlarm(): Promise<void> {
    if (!this.state || this.state.phase === "finished") return;

    if (this.state.phase === "retreat") {
      this.movingDirection = null;
      this.stopPhysicsLoop();

      const messages = advanceTurn(this.state);
      for (const m of messages) this.broadcastAll(m);

      if ((this.state.phase as string) === "playing") {
        this.shotsFiredThisTurn = 0;
        this.startPhysicsLoop();
        this.room.storage.setAlarm(
          Date.now() + this.state.turnTimeRemaining * 1000,
        );
        this.checkCpuTurn();
      }
      return;
    }

    if (this.state.phase === "playing") {
      this.movingDirection = null;
      this.state.phase = "retreat";
      this.broadcastAll({
        type: "RETREAT_START",
        timeMs: DEFAULT_RETREAT_TIME * 1000,
      });
      this.room.storage.setAlarm(Date.now() + DEFAULT_RETREAT_TIME * 1000);
    }
  }

  // ─── Physics Loop ──────────────────────────────────────

  private startPhysicsLoop(): void {
    if (this.physicsInterval) return;
    this.lastPhysicsTick = Date.now();
    this.physicsInterval = setInterval(() => {
      this.physicsTick();
    }, PHYSICS_STEP_MS);
  }

  private stopPhysicsLoop(): void {
    if (this.physicsInterval) {
      clearInterval(this.physicsInterval);
      this.physicsInterval = null;
    }
  }

  private physicsTick(): void {
    if (!this.state || this.state.phase === "finished") {
      this.stopPhysicsLoop();
      return;
    }

    const now = Date.now();
    const dt = Math.min((now - this.lastPhysicsTick) / 1000, 0.05); // cap at 50ms
    this.lastPhysicsTick = now;

    if (dt <= 0) return;

    const bitmap = this.getBitmap();
    if (!bitmap) return;

    const updates: Array<{
      wormId: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      facing: "left" | "right";
    }> = [];

    let anySettling = false;

    for (const player of this.state.players) {
      for (const worm of player.worms) {
        if (!worm.isAlive) continue;

        // Count down pending jump delay
        if (worm.pendingJump) {
          worm.pendingJump.delayMs -= dt * 1000;
          if (worm.pendingJump.delayMs <= 0) {
            worm.vx = worm.pendingJump.vx;
            worm.vy = worm.pendingJump.vy;
            worm.pendingJump = undefined;
          }
        }

        // Worms with pendingKnockback are "frozen" — skip physics entirely.
        // The client will send APPLY_KNOCKBACK after the projectile animation
        // finishes, which triggers immediate application. The timer here is
        // only a safety net in case the message is lost.
        if (worm.pendingKnockback) {
          worm.pendingKnockback.delayMs -= dt * 1000;
          if (worm.pendingKnockback.delayMs <= 0) {
            const kb = worm.pendingKnockback;
            worm.health = Math.max(0, worm.health - kb.damage);
            worm.vx += kb.vx;
            worm.vy += kb.vy;
            if (worm.health <= 0) {
              worm.isAlive = false;
              this.broadcastAll({
                type: "WORM_DIED",
                wormId: worm.id,
                cause: "hp",
              });
              this.processDeathExplosion(worm.id);
            }
            worm.pendingKnockback = undefined;
          } else {
            // Still waiting — freeze this worm in place (don't simulate gravity
            // or movement even if terrain was destroyed underneath)
            continue;
          }
        }

        const isActiveWorm = worm.id === this.state.activeWormId;
        const isWalking =
          isActiveWorm &&
          this.movingDirection !== null &&
          (this.state.phase === "playing" || this.state.phase === "retreat");
        const walkDir =
          isWalking && this.movingDirection === "left"
            ? -1
            : isWalking && this.movingDirection === "right"
              ? 1
              : 0;

        // Check if worm needs physics processing
        const hasVelocity = Math.abs(worm.vx) >= 1 || Math.abs(worm.vy) >= 1;
        const hasPending = !!worm.pendingJump;
        if (!isWalking && !hasVelocity && !hasPending) continue;

        if (hasVelocity) anySettling = true;

        const result = simulateWormStep(
          worm.x,
          worm.y,
          worm.vx,
          worm.vy,
          dt,
          bitmap,
          isWalking,
          walkDir,
        );

        // Check worm-to-worm collision (block walking through other worms)
        // Use a tight hitbox (half-width) so worms can move close together
        if (isWalking) {
          let blocked = false;
          for (const op of this.state.players) {
            for (const ow of op.worms) {
              if (!ow.isAlive || ow.id === worm.id) continue;
              const dx = Math.abs(result.x - ow.x);
              const dy = Math.abs(result.y - ow.y);
              if (dx < WORM_WIDTH * 0.5 && dy < WORM_HEIGHT) {
                blocked = true;
                break;
              }
            }
            if (blocked) break;
          }
          if (blocked) {
            result.x = worm.x;
            result.y = worm.y;
            result.vx = 0;
            result.vy = 0;
          }
        }

        // Update worm state
        const posChanged =
          Math.abs(worm.x - result.x) > 0.1 ||
          Math.abs(worm.y - result.y) > 0.1;
        const velChanged =
          Math.abs(worm.vx - result.vx) > 2 ||
          Math.abs(worm.vy - result.vy) > 2;
        worm.x = result.x;
        worm.y = result.y;
        worm.vx = result.vx;
        worm.vy = result.vy;
        if (walkDir !== 0) {
          worm.facing = walkDir > 0 ? "right" : "left";
        }

        if (posChanged || velChanged || isWalking) {
          updates.push({
            wormId: worm.id,
            x: worm.x,
            y: worm.y,
            vx: worm.vx,
            vy: worm.vy,
            facing: worm.facing,
          });
        }

        // Handle water death
        if (result.inWater) {
          worm.isAlive = false;
          worm.vx = 0;
          worm.vy = 0;
          this.broadcastAll({ type: "WORM_FELL_IN_WATER", wormId: worm.id });

          // End the turn if the active worm drowned
          if (isActiveWorm && this.state!.phase === "playing") {
            this.movingDirection = null;
            this.waitingForPhysicsSettle = true;
          }
        }

        // Handle landing
        if (result.landed && Math.abs(result.landingVy) > 0) {
          const fallDamage = computeFallDamage(Math.abs(result.landingVy));
          if (fallDamage > 0) {
            worm.health = Math.max(0, worm.health - fallDamage);
            this.broadcastAll({
              type: "WORM_LANDED",
              wormId: worm.id,
              x: worm.x,
              y: worm.y,
              fallDamage,
              newHealth: worm.health,
            });
            if (worm.health <= 0) {
              worm.isAlive = false;
              this.processDeathExplosion(worm.id);
            }
            // If the active worm takes fall damage, end their turn
            if (isActiveWorm && this.state!.phase === "playing") {
              this.movingDirection = null;
              this.waitingForPhysicsSettle = true;
            }
          }
        }
      }
    }

    // Broadcast position updates
    if (updates.length > 0) {
      this.broadcastAll({ type: "WORM_PHYSICS_UPDATE", updates });
    }

    // Check if physics has settled after a weapon fire
    if (this.waitingForPhysicsSettle && !anySettling) {
      // Recheck — make sure NO worm has velocity
      const allSettled = this.state.players.every((p) =>
        p.worms.every(
          (w) => !w.isAlive || (Math.abs(w.vx) < 1 && Math.abs(w.vy) < 1),
        ),
      );

      if (allSettled) {
        this.waitingForPhysicsSettle = false;

        const gameOver = checkGameOver(this.state);
        if (gameOver) {
          this.broadcastAll(gameOver);
          this.stopPhysicsLoop();
          return;
        }

        // Enter retreat phase
        this.state.phase = "retreat";
        this.broadcastAll({
          type: "RETREAT_START",
          timeMs: DEFAULT_RETREAT_TIME * 1000,
        });
        this.room.storage.setAlarm(Date.now() + DEFAULT_RETREAT_TIME * 1000);
      }
    }
  }

  // ─── Bitmap Cache ──────────────────────────────────────

  private getBitmap(): Uint8Array | null {
    if (!this.state) return null;
    if (!this.cachedBitmap) {
      this.cachedBitmap = decodeBitmap(this.state.terrain.bitmap);
    }
    return this.cachedBitmap;
  }

  private invalidateBitmapCache(): void {
    this.cachedBitmap = null;
  }

  private syncBitmapToState(): void {
    if (this.cachedBitmap && this.state) {
      this.state.terrain.bitmap = encodeBitmap(this.cachedBitmap);
    }
  }

  // ─── Handlers ──────────────────────────────────────────

  private isCpuPlayer(playerId: string): boolean {
    return playerId.startsWith("cpu-");
  }

  /** After a turn advances, check if the new active player is CPU and auto-skip */
  private checkCpuTurn(): void {
    if (!this.state || this.state.phase !== "playing") return;
    if (!this.isCpuPlayer(this.state.activePlayerId)) return;

    // CPU turn: wait a short moment then skip
    setTimeout(() => {
      if (!this.state || this.state.phase !== "playing") return;
      if (!this.isCpuPlayer(this.state.activePlayerId)) return;

      this.movingDirection = null;
      this.broadcastAll({ type: "TURN_END" });
      this.stopPhysicsLoop();

      const messages = advanceTurn(this.state);
      for (const m of messages) this.broadcastAll(m);

      if (this.state.phase === "playing") {
        this.shotsFiredThisTurn = 0;
        this.startPhysicsLoop();
        this.room.storage.setAlarm(
          Date.now() + this.state.turnTimeRemaining * 1000,
        );
        this.checkCpuTurn();
      }
    }, 1500);
  }

  private handleInitGame(
    payload: GameInitPayload,
    conn: Party.Connection,
  ): void {
    if (this.state) return;
    try {
      this.state = initializeGame(payload);
      this.invalidateBitmapCache();

      // Mark CPU players as connected
      for (const player of this.state.players) {
        if (this.isCpuPlayer(player.id)) {
          player.isConnected = true;
        }
      }

      for (const pending of this.pendingJoins) {
        this.handleJoinGame(pending.playerId, pending.conn);
      }
      this.pendingJoins = [];
    } catch {
      conn.send(
        JSON.stringify({
          type: "ERROR",
          message: "Failed to initialize game",
        } satisfies GameServerMessage),
      );
    }
  }

  private handleJoinGame(playerId: string, conn: Party.Connection): void {
    if (!this.state) {
      this.pendingJoins.push({ playerId, conn });
      return;
    }

    const player = this.state.players.find((p) => p.id === playerId);
    if (!player) {
      conn.send(
        JSON.stringify({
          type: "ERROR",
          message: "Not a player in this game",
        } satisfies GameServerMessage),
      );
      return;
    }

    player.isConnected = true;
    this.playerConnections.set(playerId, conn);

    conn.send(
      JSON.stringify({
        type: "GAME_STATE_SYNC",
        state: this.state,
      } satisfies GameServerMessage),
    );

    this.broadcastAll({ type: "PLAYER_RECONNECTED", playerId }, playerId);

    const allConnected = this.state.players.every((p) => p.isConnected);
    if (allConnected && this.state.turnNumber === 1) {
      this.broadcastAll({
        type: "TURN_START",
        activePlayerId: this.state.activePlayerId,
        activeWormId: this.state.activeWormId,
        wind: this.state.wind,
        turnTime: this.state.turnTimeRemaining,
      });
      this.startPhysicsLoop();
      this.room.storage.setAlarm(
        Date.now() + this.state.turnTimeRemaining * 1000,
      );
      this.checkCpuTurn();
    }
  }

  private isActivePlayer(conn: Party.Connection): boolean {
    if (!this.state) return false;
    if (this.state.phase !== "playing" && this.state.phase !== "retreat")
      return false;
    for (const [playerId, c] of this.playerConnections) {
      if (c === conn && playerId === this.state.activePlayerId) return true;
    }
    return false;
  }

  private canFire(conn: Party.Connection): boolean {
    if (!this.state || this.state.phase !== "playing") return false;
    for (const [playerId, c] of this.playerConnections) {
      if (c === conn && playerId === this.state.activePlayerId) return true;
    }
    return false;
  }

  private handleMoveStart(
    direction: "left" | "right",
    conn: Party.Connection,
  ): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    this.movingDirection = direction;
    this.broadcastAll({
      type: "WORM_WALKING",
      wormId: this.state.activeWormId,
      isWalking: true,
    });
  }

  private handleMoveStop(conn: Party.Connection): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    this.movingDirection = null;
    this.broadcastAll({
      type: "WORM_WALKING",
      wormId: this.state.activeWormId,
      isWalking: false,
    });
  }

  private handleJump(
    kind: "forward" | "backflip",
    conn: Party.Connection,
  ): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    this.movingDirection = null; // Stop walking when jumping
    const messages = processJump(this.state, kind);
    for (const m of messages) this.broadcastAll(m);
  }

  private handleFire(
    weaponId: string,
    angle: number,
    power: number,
    conn: Party.Connection,
    fuseMs?: number,
  ): void {
    if (!this.canFire(conn) || !this.state) return;
    this.movingDirection = null;

    const messages = processFire(
      this.state,
      weaponId as WeaponId,
      angle,
      Math.max(0, Math.min(1, power)),
      fuseMs,
    );
    for (const m of messages) this.broadcastAll(m);

    // Invalidate bitmap cache since terrain may have been destroyed
    this.invalidateBitmapCache();

    // Don't check game over immediately — wait for physics to settle
    // (knocked back worms might fall in water or take fall damage)
    this.waitingForPhysicsSettle = true;
  }

  private handleHitscan(
    weaponId: string,
    angle: number,
    conn: Party.Connection,
  ): void {
    if (!this.canFire(conn) || !this.state) return;

    const def = WEAPON_DEFINITIONS[weaponId as WeaponId];
    if (!def) return;

    // Hard limit on shots per turn
    const maxShots = def.shotsPerTurn || 1;
    if (this.shotsFiredThisTurn >= maxShots) return;

    this.shotsFiredThisTurn++;
    const shotsRemaining = maxShots - this.shotsFiredThisTurn;

    const messages = processHitscan(
      this.state,
      weaponId as WeaponId,
      angle,
      shotsRemaining,
    );
    for (const m of messages) this.broadcastAll(m);

    this.invalidateBitmapCache();

    // If shots remain, let the player keep aiming
    if (shotsRemaining > 0) return;

    // All shots used — wait for physics to settle
    this.waitingForPhysicsSettle = true;
  }

  private handleMelee(
    weaponId: string,
    direction: "left" | "right",
    conn: Party.Connection,
  ): void {
    if (!this.canFire(conn) || !this.state) return;
    this.movingDirection = null;

    const messages = processMelee(this.state, weaponId as WeaponId, direction);
    for (const m of messages) this.broadcastAll(m);

    this.waitingForPhysicsSettle = true;
  }

  private handleTeleport(x: number, y: number, conn: Party.Connection): void {
    if (!this.canFire(conn) || !this.state) return;
    this.movingDirection = null;

    const messages = processTeleport(this.state, x, y);
    if (messages.length === 0) return; // Teleport failed (e.g. no ammo)
    for (const m of messages) this.broadcastAll(m);

    // Worm has a small vy so physics loop will drop it to the ground,
    // then enter retreat once it settles
    this.waitingForPhysicsSettle = true;
  }

  private handlePauseTimer(conn: Party.Connection): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    if (this.state.phase !== "playing") return;
    // Cancel the turn timer alarm — player is charging a shot
    this.room.storage.deleteAlarm();
  }

  private handleSkipTurn(conn: Party.Connection): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    this.movingDirection = null;

    this.broadcastAll({ type: "TURN_END" });
    this.stopPhysicsLoop();

    const messages = advanceTurn(this.state);
    for (const m of messages) this.broadcastAll(m);

    if (this.state.phase === "playing") {
      this.shotsFiredThisTurn = 0;
      this.startPhysicsLoop();
      this.room.storage.setAlarm(
        Date.now() + this.state.turnTimeRemaining * 1000,
      );
      this.checkCpuTurn();
    }
  }

  private handleApplyKnockback(_conn: Party.Connection): void {
    if (!this.state) return;

    for (const player of this.state.players) {
      for (const worm of player.worms) {
        if (!worm.isAlive || !worm.pendingKnockback) continue;

        const kb = worm.pendingKnockback;
        worm.health = Math.max(0, worm.health - kb.damage);
        worm.vx += kb.vx;
        worm.vy += kb.vy;
        if (worm.health <= 0) {
          worm.isAlive = false;
          this.broadcastAll({
            type: "WORM_DIED",
            wormId: worm.id,
            cause: "hp",
          });
          this.processDeathExplosion(worm.id);
        }
        worm.pendingKnockback = undefined;
      }
    }
  }

  private handleSelectWeapon(weaponId: WeaponId, conn: Party.Connection): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    this.broadcastAll({
      type: "WEAPON_SELECTED",
      wormId: this.state.activeWormId,
      weaponId,
    });
  }

  private handleAim(angle: number, conn: Party.Connection): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    this.broadcastAll({
      type: "WORM_AIM",
      wormId: this.state.activeWormId,
      angle,
    });
  }

  private handleChat(text: string, conn: Party.Connection): void {
    if (!this.state) return;
    let senderId = "";
    let senderName = "";
    for (const [playerId, c] of this.playerConnections) {
      if (c === conn) {
        senderId = playerId;
        const player = this.state.players.find((p) => p.id === playerId);
        senderName = player?.displayName || "Unknown";
        break;
      }
    }
    if (!senderId) return;

    this.broadcastAll({
      type: "CHAT",
      playerId: senderId,
      displayName: senderName,
      text: text.substring(0, 200),
    });
  }

  // ─── Death Explosion ────────────────────────────────────

  /** When a worm dies, process a small explosion that damages nearby worms and destroys terrain. */
  private processDeathExplosion(wormId: string): void {
    if (!this.state) return;
    const deadWorm = this.state.players
      .flatMap((p) => p.worms)
      .find((w) => w.id === wormId);
    if (!deadWorm) return;

    const ex = deadWorm.x;
    const ey = deadWorm.y;
    const radius = DEATH_EXPLOSION_RADIUS;

    // Destroy terrain
    const bitmap = this.getBitmap();
    if (bitmap) {
      eraseCircleFromBitmap(bitmap, ex, ey, radius);
      this.syncBitmapToState();
    }

    const damages: Array<{
      wormId: string;
      damage: number;
      newHealth: number;
      knockbackVx: number;
      knockbackVy: number;
    }> = [];
    const deaths: Array<{
      wormId: string;
      cause: "hp" | "water" | "outofbounds";
    }> = [];

    // Damage nearby worms (excluding the dead worm itself)
    for (const p of this.state.players) {
      for (const w of p.worms) {
        if (!w.isAlive || w.id === wormId) continue;
        const kb = computeKnockback(
          w.x,
          w.y,
          ex,
          ey,
          radius,
          DEATH_EXPLOSION_DAMAGE,
          1.0,
        );
        if (kb.damage > 0) {
          w.health = Math.max(0, w.health - kb.damage);
          w.vx += kb.vx;
          w.vy += kb.vy;
          damages.push({
            wormId: w.id,
            damage: kb.damage,
            newHealth: w.health,
            knockbackVx: kb.vx,
            knockbackVy: kb.vy,
          });
          if (w.health <= 0) {
            w.isAlive = false;
            deaths.push({ wormId: w.id, cause: "hp" });
          }
        }
      }
    }

    this.broadcastAll({
      type: "WORM_DEATH_EXPLOSION",
      wormId,
      x: ex,
      y: ey,
      radius,
      terrainDestruction: [{ x: ex, y: ey, radius }],
      damages,
      deaths,
    });

    this.invalidateBitmapCache();
  }

  // ─── Broadcast ─────────────────────────────────────────

  private broadcastAll(msg: GameServerMessage, excludePlayerId?: string): void {
    const data = JSON.stringify(msg);
    for (const [playerId, conn] of this.playerConnections) {
      if (playerId !== excludePlayerId) {
        conn.send(data);
      }
    }
  }
}
