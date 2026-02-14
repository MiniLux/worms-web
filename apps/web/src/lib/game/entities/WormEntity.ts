import * as Phaser from "phaser";
import type { WormState, TeamColor, WeaponId } from "@worms/shared";

const COLOR_MAP: Record<TeamColor, number> = {
  red: 0xef4444,
  blue: 0x3b82f6,
  green: 0x22c55e,
  yellow: 0xeab308,
};

function hasSpritesheet(scene: Phaser.Scene, key: string): boolean {
  return scene.textures.exists(key) && key !== "__MISSING";
}

/** Map character to font12 spritesheet frame index */
function charToFrame(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65; // A-Z → 0-25
  if (code >= 97 && code <= 122) return code - 97 + 26; // a-z → 26-51
  if (code >= 48 && code <= 57) return code - 48 + 52; // 0-9 → 52-61
  return -1; // unsupported character (space, punctuation)
}

/** Create a row of bitmap font sprites for a text string */
function createBitmapText(
  scene: Phaser.Scene,
  text: string,
  x: number,
  y: number,
  tint: number,
  depth: number,
): Phaser.GameObjects.Container {
  const container = scene.add.container(x, y);
  container.setDepth(depth);

  if (!hasSpritesheet(scene, "font12")) return container;

  const charSpacing = 8; // tighter than 12px cell — glyphs are ~6px wide
  const totalWidth = text.length * charSpacing;
  let cx = -totalWidth / 2;

  for (const ch of text) {
    if (ch === " ") {
      cx += charSpacing;
      continue;
    }
    const frame = charToFrame(ch);
    if (frame < 0) {
      cx += charSpacing;
      continue;
    }
    const sprite = scene.add.sprite(cx, 0, "font12", frame);
    sprite.setOrigin(0, 0.5);
    sprite.setTint(tint);
    container.add(sprite);
    cx += charSpacing;
  }

  return container;
}

/** Update existing bitmap text container with new text */
function updateBitmapText(
  container: Phaser.GameObjects.Container,
  scene: Phaser.Scene,
  text: string,
  tint: number,
): void {
  container.removeAll(true);

  if (!hasSpritesheet(scene, "font12")) return;

  const charSpacing = 8;
  const totalWidth = text.length * charSpacing;
  let cx = -totalWidth / 2;

  for (const ch of text) {
    if (ch === " ") {
      cx += charSpacing;
      continue;
    }
    const frame = charToFrame(ch);
    if (frame < 0) {
      cx += charSpacing;
      continue;
    }
    const sprite = scene.add.sprite(cx, 0, "font12", frame);
    sprite.setOrigin(0, 0.5);
    sprite.setTint(tint);
    container.add(sprite);
    cx += charSpacing;
  }
}

/**
 * Weapon aim sprite config.
 * Each weapon has a base spritesheet with 32 frames covering the full aim arc.
 * Frame 0 = aiming most downward, frame 31 = aiming most upward.
 * (The u/d variants are for uphill/downhill terrain slopes — we use base only.)
 */
const WEAPON_AIM_SPRITES: Record<string, string> = {
  bazooka: "worm_baz",
  grenade: "worm_throw",
  shotgun: "worm_shotg",
};

/** Weapon "draw/get" animation played when worm stops walking and has a weapon */
const WEAPON_DRAW_SPRITES: Record<string, { texture: string; frames: number }> =
  {
    shotgun: { texture: "worm_shotg", frames: 32 },
    bazooka: { texture: "worm_bazlnk", frames: 7 },
  };

/** Weapon fire animation (played once on firing) */
const WEAPON_FIRE_SPRITES: Record<string, string> = {
  shotgun: "worm_shotf",
};

