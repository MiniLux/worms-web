import type * as Party from "partykit/server";
import type {
  LobbyState,
  LobbyPlayer,
  LobbyConfig,
  LobbyClientMessage,
  LobbyServerMessage,
  TeamColor,
  GameInitPayload,
} from "@worms/shared";
import {
  DEFAULT_HP,
  DEFAULT_WORMS_PER_TEAM,
  DEFAULT_TURN_TIME,
} from "@worms/shared";

const TEAM_COLORS: TeamColor[] = ["red", "blue", "green", "yellow"];

export default class LobbyServer implements Party.Server {
  private state: LobbyState;
  private connections: Map<string, Party.Connection> = new Map();

  constructor(readonly room: Party.Room) {
    this.state = {
      code: room.id,
      hostId: "",
      players: [],
      config: {
        wormsPerTeam: DEFAULT_WORMS_PER_TEAM,
        hp: DEFAULT_HP,
        turnTime: DEFAULT_TURN_TIME,
        terrainTheme: "forest",
      },
    };
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    // Connection established, wait for JOIN_LOBBY message
  }

  onClose(conn: Party.Connection): void {
    const player = this.state.players.find((p) => {
      // Find player by connection
      return this.connections.get(p.id) === conn;
    });

    if (player) {
      player.isConnected = false;
      this.broadcast({
        type: "PLAYER_UPDATED",
        player,
      });

      // Remove after timeout if not reconnected
      setTimeout(() => {
        const p = this.state.players.find((pl) => pl.id === player.id);
        if (p && !p.isConnected) {
          this.state.players = this.state.players.filter(
            (pl) => pl.id !== player.id,
          );
          this.connections.delete(player.id);
          this.broadcast({ type: "PLAYER_LEFT", playerId: player.id });

          // Assign new host if needed
          if (
            this.state.hostId === player.id &&
            this.state.players.length > 0
          ) {
            this.state.hostId = this.state.players[0].id;
            this.state.players[0].isHost = true;
            this.broadcast({
              type: "PLAYER_UPDATED",
              player: this.state.players[0],
            });
          }
        }
      }, 30000);
    }
  }

