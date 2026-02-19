// Terrain
export const TERRAIN_WIDTH = 1920;
export const TERRAIN_HEIGHT = 720;
export const WATER_LEVEL = 680;

// Physics
export const GRAVITY = 400; // pixels/s²
export const PHYSICS_STEP_MS = 16; // ~60fps
export const MAX_TRAJECTORY_STEPS = 600; // 10 seconds max flight time

// Worm
export const WORM_WIDTH = 24;
export const WORM_HEIGHT = 24;
export const WORM_WALK_SPEED = 60; // px/s
export const WORM_JUMP_VX = 80;
export const WORM_JUMP_VY = -180;
export const WORM_BACKFLIP_VX = -40;
export const WORM_BACKFLIP_VY = -280;
export const WORM_MAX_CLIMB = 4; // max pixels a worm can step up per walk step
export const WORM_FRICTION_GROUND = 0.7;
export const WORM_FRICTION_AIR = 0.0;
export const FALL_DAMAGE_THRESHOLD = 40; // pixels of fall before damage
export const FALL_DAMAGE_PER_PIXEL = 0.25; // HP per pixel beyond threshold

// Game defaults
export const DEFAULT_HP = 100;
export const DEFAULT_WORMS_PER_TEAM = 4;
export const DEFAULT_TURN_TIME = 45; // seconds
export const DEFAULT_RETREAT_TIME = 5; // seconds after firing
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;
export const ROOM_CODE_LENGTH = 6;

// Wind
export const MAX_WIND = 100;

// Projectile
export const MAX_FIRE_POWER = 1.0;
export const FIRE_POWER_MULTIPLIER = 1100; // power 1.0 = 1100 px/s initial velocity

// Death explosion (when a worm dies, it explodes)
export const DEATH_EXPLOSION_RADIUS = 25;
export const DEATH_EXPLOSION_DAMAGE = 25;

// Terrain themes
export const TERRAIN_THEMES = [
  "prairie",
  "hell",
  "arctic",
  "cheese",
  "urban",
  "mars",
  "forest",
] as const;
