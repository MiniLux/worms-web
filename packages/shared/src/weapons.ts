export type WeaponId =
  | "bazooka"
  | "grenade"
  | "shotgun"
  | "fire_punch"
  | "teleport";

export type WeaponType = "projectile" | "hitscan" | "melee" | "utility";

export interface WeaponDefinition {
  id: WeaponId;
  name: string;
  type: WeaponType;
  damage: number;
  explosionRadius: number;
  ammo: number; // -1 = infinite
  affectedByWind: boolean;
  /** For grenades: fuse time in ms. 0 = explode on impact */
  fuseTime: number;
  /** Bounce elasticity, 0 = no bounce, 1 = perfect bounce */
  bounceElasticity: number;
  /** For hitscan weapons: number of shots per turn */
  shotsPerTurn: number;
  /** Knockback force multiplier */
  knockbackMultiplier: number;
}

export const WEAPON_DEFINITIONS: Record<WeaponId, WeaponDefinition> = {
  bazooka: {
    id: "bazooka",
    name: "Bazooka",
    type: "projectile",
    damage: 50,
    explosionRadius: 75,
    ammo: -1,
    affectedByWind: true,
    fuseTime: 0,
    bounceElasticity: 0,
    shotsPerTurn: 1,
    knockbackMultiplier: 1.0,
  },
  grenade: {
    id: "grenade",
    name: "Grenade",
    type: "projectile",
    damage: 50,
    explosionRadius: 75,
    ammo: -1,
    affectedByWind: false,
    fuseTime: 3000,
    bounceElasticity: 0.5,
    shotsPerTurn: 1,
    knockbackMultiplier: 1.0,
  },
  shotgun: {
    id: "shotgun",
    name: "Shotgun",
    type: "hitscan",
    damage: 25,
    explosionRadius: 10,
    ammo: -1,
    affectedByWind: false,
    fuseTime: 0,
    bounceElasticity: 0,
    shotsPerTurn: 2,
    knockbackMultiplier: 1.5,
  },
  fire_punch: {
    id: "fire_punch",
    name: "Fire Punch",
    type: "melee",
    damage: 30,
    explosionRadius: 0,
    ammo: -1,
    affectedByWind: false,
    fuseTime: 0,
    bounceElasticity: 0,
    shotsPerTurn: 1,
    knockbackMultiplier: 2.0,
  },
  teleport: {
    id: "teleport",
    name: "Teleport",
    type: "utility",
    damage: 0,
    explosionRadius: 0,
    ammo: 2,
    affectedByWind: false,
    fuseTime: 0,
    bounceElasticity: 0,
    shotsPerTurn: 1,
    knockbackMultiplier: 0,
  },
};

export const MVP_WEAPON_IDS: WeaponId[] = [
  "bazooka",
  "grenade",
  "shotgun",
  "fire_punch",
  "teleport",
];