export class WormEntity {
  private sprite: Phaser.GameObjects.Sprite | null = null;
  private fallbackBody: Phaser.GameObjects.Ellipse | null = null;
  private nameText: Phaser.GameObjects.Container;
  private hpText: Phaser.GameObjects.Container;
  private aimLine: Phaser.GameObjects.Graphics;
  private state: WormState;
  private targetX: number;
  private targetY: number;
  private currentAnim: string = "";
  private isWalking: boolean = false;
  private walkingExplicit: boolean = false; // true when setWalking(true) was called
  private usesSprites: boolean = false;
  private isDead: boolean = false;
  private holdingWeapon: WeaponId | null = null;
  private overrideAnim: string | null = null;
  private aimAngle: number = 0;
  private isShowingWeaponFrame: boolean = false;
  private jumpAnimPlaying: boolean = false;
  private drawAnimPlaying: boolean = false;
  private powerGauge: Phaser.GameObjects.Graphics;
  private powerValue: number = 0;
  private showPowerGauge: boolean = false;
  private crosshairSprite: Phaser.GameObjects.Sprite | null = null;
  private arrowSprite: Phaser.GameObjects.Sprite | null = null;
  private labelsHidden: boolean = false;

  constructor(
    private scene: Phaser.Scene,
    initialState: WormState,
    private teamColor: TeamColor,
  ) {
    this.state = { ...initialState };
    this.targetX = initialState.x;
    this.targetY = initialState.y;

    const color = COLOR_MAP[teamColor] ?? 0xffffff;

    this.usesSprites = hasSpritesheet(scene, "worm_breath");

    if (this.usesSprites) {
      this.createAnimations();
      this.sprite = scene.add.sprite(
        initialState.x,
        initialState.y,
        "worm_breath",
        0,
      );
      this.sprite.setDepth(3);
      this.sprite.setFlipX(initialState.facing === "right");
      this.playAnimation("worm_idle");
    } else {
      this.fallbackBody = scene.add.ellipse(
        initialState.x,
        initialState.y,
        20,
        24,
        color,
      );
      this.fallbackBody.setDepth(3);
    }

    this.nameText = createBitmapText(
      scene,
      initialState.name,
      initialState.x,
      initialState.y - 30,
      0xffffff,
      4,
    );

    this.hpText = createBitmapText(
      scene,
      String(initialState.health),
      initialState.x,
      initialState.y - 19,
      color,
      4,
    );

    this.aimLine = scene.add.graphics();
    this.aimLine.setDepth(5);
    this.aimLine.setVisible(false);

    // Crosshair sprite (animated, team colored)
    const crosshairKey =
      teamColor === "blue" ? "crosshair_blue" : "crosshair_red";
    if (hasSpritesheet(scene, crosshairKey)) {
      if (!scene.anims.exists("anim_crosshair_" + crosshairKey)) {
        scene.anims.create({
          key: "anim_crosshair_" + crosshairKey,
          frames: scene.anims.generateFrameNumbers(crosshairKey, {
            start: 0,
            end: 31,
          }),
          frameRate: 15,
          repeat: -1,
        });
      }
      this.crosshairSprite = scene.add.sprite(0, 0, crosshairKey, 0);
      this.crosshairSprite.setDepth(7);
      this.crosshairSprite.setScale(1.0);
      this.crosshairSprite.setVisible(false);
      this.crosshairSprite.play("anim_crosshair_" + crosshairKey);
    }

    this.powerGauge = scene.add.graphics();
    this.powerGauge.setDepth(5);
    this.powerGauge.setVisible(false);
  }

