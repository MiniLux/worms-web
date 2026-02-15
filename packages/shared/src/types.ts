import type { WeaponId } from "./weapons";
import type { TERRAIN_THEMES } from "./constants";

// ─── Terrain ────────────────────────────────────────────

export type TerrainTheme = (typeof TERRAIN_THEMES)[number];

export interface TerrainData {
  /** Base64-encoded bit-packed bitmap (1 bit per pixel) */
  bitmap: string;
  /** 1D heightmap — surface Y for each X column */
  heightmap: number[];
  seed: number;
  theme: TerrainTheme;
}

// ─── Game State ─────────────────────────────────────────

export type TeamColor = "red" | "blue" | "green" | "yellow";

export interface WormState {
  id: string;
  name: string;
  playerId: string;
  health: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: "left" | "right";
  isAlive: boolean;
  isActive: boolean;
  pendingJump?: { vx: number; vy: number; delayMs: number };
  pendingKnockback?: {
    vx: number;
    vy: number;
    damage: number;
    delayMs: number;
  };
}

export interface PlayerState {
  id: string;
  displayName: string;
  avatarUrl: string;
  teamColor: TeamColor;
  worms: WormState[];
  ammo: Record<WeaponId, number>;
  isConnected: boolean;
  /** Index of the last worm used by this player (for round-robin rotation) */
  lastWormIndex: number;
}

export type GamePhase =
  | "waiting"
  | "playing"
  | "retreat"
  | "resolving"
  | "finished";

export interface GameState {
  phase: GamePhase;
  players: PlayerState[];
  activePlayerId: string;
  activeWormId: string;
  turnNumber: number;
  turnTimeRemaining: number;
  wind: number; // -MAX_WIND to +MAX_WIND
  terrain: TerrainData;
}

export interface TrajectoryPoint {
  x: number;
  y: number;
  t: number; // ms since fire
}

export interface ProjectileState {
  id: string;
  weaponId: WeaponId;
  x: number;
  y: number;
  trajectory: TrajectoryPoint[];
}

// ─── Lobby State ────────────────────────────────────────

export interface LobbyPlayer {
  id: string;
  displayName: string;
  avatarUrl: string;
  teamColor: TeamColor;
  isReady: boolean;
  isConnected: boolean;
  isHost: boolean;
  wormNames?: string[];
}

export interface LobbyConfig {
  wormsPerTeam: number;
  hp: number;
  turnTime: number;
  terrainTheme: TerrainTheme;
}

export interface LobbyState {
  code: string;
  hostId: string;
  players: LobbyPlayer[];
  config: LobbyConfig;
}

// ─── Client → Server Messages ───────────────────────────

export type LobbyClientMessage =
  | {
      type: "JOIN_LOBBY";
      playerId: string;
      displayName: string;
      avatarUrl: string;
    }
  | { type: "SET_READY"; ready: boolean }
  | { type: "SET_TEAM_COLOR"; color: TeamColor }
  | { type: "SET_WORM_NAMES"; names: string[] }
  | { type: "UPDATE_CONFIG"; config: Partial<LobbyConfig> }
  | { type: "START_GAME" }
  | { type: "CHAT"; text: string };

export type GameClientMessage =
  | { type: "JOIN_GAME"; playerId: string }
  | { type: "INIT_GAME"; payload: GameInitPayload }
  | { type: "MOVE"; direction: "left" | "right" }
  | { type: "MOVE_START"; direction: "left" | "right" }
  | { type: "MOVE_STOP" }
  | { type: "STOP_MOVE" }
  | { type: "JUMP"; kind: "forward" | "backflip" }
  | { type: "SELECT_WEAPON"; weaponId: WeaponId }
  | {
      type: "FIRE";
      weaponId: WeaponId;
      angle: number;
      power: number;
      fuseMs?: number;
    }
  | { type: "FIRE_HITSCAN"; weaponId: WeaponId; angle: number }
  | { type: "FIRE_MELEE"; weaponId: WeaponId; direction: "left" | "right" }
  | { type: "USE_TELEPORT"; x: number; y: number }
  | { type: "SKIP_TURN" }
  | { type: "PAUSE_TIMER" }
  | { type: "APPLY_KNOCKBACK" }
  | { type: "CHAT"; text: string };