  onMessage(message: string, sender: Party.Connection): void {
    let msg: LobbyClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case "JOIN_LOBBY":
        this.handleJoin(msg, sender);
        break;
      case "SET_READY":
        this.handleSetReady(msg, sender);
        break;
      case "SET_TEAM_COLOR":
        this.handleSetTeamColor(msg, sender);
        break;
      case "SET_WORM_NAMES":
        this.handleSetWormNames(msg, sender);
        break;
      case "UPDATE_CONFIG":
        this.handleUpdateConfig(msg, sender);
        break;
      case "START_GAME":
        this.handleStartGame(sender);
        break;
      case "CHAT":
        this.handleChat(msg, sender);
        break;
    }
  }

  private handleJoin(
    msg: Extract<LobbyClientMessage, { type: "JOIN_LOBBY" }>,
    conn: Party.Connection,
  ): void {
    // Check if player is reconnecting
    const existing = this.state.players.find((p) => p.id === msg.playerId);
    if (existing) {
      existing.isConnected = true;
      this.connections.set(msg.playerId, conn);
      // Send full state to reconnecting player
      conn.send(
        JSON.stringify({
          type: "LOBBY_STATE",
          state: this.state,
        } satisfies LobbyServerMessage),
      );
      this.broadcast({ type: "PLAYER_UPDATED", player: existing });
      return;
    }

    // Max 4 players
    if (this.state.players.length >= 4) {
      conn.send(
        JSON.stringify({
          type: "ERROR",
          message: "Lobby is full",
        } satisfies LobbyServerMessage),
      );
      return;
    }

    const isFirst = this.state.players.length === 0;
    const color = TEAM_COLORS[this.state.players.length] || "red";

    const player: LobbyPlayer = {
      id: msg.playerId,
      displayName: msg.displayName,
      avatarUrl: msg.avatarUrl,
      teamColor: color,
      isReady: false,
      isConnected: true,
      isHost: isFirst,
    };

    if (isFirst) {
      this.state.hostId = msg.playerId;
    }

    this.state.players.push(player);
    this.connections.set(msg.playerId, conn);

    // Send full state to the new player
    conn.send(
      JSON.stringify({
        type: "LOBBY_STATE",
        state: this.state,
      } satisfies LobbyServerMessage),
    );

    // Notify others
    this.broadcast({ type: "PLAYER_JOINED", player }, msg.playerId);
  }

  private handleSetReady(
    msg: Extract<LobbyClientMessage, { type: "SET_READY" }>,
    conn: Party.Connection,
  ): void {
    const player = this.findPlayerByConnection(conn);
    if (!player) return;

    player.isReady = msg.ready;
    this.broadcast({ type: "PLAYER_UPDATED", player });
  }

  private handleSetTeamColor(
    msg: Extract<LobbyClientMessage, { type: "SET_TEAM_COLOR" }>,
    conn: Party.Connection,
  ): void {
    const player = this.findPlayerByConnection(conn);
    if (!player) return;

    player.teamColor = msg.color;
    this.broadcast({ type: "PLAYER_UPDATED", player });
  }

  private handleSetWormNames(
    msg: Extract<LobbyClientMessage, { type: "SET_WORM_NAMES" }>,
    conn: Party.Connection,
  ): void {
    const player = this.findPlayerByConnection(conn);
    if (!player) return;

    player.wormNames = msg.names.map((n) => n.trim().substring(0, 20));
    this.broadcast({ type: "PLAYER_UPDATED", player });
  }

  private handleUpdateConfig(
    msg: Extract<LobbyClientMessage, { type: "UPDATE_CONFIG" }>,
    conn: Party.Connection,
  ): void {
    const player = this.findPlayerByConnection(conn);
    if (!player || player.id !== this.state.hostId) return;

    Object.assign(this.state.config, msg.config);
    this.broadcast({ type: "CONFIG_UPDATED", config: this.state.config });
  }

  private async handleStartGame(conn: Party.Connection): Promise<void> {
    const player = this.findPlayerByConnection(conn);
    if (!player || player.id !== this.state.hostId) {
      conn.send(
        JSON.stringify({
          type: "ERROR",
          message: "Only host can start",
        } satisfies LobbyServerMessage),
      );
      return;
    }

    if (this.state.players.length < 1) {
      conn.send(
        JSON.stringify({
          type: "ERROR",
          message: "Need at least 1 player",
        } satisfies LobbyServerMessage),
      );
      return;
    }

    const allReady = this.state.players.every((p) => p.isReady);
    if (!allReady) {
      conn.send(
        JSON.stringify({
          type: "ERROR",
          message: "Not all players are ready",
        } satisfies LobbyServerMessage),
      );
      return;
    }

    // Initialize game party
    const gameId = this.state.code;
    const gamePlayers = this.state.players.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl,
      teamColor: p.teamColor,
      wormNames: p.wormNames,
    }));

    // Solo mode: add a CPU dummy opponent so there's something to shoot at
    if (gamePlayers.length === 1) {
      const usedColors = new Set(gamePlayers.map((p) => p.teamColor));
      const cpuColor =
        (["blue", "red", "green", "yellow"] as const).find(
          (c) => !usedColors.has(c),
        ) ?? "blue";
      gamePlayers.push({
        id: "cpu-opponent",
        displayName: "CPU",
        avatarUrl: "",
        teamColor: cpuColor,
        wormNames: ["Prézidan", "Maitre clébard", "Testoludo", "Agagougou"],
      });
    }

    const initPayload: GameInitPayload = {
      players: gamePlayers,
      config: this.state.config,
    };

    // Notify all players to navigate to game, passing init payload
    // The first client to connect will send INIT_GAME to the game server
    this.broadcast({ type: "GAME_STARTING", gameId, initPayload });
  }

  private handleChat(
    msg: Extract<LobbyClientMessage, { type: "CHAT" }>,
    conn: Party.Connection,
  ): void {
    const player = this.findPlayerByConnection(conn);
    if (!player) return;

    this.broadcast({
      type: "CHAT",
      playerId: player.id,
      displayName: player.displayName,
      text: msg.text.substring(0, 200),
    });
  }

  private findPlayerByConnection(
    conn: Party.Connection,
  ): LobbyPlayer | undefined {
    for (const [playerId, c] of this.connections) {
      if (c === conn) {
        return this.state.players.find((p) => p.id === playerId);
      }
    }
    return undefined;
  }

  private broadcast(msg: LobbyServerMessage, excludePlayerId?: string): void {
    const data = JSON.stringify(msg);
    for (const [playerId, conn] of this.connections) {
      if (playerId !== excludePlayerId) {
        conn.send(data);
      }
    }
  }
}