  private createAnimations(): void {
    if (this.scene.anims.exists("worm_idle")) return;

    const defs: Array<{
      key: string;
      texture: string;
      end: number;
      rate: number;
      repeat: number;
    }> = [
      {
        key: "worm_idle",
        texture: "worm_breath",
        end: 19,
        rate: 7,
        repeat: -1,
      },
      { key: "worm_walk", texture: "worm_walk", end: 14, rate: 15, repeat: -1 },
      {
        key: "worm_jump_anim",
        texture: "worm_jump",
        end: 9,
        rate: 15,
        repeat: 0,
      },
      {
        key: "worm_backflip_anim",
        texture: "worm_backflip",
        end: 21,
        rate: 20,
        repeat: 0,
      },
      {
        key: "worm_fall_anim",
        texture: "worm_fall",
        end: 1,
        rate: 8,
        repeat: -1,
      },
      {
        key: "worm_die_anim",
        texture: "worm_die",
        end: 59,
        rate: 30,
        repeat: 0,
      },
      {
        key: "worm_fly_anim",
        texture: "worm_fly",
        end: 31,
        rate: 20,
        repeat: -1,
      },
      {
        key: "worm_blink_anim",
        texture: "worm_blink",
        end: 5,
        rate: 10,
        repeat: 0,
      },
      // Fire punch
      {
        key: "worm_japbak",
        texture: "worm_japbak",
        end: 8,
        rate: 7,
        repeat: -1,
      },
      { key: "worm_fist", texture: "worm_fist", end: 16, rate: 24, repeat: 0 },
      {
        key: "worm_firblast",
        texture: "worm_firblast",
        end: 23,
        rate: 30,
        repeat: 0,
      },
    ];

    for (const d of defs) {
      if (!hasSpritesheet(this.scene, d.texture)) continue;
      this.scene.anims.create({
        key: d.key,
        frames: this.scene.anims.generateFrameNumbers(d.texture, {
          start: 0,
          end: d.end,
        }),
        frameRate: d.rate,
        repeat: d.repeat,
      });
    }
  }

  get id(): string {
    return this.state.id;
  }

  get x(): number {
    return this.sprite?.x ?? this.fallbackBody?.x ?? this.state.x;
  }

  get y(): number {
    return this.sprite?.y ?? this.fallbackBody?.y ?? this.state.y;
  }

  get facing(): "left" | "right" {
    return this.state.facing;
  }

  updateState(newState: Partial<WormState>): void {
    Object.assign(this.state, newState);
    if (newState.x !== undefined) this.targetX = newState.x;
    if (newState.y !== undefined) this.targetY = newState.y;

    if (newState.facing !== undefined) {
      this.applyFacing(newState.facing);
    } else if (newState.vx !== undefined && Math.abs(newState.vx) > 5) {
      const inferred = newState.vx > 0 ? "right" : "left";
      this.state.facing = inferred;
      this.applyFacing(inferred);
    }

    if (newState.health !== undefined) {
      updateBitmapText(
        this.hpText,
        this.scene,
        String(this.state.health),
        COLOR_MAP[this.teamColor] ?? 0xffffff,
      );
    }
    if (newState.isAlive === false && !this.isDead) {
      this.die();
    }

    if (newState.vx !== undefined && !this.walkingExplicit) {
      this.isWalking =
        Math.abs(this.state.vx) > 1 && Math.abs(this.state.vy) < 5;
    }
  }

  private applyFacing(facing: "left" | "right"): void {
    if (this.sprite) {
      this.sprite.setFlipX(facing === "right");
    } else if (this.fallbackBody) {
      this.fallbackBody.setScale(facing === "left" ? -1 : 1, 1);
    }
  }

  setActive(active: boolean): void {
    this.state.isActive = active;
    if (this.fallbackBody) {
      if (active) {
        this.fallbackBody.setStrokeStyle(2, 0xffffff);
      } else {
        this.fallbackBody.setStrokeStyle(0);
      }
    }
    if (active) {
      // Hide name/HP during active turn
      this.labelsHidden = true;
      this.nameText.setVisible(false);
      this.hpText.setVisible(false);
      // Show bouncing arrow above head
      this.showArrow();
    } else {
      // Show name/HP when turn ends
      this.labelsHidden = false;
      if (!this.isDead) {
        this.nameText.setVisible(true);
        this.hpText.setVisible(true);
      }
      this.hideArrow();
      this.hideAimLine();
      this.hidePowerGauge();
      this.holdingWeapon = null;
      this.overrideAnim = null;
      this.isShowingWeaponFrame = false;
    }
  }

