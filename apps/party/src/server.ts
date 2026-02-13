import type * as Party from "partykit/server";
import type {
  GameState,
  GameClientMessage,
  GameServerMessage,
  GameInitPayload,
} from "@worms/shared";
import { DEFAULT_RETREAT_TIME, DEFAULT_TURN_TIME } from "@worms/shared";
import {
  initializeGame,
  advanceTurn,
  processMove,
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
  private shotsFiredThisTurn: number = 0;
  private maxShotsThisTurn: number = 1;
  private pendingJoins: Array<{ playerId: string; conn: Party.Connection }> =
    [];

  constructor(readonly room: Party.Room) {}

  // ─── HTTP: Game Initialization ─────────────────────────

  async onRequest(req: Party.Request): Promise<Response> {
    if (req.method === "POST") {
      const url = new URL(req.url);
      if (url.pathname === "/init") {
        try {
          const payload = (await req.json()) as GameInitPayload;
          this.state = initializeGame(payload);
          return new Response("OK", { status: 200 });
        } catch (err) {
          return new Response("Invalid payload", { status: 400 });
        }
      }
    }

    return new Response("Not found", { status: 404 });
  }

  // ─── WebSocket Lifecycle ───────────────────────────────

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    // Wait for JOIN_GAME message to associate connection with player
  }

  onClose(conn: Party.Connection): void {
    // Find which player disconnected
    for (const [playerId, c] of this.playerConnections) {
      if (c === conn) {
        this.playerConnections.delete(playerId);

        if (this.state) {
          const player = this.state.players.find((p) => p.id === playerId);
          if (player) {
            player.isConnected = false;
            this.broadcastAll({
              type: "PLAYER_DISCONNECTED",
              playerId,
            });

            // If it was their turn, skip after a delay
            if (this.state.activePlayerId === playerId) {
              this.room.storage.setAlarm(Date.now() + 10000); // 10s to reconnect
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

    // All other messages require state
    if (!this.state) return;

    switch (msg.type) {
      case "MOVE":
        this.handleMove(msg.direction, sender);
        break;
      case "STOP_MOVE":
        // Movement is discrete steps, no need for stop
        break;
      case "JUMP":
        this.handleJump(msg.kind, sender);
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
      // Retreat time over, advance turn
      const messages = advanceTurn(this.state);
      for (const msg of messages) {
        this.broadcastAll(msg);
      }

      // Start new turn timer (advanceTurn mutates phase)
      if ((this.state.phase as string) === "playing") {
        this.shotsFiredThisTurn = 0;
        this.maxShotsThisTurn = 1;
        this.room.storage.setAlarm(
          Date.now() + this.state.turnTimeRemaining * 1000,
        );
      }
      return;
    }

    if (this.state.phase === "playing") {
      // Turn timed out — skip and advance
      this.state.phase = "retreat";
      this.broadcastAll({
        type: "RETREAT_START",
        timeMs: DEFAULT_RETREAT_TIME * 1000,
      });
      this.room.storage.setAlarm(Date.now() + DEFAULT_RETREAT_TIME * 1000);
    }
  }

  // ─── Handlers ──────────────────────────────────────────

  private handleInitGame(
    payload: GameInitPayload,
    conn: Party.Connection,
  ): void {
    // Only initialize once
    if (this.state) return;
    try {
      this.state = initializeGame(payload);

      // Process any players who sent JOIN_GAME before init completed
      for (const pending of this.pendingJoins) {
        this.handleJoinGame(pending.playerId, pending.conn);
      }
      this.pendingJoins = [];
    } catch (err) {
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
      // Game not initialized yet — queue this join for when INIT_GAME arrives
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

    // Send full game state
    conn.send(
      JSON.stringify({
        type: "GAME_STATE_SYNC",
        state: this.state,
      } satisfies GameServerMessage),
    );

    // Notify others of reconnection
    this.broadcastAll({ type: "PLAYER_RECONNECTED", playerId }, playerId);

    // If all players connected and this is the first time, start the turn timer
    const allConnected = this.state.players.every((p) => p.isConnected);
    if (allConnected && this.state.turnNumber === 1) {
      this.broadcastAll({
        type: "TURN_START",
        activePlayerId: this.state.activePlayerId,
        activeWormId: this.state.activeWormId,
        wind: this.state.wind,
        turnTime: this.state.turnTimeRemaining,
      });
      this.room.storage.setAlarm(
        Date.now() + this.state.turnTimeRemaining * 1000,
      );
    }
  }

  private isActivePlayer(conn: Party.Connection): boolean {
    if (!this.state || this.state.phase !== "playing") return false;
    for (const [playerId, c] of this.playerConnections) {
      if (c === conn && playerId === this.state.activePlayerId) return true;
    }
    return false;
  }

  private handleMove(
    direction: "left" | "right",
    conn: Party.Connection,
  ): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    const messages = processMove(this.state, direction);
    for (const msg of messages) {
      this.broadcastAll(msg);
    }
  }

  private handleJump(
    kind: "forward" | "backflip",
    conn: Party.Connection,
  ): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    const messages = processJump(this.state, kind);
    for (const msg of messages) {
      this.broadcastAll(msg);
    }
  }

  private handleFire(
    weaponId: string,
    angle: number,
    power: number,
    conn: Party.Connection,
  ): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    if (this.state.phase !== "playing") return;

    const messages = processFire(
      this.state,
      weaponId as any,
      angle,
      Math.max(0, Math.min(1, power)),
    );
    for (const msg of messages) {
      this.broadcastAll(msg);
    }

    // Check game over
    const gameOver = checkGameOver(this.state);
    if (gameOver) {
      this.broadcastAll(gameOver);
      return;
    }

    // Start retreat timer (processFire mutates phase)
    if ((this.state.phase as string) === "retreat") {
      this.broadcastAll({
        type: "RETREAT_START",
        timeMs: DEFAULT_RETREAT_TIME * 1000,
      });
      this.room.storage.setAlarm(Date.now() + DEFAULT_RETREAT_TIME * 1000);
    }
  }

  private handleHitscan(
    weaponId: string,
    angle: number,
    conn: Party.Connection,
  ): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    if (this.state.phase !== "playing") return;

    this.shotsFiredThisTurn++;

    const messages = processHitscan(this.state, weaponId as any, angle);
    for (const msg of messages) {
      this.broadcastAll(msg);
      // Check if more shots remain
      if (msg.type === "HITSCAN_RESULT" && msg.shotsRemaining > 0) {
        this.maxShotsThisTurn = msg.shotsRemaining + this.shotsFiredThisTurn;
        // Don't end turn yet, allow more shots
        return;
      }
    }

    const gameOver = checkGameOver(this.state);
    if (gameOver) {
      this.broadcastAll(gameOver);
      return;
    }

    // If all shots used, enter retreat
    this.state.phase = "retreat";
    this.broadcastAll({
      type: "RETREAT_START",
      timeMs: DEFAULT_RETREAT_TIME * 1000,
    });
    this.room.storage.setAlarm(Date.now() + DEFAULT_RETREAT_TIME * 1000);
  }

  private handleMelee(
    weaponId: string,
    direction: "left" | "right",
    conn: Party.Connection,
  ): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    if (this.state.phase !== "playing") return;

    const messages = processMelee(this.state, weaponId as any, direction);
    for (const msg of messages) {
      this.broadcastAll(msg);
    }

    const gameOver = checkGameOver(this.state);
    if (gameOver) {
      this.broadcastAll(gameOver);
      return;
    }

    this.broadcastAll({
      type: "RETREAT_START",
      timeMs: DEFAULT_RETREAT_TIME * 1000,
    });
    this.room.storage.setAlarm(Date.now() + DEFAULT_RETREAT_TIME * 1000);
  }

  private handleTeleport(x: number, y: number, conn: Party.Connection): void {
    if (!this.isActivePlayer(conn) || !this.state) return;
    if (this.state.phase !== "playing") return;

    const messages = processTeleport(this.state, x, y);
    for (const msg of messages) {
      this.broadcastAll(msg);
    }

    this.broadcastAll({
      type: "RETREAT_START",
      timeMs: DEFAULT_RETREAT_TIME * 1000,
    });
    this.room.storage.setAlarm(Date.now() + DEFAULT_RETREAT_TIME * 1000);
  }

  private handleSkipTurn(conn: Party.Connection): void {
    if (!this.isActivePlayer(conn) || !this.state) return;

    this.broadcastAll({ type: "TURN_END" });
    const messages = advanceTurn(this.state);
    for (const msg of messages) {
      this.broadcastAll(msg);
    }

    if (this.state.phase === "playing") {
      this.shotsFiredThisTurn = 0;
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