// ─── Server → Client Messages ───────────────────────────

export type LobbyServerMessage =
  | { type: "LOBBY_STATE"; state: LobbyState }
  | { type: "PLAYER_JOINED"; player: LobbyPlayer }
  | { type: "PLAYER_LEFT"; playerId: string }
  | { type: "PLAYER_UPDATED"; player: LobbyPlayer }
  | { type: "CONFIG_UPDATED"; config: LobbyConfig }
  | { type: "GAME_STARTING"; gameId: string; initPayload: GameInitPayload }
  | { type: "ERROR"; message: string }
  | { type: "CHAT"; playerId: string; displayName: string; text: string };

export interface ExplosionEvent {
  x: number;
  y: number;
  radius: number;
}

export interface DamageEvent {
  wormId: string;
  damage: number;
  newHealth: number;
  knockbackVx: number;
  knockbackVy: number;
}

export interface WormDeathEvent {
  wormId: string;
  cause: "hp" | "water" | "outofbounds";
}

export interface TerrainDestructionEvent {
  x: number;
  y: number;
  radius: number;
}

export type GameServerMessage =
  | { type: "GAME_STATE_SYNC"; state: GameState }
  | {
      type: "TURN_START";
      activePlayerId: string;
      activeWormId: string;
      wind: number;
      turnTime: number;
    }
  | {
      type: "WORM_MOVED";
      wormId: string;
      x: number;
      y: number;
      facing: "left" | "right";
    }
  | {
      type: "WORM_JUMPED";
      wormId: string;
      vx: number;
      vy: number;
      kind: "forward" | "backflip";
    }
  | {
      type: "FIRE_RESULT";
      trajectory: TrajectoryPoint[];
      weaponId: WeaponId;
      fuseMs?: number;
      explosions: ExplosionEvent[];
      terrainDestruction: TerrainDestructionEvent[];
      damages: DamageEvent[];
      deaths: WormDeathEvent[];
    }
  | {
      type: "HITSCAN_RESULT";
      weaponId: WeaponId;
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      hitWormId: string | null;
      explosions: ExplosionEvent[];
      terrainDestruction: TerrainDestructionEvent[];
      damages: DamageEvent[];
      deaths: WormDeathEvent[];
      shotsRemaining: number;
    }
  | {
      type: "MELEE_RESULT";
      weaponId: WeaponId;
      damages: DamageEvent[];
      deaths: WormDeathEvent[];
    }
  | { type: "TELEPORT_RESULT"; wormId: string; x: number; y: number }
  | { type: "WORM_DIED"; wormId: string; cause: string }
  | {
      type: "WORM_DAMAGE";
      wormId: string;
      damage: number;
      newHealth: number;
    }
  | { type: "TURN_END" }
  | { type: "RETREAT_START"; timeMs: number }
  | { type: "GAME_OVER"; winnerId: string | null; reason: string }
  | { type: "TIMER_SYNC"; remaining: number }
  | {
      type: "WORM_PHYSICS_UPDATE";
      updates: Array<{
        wormId: string;
        x: number;
        y: number;
        vx: number;
        vy: number;
        facing: "left" | "right";
      }>;
    }
  | {
      type: "WORM_LANDED";
      wormId: string;
      x: number;
      y: number;
      fallDamage: number;
      newHealth: number;
    }
  | {
      type: "WORM_FELL_IN_WATER";
      wormId: string;
    }
  | { type: "PLAYER_DISCONNECTED"; playerId: string }
  | { type: "PLAYER_RECONNECTED"; playerId: string }
  | { type: "CHAT"; playerId: string; displayName: string; text: string }
  | { type: "ERROR"; message: string };

// ─── Game Init (Lobby → Game server handoff) ────────────

export interface GameInitPlayer {
  id: string;
  displayName: string;
  avatarUrl: string;
  teamColor: TeamColor;
  wormNames?: string[];
}

export interface GameInitPayload {
  players: GameInitPlayer[];
  config: LobbyConfig;
}