  /** Show bouncing arrow above the active worm */
  private showArrow(): void {
    this.hideArrow();
    const arrowMap: Record<string, string> = {
      red: "arrowdn_red",
      blue: "arrowdn_blue",
      green: "arrowdn_green",
      yellow: "arrowdn_yellow",
    };
    const key = arrowMap[this.teamColor] ?? "arrowdn_red";
    if (!hasSpritesheet(this.scene, key)) return;

    this.arrowSprite = this.scene.add.sprite(this.x, this.y - 50, key, 0);
    this.arrowSprite.setDepth(8);
    this.arrowSprite.setScale(0.7);

    // Create arrow animation if not exists
    const animKey = "anim_" + key;
    if (!this.scene.anims.exists(animKey)) {
      this.scene.anims.create({
        key: animKey,
        frames: this.scene.anims.generateFrameNumbers(key, {
          start: 0,
          end: 29,
        }),
        frameRate: 15,
        repeat: -1,
      });
    }
    this.arrowSprite.play(animKey);
  }

  /** Hide the bouncing arrow (called on keypress or turn end) */
  hideArrow(): void {
    if (this.arrowSprite) {
      this.arrowSprite.destroy();
      this.arrowSprite = null;
    }
  }

  setWeaponHold(weaponId: WeaponId | null): void {
    this.holdingWeapon = weaponId;
    this.isShowingWeaponFrame = false;
    if (weaponId === "fire_punch") {
      this.overrideAnim = "worm_japbak";
    } else {
      this.overrideAnim = null;
    }
  }

  /** Update the aim angle — used for weapon hold sprite frame selection.
   *  Also flips the worm to face the aim direction. */
  setAimAngle(angle: number): void {
    this.aimAngle = angle;
    // Flip worm to face aim direction
    // angle in (-PI/2, PI/2) → aiming right; outside → aiming left
    const aimingRight = Math.abs(angle) < Math.PI / 2;
    const newFacing = aimingRight ? "right" : "left";
    if (this.state.facing !== newFacing) {
      this.state.facing = newFacing;
      this.applyFacing(newFacing);
    }
  }

  /** Play jump or backflip animation, then allow normal state machine to take over */
  playJumpAnim(kind: "forward" | "backflip"): void {
    if (!this.sprite) return;
    const animKey =
      kind === "backflip" ? "worm_backflip_anim" : "worm_jump_anim";
    if (!this.scene.anims.exists(animKey)) return;
    this.jumpAnimPlaying = true;
    this.isShowingWeaponFrame = false;
    this.currentAnim = "";

    // Backflip: temporarily flip sprite (worm jumps backward)
    if (kind === "backflip") {
      this.sprite.setFlipX(this.state.facing === "left");
    }

    this.sprite.play(animKey);
    this.sprite.once("animationcomplete", () => {
      this.jumpAnimPlaying = false;
      this.currentAnim = "";
      // Restore correct facing after backflip
      if (this.sprite) {
        this.applyFacing(this.state.facing);
      }
    });
  }

