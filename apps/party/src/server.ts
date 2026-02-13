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
  WEAPON_DEFINITIONS,
  decodeBitmap,
  encodeBitmap,
  simulateWormStep,
  computeFallDamage,
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
        // No server action needed, purely client state
        break;
      case "FIRE":
        this.handleFire(msg.weaponId, msg.angle, msg.power, sender);
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
        if (!isWalking && !hasVelocity) continue;

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

        // Update worm state
        const posChanged =
          Math.abs(worm.x - result.x) > 0.5 ||
          Math.abs(worm.y - result.y) > 0.5;
        worm.x = result.x;
        worm.y = result.y;
        worm.vx = result.vx;
        worm.vy = result.vy;
        if (walkDir !== 0) {
          worm.facing = walkDir > 0 ? "right" : "left";
        }

        if (posChanged) {
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

  private handleInitGame(
    payload: GameInitPayload,
    conn: Party.Connection,
  ): void {
    if (this.state) return;
    try {
      this.state = initializeGame(payload);
      this.invalidateBitmapCache();

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
  }

  private handleMoveStop(conn: Party.Connection): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    this.movingDirection = null;
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
  ): void {
    if (!this.canFire(conn) || !this.state) return;
    this.movingDirection = null;

    const messages = processFire(
      this.state,
      weaponId as WeaponId,
      angle,
      Math.max(0, Math.min(1, power)),
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
    for (const m of messages) this.broadcastAll(m);

    // Teleport doesn't cause knockback, just enter retreat
    this.state.phase = "retreat";
    this.broadcastAll({
      type: "RETREAT_START",
      timeMs: DEFAULT_RETREAT_TIME * 1000,
    });
    this.room.storage.setAlarm(Date.now() + DEFAULT_RETREAT_TIME * 1000);
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
    }
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