  playPunchAnim(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sprite || !this.scene.anims.exists("worm_fist")) {
        resolve();
        return;
      }
      this.overrideAnim = "worm_fist";
      this.currentAnim = "";
      this.isShowingWeaponFrame = false;
      this.sprite.play("worm_fist");
      this.sprite.once("animationcomplete", () => {
        this.overrideAnim = "worm_japbak";
        this.currentAnim = "";
        resolve();
      });
    });
  }

  /** Set walking state directly (called by GameScene on key events) */
  setWalking(walking: boolean): void {
    this.isWalking = walking;
    this.walkingExplicit = walking;
    if (!walking && this.holdingWeapon) {
      // Play weapon draw animation when stopping, then return to aim pose
      const drawInfo = WEAPON_DRAW_SPRITES[this.holdingWeapon];
      if (
        drawInfo &&
        this.sprite &&
        hasSpritesheet(this.scene, drawInfo.texture)
      ) {
        this.drawAnimPlaying = true;
        this.isShowingWeaponFrame = false;
        this.currentAnim = "";
        const animKey = "draw_" + drawInfo.texture;
        if (!this.scene.anims.exists(animKey)) {
          this.scene.anims.create({
            key: animKey,
            frames: this.scene.anims.generateFrameNumbers(drawInfo.texture, {
              start: 0,
              end: drawInfo.frames - 1,
            }),
            frameRate: 20,
            repeat: 0,
          });
        }
        this.sprite.play(animKey);
        this.sprite.once("animationcomplete", () => {
          this.drawAnimPlaying = false;
          this.currentAnim = "";
        });
      }
    }
  }

  /** Play weapon fire animation (e.g. shotgun recoil), then return to normal */
  playFireAnim(): void {
    if (!this.sprite || !this.holdingWeapon) return;
    const fireTexture = WEAPON_FIRE_SPRITES[this.holdingWeapon];
    if (!fireTexture || !hasSpritesheet(this.scene, fireTexture)) return;

    // Show the fire sprite at current aim frame briefly
    this.applyWeaponAimFrame(fireTexture);
    // Return to normal aim after a short delay
    this.scene.time.delayedCall(300, () => {
      this.isShowingWeaponFrame = false;
      this.currentAnim = "";
    });
  }

  showAimLine(angle: number, _power: number): void {
    // Position crosshair sprite at fixed distance from worm
    if (this.crosshairSprite) {
      const distance = 100;
      this.crosshairSprite.setPosition(
        this.x + Math.cos(angle) * distance,
        this.y + Math.sin(angle) * distance,
      );
      this.crosshairSprite.setVisible(true);
    }
    // Hide the old graphics line
    this.aimLine.setVisible(false);
    this.aimLine.clear();
  }

  hideAimLine(): void {
    this.aimLine.setVisible(false);
    this.aimLine.clear();
    if (this.crosshairSprite) {
      this.crosshairSprite.setVisible(false);
    }
  }

  /** Show and update the radial power gauge near the worm */
  updatePowerGauge(power: number): void {
    this.powerValue = power;
    this.showPowerGauge = true;
    this.powerGauge.setVisible(true);
    this.drawPowerGauge();
  }

  hidePowerGauge(): void {
    this.showPowerGauge = false;
    this.powerGauge.setVisible(false);
    this.powerGauge.clear();
  }

  /**
   * Draw a Worms 2-style radial power gauge.
   * It's a filled arc (pie slice) that sweeps clockwise from the top.
   * Color goes from green (low) through yellow/orange to red (full).
   */
  private drawPowerGauge(): void {
    this.powerGauge.clear();
    if (!this.showPowerGauge || this.powerValue <= 0) return;

    const cx = this.x;
    const cy = this.y;
    const outerR = 18;
    const innerR = 8;
    const startAngle = -Math.PI / 2; // 12 o'clock
    const endAngle = startAngle + this.powerValue * Math.PI * 2;

    // Background ring (dark, semi-transparent)
    this.powerGauge.lineStyle(outerR - innerR, 0x000000, 0.3);
    this.powerGauge.beginPath();
    this.powerGauge.arc(cx, cy, (outerR + innerR) / 2, 0, Math.PI * 2);
    this.powerGauge.strokePath();

    // Filled arc segments with gradient coloring
    const segments = 32;
    const filledSegments = Math.ceil(this.powerValue * segments);
    const segAngle = (Math.PI * 2) / segments;

    for (let i = 0; i < filledSegments; i++) {
      const segStart = startAngle + i * segAngle;
      const segEnd = Math.min(segStart + segAngle, endAngle);
      if (segStart >= endAngle) break;

      // Color gradient: green → yellow → orange → red
      const t = i / segments;
      const color = this.getPowerColor(t);

      this.powerGauge.lineStyle(outerR - innerR, color, 0.9);
      this.powerGauge.beginPath();
      this.powerGauge.arc(
        cx,
        cy,
        (outerR + innerR) / 2,
        segStart,
        segEnd,
        false,
      );
      this.powerGauge.strokePath();
    }
  }

  private getPowerColor(t: number): number {
    // green (0) → yellow (0.33) → orange (0.66) → red (1)
    let r: number, g: number, b: number;
    if (t < 0.33) {
      const p = t / 0.33;
      r = Math.round(0x22 + (0xff - 0x22) * p);
      g = Math.round(0xcc + (0xcc - 0xcc) * p);
      b = Math.round(0x44 * (1 - p));
    } else if (t < 0.66) {
      const p = (t - 0.33) / 0.33;
      r = 0xff;
      g = Math.round(0xcc - (0xcc - 0x66) * p);
      b = 0x00;
    } else {
      const p = (t - 0.66) / 0.34;
      r = 0xff;
      g = Math.round(0x66 * (1 - p));
      b = 0x00;
    }
    return (r << 16) | (g << 8) | b;
  }

  update(): void {
    if (this.isDead) return;

    const lerp = 0.2;
    const curX = this.x;
    const curY = this.y;
    const newX = curX + (this.targetX - curX) * lerp;
    const newY = curY + (this.targetY - curY) * lerp;

    if (this.sprite) {
      this.sprite.x = newX;
      this.sprite.y = newY;
    } else if (this.fallbackBody) {
      this.fallbackBody.x = newX;
      this.fallbackBody.y = newY;
    }

    this.nameText.setPosition(newX, newY - 30);
    this.hpText.setPosition(newX, newY - 19);
    if (this.arrowSprite) {
      this.arrowSprite.setPosition(newX, newY - 50);
    }
    if (this.showPowerGauge) this.drawPowerGauge();
    this.updateAnimationState();
  }

  private updateAnimationState(): void {
    if (!this.usesSprites || !this.sprite || this.isDead) return;

    // Override animation (e.g. punch anim playing)
    if (this.overrideAnim === "worm_fist") return;

    // Jump/backflip animation takes priority while playing
    if (this.jumpAnimPlaying) return;

    // Weapon draw animation takes priority
    if (this.drawAnimPlaying) return;

    // Flying from knockback (not from jump — only when knocked by explosion)
    if (Math.abs(this.state.vx) > 40 || this.state.vy < -40) {
      this.isShowingWeaponFrame = false;
      this.playAnimation("worm_fly_anim");
      return;
    }

    // Falling
    if (this.state.vy > 30) {
      this.isShowingWeaponFrame = false;
      this.playAnimation("worm_fall_anim");
      return;
    }

    // Walking
    if (this.isWalking) {
      this.isShowingWeaponFrame = false;
      this.playAnimation("worm_walk");
      return;
    }

    // Override idle (bandana for fire punch)
    if (this.overrideAnim) {
      this.isShowingWeaponFrame = false;
      this.playAnimation(this.overrideAnim);
      return;
    }

    // Weapon aim pose: set texture + frame based on aim angle
    if (this.state.isActive && this.holdingWeapon) {
      const aimTexture = WEAPON_AIM_SPRITES[this.holdingWeapon];
      if (aimTexture) {
        this.applyWeaponAimFrame(aimTexture);
        return;
      }
    }

    this.isShowingWeaponFrame = false;
    this.playAnimation("worm_idle");
  }

  /**
   * Map the aim angle to the correct weapon sprite frame.
   *
   * Each weapon has a single 32-frame sheet covering the full aim arc.
   * Frame 0 = aiming most downward (+PI/2), frame 31 = aiming most upward (-PI/2).
   *
   * The default (unflipped) sprite faces LEFT. So the native aim direction
   * is left-horizontal (PI/-PI). When facing left, aimAngle maps directly.
   * When facing right (sprite is flipped), we mirror the angle.
   */
  private applyWeaponAimFrame(textureKey: string): void {
    if (!this.sprite) return;
    if (!hasSpritesheet(this.scene, textureKey)) return;

    // Convert atan2 angle to vertical angle relative to the sprite's native facing (LEFT)
    let vertAngle: number;
    if (this.state.facing === "left") {
      // Native direction: aimAngle of PI = horizontal left
      // Convert: vertAngle = PI - aimAngle mirrors around vertical axis
      vertAngle = Math.PI - this.aimAngle;
      if (vertAngle > Math.PI) vertAngle -= 2 * Math.PI;
    } else {
      // Flipped sprite: aimAngle of 0 = horizontal right, maps directly
      vertAngle = this.aimAngle;
    }

    // Clamp to [-PI/2, PI/2]
    vertAngle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, vertAngle));

    // Map from [-PI/2, PI/2] to [31, 0] (frame 31 = up, frame 0 = down)
    // vertAngle -PI/2 = up = frame 31, vertAngle +PI/2 = down = frame 0
    const t = (vertAngle + Math.PI / 2) / Math.PI; // 0 (up) .. 1 (down)
    const frame = Math.round((1 - t) * 31);

    // Stop any playing animation and set the texture + frame directly
    if (!this.isShowingWeaponFrame || this.sprite.texture.key !== textureKey) {
      this.sprite.stop();
      this.sprite.setTexture(textureKey, frame);
      this.currentAnim = "";
      this.isShowingWeaponFrame = true;
    } else {
      this.sprite.setFrame(frame);
    }
  }

  private playAnimation(key: string): void {
    if (!this.sprite || !this.scene.anims.exists(key)) return;
    if (this.currentAnim === key && !this.isShowingWeaponFrame) return;
    this.isShowingWeaponFrame = false;
    this.currentAnim = key;
    this.sprite.play(key, true);
  }

  flashDamage(damage: number): void {
    if (this.sprite) {
      this.sprite.setTint(0xff0000);
      this.scene.time.delayedCall(200, () => {
        if (this.state.isAlive && this.sprite) {
          this.sprite.clearTint();
        }
      });
    } else if (this.fallbackBody) {
      this.fallbackBody.setFillStyle(0xff0000);
      this.scene.time.delayedCall(200, () => {
        if (this.state.isAlive && this.fallbackBody) {
          this.fallbackBody.setFillStyle(COLOR_MAP[this.teamColor] ?? 0xffffff);
        }
      });
    }

    const dmgText = this.scene.add.text(this.x, this.y - 35, `-${damage}`, {
      fontSize: "14px",
      fontFamily: "monospace",
      color: "#ff4444",
      stroke: "#000000",
      strokeThickness: 3,
      fontStyle: "bold",
    });
    dmgText.setOrigin(0.5);
    dmgText.setDepth(10);

    this.scene.tweens.add({
      targets: dmgText,
      y: dmgText.y - 40,
      alpha: 0,
      duration: 1000,
      onComplete: () => dmgText.destroy(),
    });
  }

  private die(): void {
    this.isDead = true;

    if (
      this.usesSprites &&
      this.sprite &&
      this.scene.anims.exists("worm_die_anim")
    ) {
      this.sprite.play("worm_die_anim");
      this.sprite.once("animationcomplete", () => {
        if (this.sprite) {
          this.sprite.setVisible(false);
        }
        this.showGrave();
      });
    } else {
      if (this.fallbackBody) {
        this.fallbackBody.setFillStyle(0x666666);
        this.fallbackBody.setAlpha(0.5);
      }
      if (this.sprite) {
        this.sprite.setAlpha(0.5);
        this.sprite.setTint(0x666666);
      }
      this.showGrave();
    }

    this.nameText.setVisible(false);
    this.hpText.setVisible(false);
    this.hideArrow();
    this.hideAimLine();
  }

  private showGrave(): void {
    if (hasSpritesheet(this.scene, "grave")) {
      const grave = this.scene.add.sprite(this.x, this.y, "grave", 0);
      grave.setDepth(3);
      // Create and play idle grave animation
      const animKey = "grave_idle";
      if (!this.scene.anims.exists(animKey)) {
        this.scene.anims.create({
          key: animKey,
          frames: this.scene.anims.generateFrameNumbers("grave", {
            start: 0,
            end: 19,
          }),
          frameRate: 5,
          repeat: -1,
        });
      }
      grave.play(animKey);
    } else {
      const rip = this.scene.add.text(this.x, this.y - 10, "RIP", {
        fontSize: "8px",
        fontFamily: "monospace",
        color: "#888888",
        stroke: "#000000",
        strokeThickness: 1,
      });
      rip.setOrigin(0.5);
      rip.setDepth(3);
    }
  }

  destroy(): void {
    this.sprite?.destroy();
    this.fallbackBody?.destroy();
    this.nameText.destroy();
    this.hpText.destroy();
    this.aimLine.destroy();
    this.powerGauge.destroy();
    this.crosshairSprite?.destroy();
    this.hideArrow();
  }
}
