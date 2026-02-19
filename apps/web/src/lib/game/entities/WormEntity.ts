import * as Phaser from "phaser";
import type { WormState, TeamColor, WeaponId } from "@worms/shared";
import { getBitmapPixel } from "@worms/shared";
import { createExplosion } from "../effects/ExplosionEffect";

const COLOR_MAP: Record<TeamColor, number> = {
  red: 0xef4444,
  blue: 0x3b82f6,
  green: 0x22c55e,
  yellow: 0xeab308,
};

const COLOR_HEX: Record<TeamColor, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
};

function hasSpritesheet(scene: Phaser.Scene, key: string): boolean {
  return scene.textures.exists(key) && key !== "__MISSING";
}

/**
 * Weapon aim sprite config.
 * Each weapon has a base spritesheet with 32 frames covering the full aim arc.
 * Frame 0 = aiming most downward, frame 31 = aiming most upward.
 * (The u/d variants are for uphill/downhill terrain slopes — we use base only.)
 */
const WEAPON_AIM_SPRITES: Record<string, string> = {
  bazooka: "worm_baz",
  grenade: "worm_thrgrn",
  shotgun: "worm_shotg",
  teleport: "worm_teltlk",
};

/** Weapon "draw/get" animation played when worm stops walking and has a weapon */
const WEAPON_DRAW_SPRITES: Record<string, { texture: string; frames: number }> =
  {
    shotgun: { texture: "worm_shglnk", frames: 10 },
    bazooka: { texture: "worm_bazlnk", frames: 7 },
    grenade: { texture: "worm_grnlnk", frames: 10 },
    teleport: { texture: "worm_tellnk", frames: 10 },
  };

/** Weapon fire animation (played once on firing) */
const WEAPON_FIRE_SPRITES: Record<string, string> = {
  shotgun: "worm_shotf",
};

/** Weapon put-away (gun-in) animation sprites.
 *  reverse=true: play the draw sprite backwards (shotgun, bazooka).
 *  reverse=false: dedicated put-away sprite played forward (grenade, teleport). */
const WEAPON_PUTAWAY_SPRITES: Record<
  string,
  { texture: string; frames: number; reverse: boolean }
> = {
  shotgun: { texture: "worm_shgbak", frames: 10, reverse: false },
  bazooka: { texture: "worm_bazlnk", frames: 7, reverse: true },
  grenade: { texture: "worm_grnbak", frames: 10, reverse: false },
  teleport: { texture: "worm_telbak", frames: 10, reverse: false },
};

export class WormEntity {
  private sprite: Phaser.GameObjects.Sprite | null = null;
  private fallbackBody: Phaser.GameObjects.Ellipse | null = null;
  private nameText: Phaser.GameObjects.Text;
  private hpText: Phaser.GameObjects.Text;
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
  private isJumping: boolean = false; // true from jump until landing (voluntary jump, not knockback)
  private drawAnimPlaying: boolean = false;
  private powerGauge: Phaser.GameObjects.Graphics;
  private powerValue: number = 0;
  private showPowerGauge: boolean = false;
  private crosshairSprite: Phaser.GameObjects.Sprite | null = null;
  private crosshairTween: Phaser.Tweens.Tween | null = null;
  private arrowSprite: Phaser.GameObjects.Sprite | null = null;
  private labelsHidden: boolean = false;
  private nameBg: Phaser.GameObjects.Graphics;
  private hpBg: Phaser.GameObjects.Graphics;
  private graveSprite: Phaser.GameObjects.Sprite | null = null;
  private graveVy: number = 0;

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

    // Black rounded backgrounds for name and HP
    this.nameBg = scene.add.graphics();
    this.nameBg.setDepth(3.5);
    this.hpBg = scene.add.graphics();
    this.hpBg.setDepth(3.5);

    this.nameText = scene.add.text(
      initialState.x,
      initialState.y - 30,
      initialState.name,
      {
        fontSize: "10px",
        fontFamily: "monospace",
        color: COLOR_HEX[teamColor] ?? "#ffffff",
      },
    );
    this.nameText.setOrigin(0.5, 1);
    this.nameText.setDepth(4);

    this.hpText = scene.add.text(
      initialState.x,
      initialState.y - 19,
      String(initialState.health),
      {
        fontSize: "10px",
        fontFamily: "monospace",
        color: COLOR_HEX[teamColor] ?? "#ffffff",
      },
    );
    this.hpText.setOrigin(0.5, 1);
    this.hpText.setDepth(4);

    this.drawLabelBackgrounds();

    this.aimLine = scene.add.graphics();
    this.aimLine.setDepth(5);
    this.aimLine.setVisible(false);

    // Crosshair sprite (static, team colored — positioned along aim direction)
    const crosshairKey =
      teamColor === "blue" ? "crosshair_blue" : "crosshair_red";
    if (hasSpritesheet(scene, crosshairKey)) {
      this.crosshairSprite = scene.add.sprite(0, 0, crosshairKey, 0);
      this.crosshairSprite.setDepth(7);
      this.crosshairSprite.setScale(1.0);
      this.crosshairSprite.setVisible(false);
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
      yoyo?: boolean;
    }> = [
      {
        key: "worm_idle",
        texture: "worm_breath",
        end: 19,
        rate: 30,
        repeat: -1,
        yoyo: true,
      },
      {
        key: "worm_walk",
        texture: "worm_walk",
        end: 14,
        rate: 30,
        repeat: -1,
        yoyo: true,
      },
      {
        key: "worm_jump_anim",
        texture: "worm_jump",
        end: 9,
        rate: 30,
        repeat: 0,
      },
      {
        key: "worm_backflip_anim",
        texture: "worm_backflip",
        end: 21,
        rate: 30,
        repeat: 0,
      },
      {
        key: "worm_fall_anim",
        texture: "worm_fall",
        end: 1,
        rate: 30,
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
        rate: 30,
        repeat: -1,
      },
      {
        key: "worm_blink_anim",
        texture: "worm_blink",
        end: 5,
        rate: 30,
        repeat: 0,
      },
      // Fire punch
      {
        key: "worm_japbak",
        texture: "worm_japbak",
        end: 8,
        rate: 30,
        repeat: -1,
      },
      { key: "worm_fist", texture: "worm_fist", end: 16, rate: 30, repeat: 0 },
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
        yoyo: d.yoyo ?? false,
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
      this.hpText.setText(String(this.state.health));
      if (!this.labelsHidden && !this.isDead) {
        this.drawLabelBackgrounds();
      }
    }
    if (newState.isAlive === false && !this.isDead) {
      this.die();
    }

    if (newState.vx !== undefined && !this.walkingExplicit) {
      this.isWalking =
        Math.abs(this.state.vx) > 1 && Math.abs(this.state.vy) < 5;
    }

    // Clear jump flag when worm has landed (velocity near zero)
    if (
      this.isJumping &&
      Math.abs(this.state.vx) < 5 &&
      Math.abs(this.state.vy) < 5
    ) {
      this.isJumping = false;
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
      this.nameBg.setVisible(false);
      this.hpBg.setVisible(false);
      // Show bouncing arrow above head
      this.showArrow();
    } else {
      // Show name/HP when turn ends
      this.labelsHidden = false;
      if (!this.isDead) {
        this.nameText.setVisible(true);
        this.hpText.setVisible(true);
        this.nameBg.setVisible(true);
        this.hpBg.setVisible(true);
        this.drawLabelBackgrounds();
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
        frameRate: 30,
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
    // Forward jump: play worm_jump_anim (pre-jump crouch + launch)
    // Backflip: play worm_backflip_anim (the full backflip)
    const animKey =
      kind === "backflip" ? "worm_backflip_anim" : "worm_jump_anim";
    if (!this.scene.anims.exists(animKey)) return;
    this.jumpAnimPlaying = true;
    this.isJumping = true;
    this.isWalking = false;
    this.walkingExplicit = false;
    this.isShowingWeaponFrame = false;
    this.holdingWeapon = null;
    this.overrideAnim = null;
    this.currentAnim = "";
    this.hideAimLine();

    // Backflip: keep the current facing direction — the worm looks forward
    // while somersaulting backward. No special flip needed.

    this.sprite.play(animKey);
    this.sprite.once("animationcomplete", () => {
      this.jumpAnimPlaying = false;
      this.currentAnim = "";
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
            frameRate: 30,
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

  /** Play weapon put-away (gun-in) animation */
  playPutAwayAnim(): void {
    if (!this.sprite) return;
    const weaponId = this.holdingWeapon;
    if (!weaponId) return;

    const info = WEAPON_PUTAWAY_SPRITES[weaponId];
    if (!info || !hasSpritesheet(this.scene, info.texture)) return;

    const animKey = "putaway_" + info.texture;
    if (!this.scene.anims.exists(animKey)) {
      let frames: Array<{ key: string; frame: number }>;
      if (info.reverse) {
        // Reversed draw sprite (shotgun, bazooka)
        frames = [];
        for (let i = info.frames - 1; i >= 0; i--) {
          frames.push({ key: info.texture, frame: i });
        }
      } else {
        // Dedicated forward-playing put-away sprite (grenade, teleport)
        frames = this.scene.anims.generateFrameNumbers(info.texture, {
          start: 0,
          end: info.frames - 1,
        }) as Array<{ key: string; frame: number }>;
      }
      this.scene.anims.create({
        key: animKey,
        frames,
        frameRate: 30,
        repeat: 0,
      });
    }

    this.drawAnimPlaying = true;
    this.isShowingWeaponFrame = false;
    this.currentAnim = "";
    this.sprite.play(animKey);
    this.sprite.once("animationcomplete", () => {
      this.drawAnimPlaying = false;
      this.currentAnim = "";
      this.holdingWeapon = null;
    });
  }

  /** Smoothly scale crosshair in/out */
  private scaleCrosshairTo(targetScale: number, duration: number = 30): void {
    if (!this.crosshairSprite) return;
    if (this.crosshairTween) {
      this.crosshairTween.stop();
      this.crosshairTween = null;
    }
    if (targetScale <= 0) {
      this.crosshairTween = this.scene.tweens.add({
        targets: this.crosshairSprite,
        scaleX: 0,
        scaleY: 0,
        duration,
        ease: "Power2",
        onComplete: () => {
          this.crosshairSprite?.setVisible(false);
          this.crosshairTween = null;
        },
      });
    } else {
      this.crosshairSprite.setVisible(true);
      this.crosshairTween = this.scene.tweens.add({
        targets: this.crosshairSprite,
        scaleX: targetScale,
        scaleY: targetScale,
        duration,
        ease: "Power2",
        onComplete: () => {
          this.crosshairTween = null;
        },
      });
    }
  }

  showAimLine(angle: number, _power: number): void {
    // Only show crosshair when the worm is stationary and holding a weapon
    // (not while walking, jumping, or airborne)
    if (this.crosshairSprite) {
      const shouldShow =
        !this.isWalking &&
        !this.jumpAnimPlaying &&
        !this.isJumping &&
        !this.drawAnimPlaying &&
        this.holdingWeapon !== null &&
        this.holdingWeapon !== "teleport" &&
        this.holdingWeapon !== "fire_punch";

      if (shouldShow) {
        const distance = 100;
        this.crosshairSprite.setPosition(
          this.x + Math.cos(angle) * distance,
          this.y + Math.sin(angle) * distance,
        );
        // Pick frame based on aim angle (32 frames, frame 0 = up, clockwise)
        let normalizedAngle = angle + Math.PI / 2; // offset so 0 = up
        if (normalizedAngle < 0) normalizedAngle += 2 * Math.PI;
        normalizedAngle = normalizedAngle % (2 * Math.PI);
        const frame = Math.round((normalizedAngle / (2 * Math.PI)) * 32) % 32;
        this.crosshairSprite.setFrame(frame);
        if (
          !this.crosshairSprite.visible ||
          this.crosshairSprite.scaleX < 1.0
        ) {
          this.scaleCrosshairTo(1.0);
        }
      } else {
        if (this.crosshairSprite.visible && this.crosshairSprite.scaleX > 0) {
          this.scaleCrosshairTo(0);
        }
      }
    }
    // Hide the old graphics line
    this.aimLine.setVisible(false);
    this.aimLine.clear();
  }

  /** Draw rounded black backgrounds behind name and HP labels */
  private drawLabelBackgrounds(): void {
    const pad = 3;
    const radius = 4;

    // Name background
    this.nameBg.clear();
    const nw = this.nameText.width + pad * 2;
    const nh = this.nameText.height + pad * 2;
    const nx = this.nameText.x - nw / 2;
    const ny = this.nameText.y - nh + pad;
    this.nameBg.fillStyle(0x000000, 0.4);
    this.nameBg.fillRoundedRect(nx, ny, nw, nh, radius);
    this.nameBg.lineStyle(1, 0xffffff, 0.1);
    this.nameBg.strokeRoundedRect(nx, ny, nw, nh, radius);

    // HP background
    this.hpBg.clear();
    const hw = this.hpText.width + pad * 2;
    const hh = this.hpText.height + pad * 2;
    const hx = this.hpText.x - hw / 2;
    const hy = this.hpText.y - hh + pad;
    this.hpBg.fillStyle(0x000000, 0.4);
    this.hpBg.fillRoundedRect(hx, hy, hw, hh, radius);
    this.hpBg.lineStyle(1, 0xffffff, 0.1);
    this.hpBg.strokeRoundedRect(hx, hy, hw, hh, radius);
  }

  hideAimLine(): void {
    this.aimLine.setVisible(false);
    this.aimLine.clear();
    if (this.crosshairSprite) {
      this.scaleCrosshairTo(0);
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
   * Draw a Worms 2-style cone power gauge.
   * A triangular gradient beam emanating from the worm in the aim direction.
   * Narrow at the worm, wide at the tip. Color: green → yellow → orange → red.
   */
  private drawPowerGauge(): void {
    this.powerGauge.clear();
    if (!this.showPowerGauge || this.powerValue <= 0) return;

    const cx = this.x;
    const cy = this.y;
    const angle = this.aimAngle;
    const maxLength = 70;
    const length = maxLength * this.powerValue;
    const halfSpread = 0.25; // radians — half-angle of the cone

    // Draw cone as layered segments for gradient effect
    const segments = 16;
    const segLen = length / segments;

    for (let i = 0; i < segments; i++) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const d0 = segLen * i;
      const d1 = segLen * (i + 1);

      // Cone width grows with distance
      const w0 = d0 * Math.tan(halfSpread);
      const w1 = d1 * Math.tan(halfSpread);

      // Perpendicular direction
      const px = -Math.sin(angle);
      const py = Math.cos(angle);

      // Four corners of this segment
      const x0l = cx + Math.cos(angle) * d0 + px * w0;
      const y0l = cy + Math.sin(angle) * d0 + py * w0;
      const x0r = cx + Math.cos(angle) * d0 - px * w0;
      const y0r = cy + Math.sin(angle) * d0 - py * w0;
      const x1l = cx + Math.cos(angle) * d1 + px * w1;
      const y1l = cy + Math.sin(angle) * d1 + py * w1;
      const x1r = cx + Math.cos(angle) * d1 - px * w1;
      const y1r = cy + Math.sin(angle) * d1 - py * w1;

      // Color gradient along the cone
      const color = this.getPowerColor(t0);
      const alpha = 0.7 - t1 * 0.3; // fade out toward tip

      this.powerGauge.fillStyle(color, alpha);
      this.powerGauge.beginPath();
      this.powerGauge.moveTo(x0l, y0l);
      this.powerGauge.lineTo(x1l, y1l);
      this.powerGauge.lineTo(x1r, y1r);
      this.powerGauge.lineTo(x0r, y0r);
      this.powerGauge.closePath();
      this.powerGauge.fillPath();
    }

    // Rounded cap at the tip of the cone
    if (length > 0) {
      const tipX = cx + Math.cos(angle) * length;
      const tipY = cy + Math.sin(angle) * length;
      const tipRadius = length * Math.tan(halfSpread);
      const capColor = this.getPowerColor(1);
      const capAlpha = 0.7 - 1 * 0.3;
      this.powerGauge.fillStyle(capColor, capAlpha);
      this.powerGauge.fillCircle(tipX, tipY, tipRadius);
    }
  }

  private getPowerColor(t: number): number {
    // green → yellow → orange → red
    let r: number, g: number, b: number;
    if (t < 0.33) {
      const p = t / 0.33;
      r = Math.round(0x44 + (0xff - 0x44) * p);
      g = 0xcc;
      b = 0x00;
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

    // Walking: snap directly to server position for fluid movement.
    // Airborne/knockback: smooth lerp to avoid jerky appearance.
    const curX = this.x;
    const curY = this.y;
    let newX: number, newY: number;
    if (this.isWalking) {
      newX = this.targetX;
      newY = this.targetY;
    } else {
      const lerp = 0.2;
      newX = curX + (this.targetX - curX) * lerp;
      newY = curY + (this.targetY - curY) * lerp;
    }

    if (this.sprite) {
      this.sprite.x = newX;
      this.sprite.y = newY;
    } else if (this.fallbackBody) {
      this.fallbackBody.x = newX;
      this.fallbackBody.y = newY;
    }

    this.nameText.setPosition(newX, newY - 30);
    this.hpText.setPosition(newX, newY - 19);
    if (!this.labelsHidden && !this.isDead) {
      this.drawLabelBackgrounds();
    }
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

    // Airborne: use fall anim for voluntary jumps, fly anim for knockback
    const airborne =
      Math.abs(this.state.vx) > 40 || this.state.vy < -40 || this.state.vy > 30;
    if (airborne) {
      this.isShowingWeaponFrame = false;
      if (this.isJumping) {
        // Voluntary jump — use the gentle fall animation
        this.playAnimation("worm_fall_anim");
      } else {
        // Knockback from explosion — use the tumbling fly animation
        this.playAnimation("worm_fly_anim");
      }
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

    // Get the actual number of frames in this spritesheet
    const maxFrame = this.scene.textures.get(textureKey).frameTotal - 2; // frameTotal includes __BASE

    // Map from [-PI/2, PI/2] to [maxFrame, 0] (last frame = up, frame 0 = down)
    const t = (vertAngle + Math.PI / 2) / Math.PI; // 0 (up) .. 1 (down)
    const frame = Math.round((1 - t) * maxFrame);

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
        // Worms 2-style death explosion before grave appears
        createExplosion(this.scene, this.x, this.y, 20);
        if (this.sprite) {
          this.sprite.setVisible(false);
        }
        this.showGrave();
      });
    } else {
      createExplosion(this.scene, this.x, this.y, 20);
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
    this.nameBg.setVisible(false);
    this.hpBg.setVisible(false);
    this.hideArrow();
    this.hideAimLine();
  }

  private showGrave(): void {
    if (hasSpritesheet(this.scene, "grave")) {
      this.graveSprite = this.scene.add.sprite(this.x, this.y, "grave", 0);
      this.graveSprite.setDepth(3);
      // Create and play idle grave animation
      const animKey = "grave_idle";
      if (!this.scene.anims.exists(animKey)) {
        this.scene.anims.create({
          key: animKey,
          frames: this.scene.anims.generateFrameNumbers("grave", {
            start: 0,
            end: 19,
          }),
          frameRate: 30,
          repeat: -1,
          yoyo: true,
        });
      }
      this.graveSprite.play(animKey);
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

  /** Apply gravity to the grave sprite if terrain below has been destroyed.
   *  Called from GameScene with the current terrain bitmap. */
  updateGrave(bitmap: Uint8Array): void {
    if (!this.graveSprite) return;
    const gx = Math.round(this.graveSprite.x);
    const gy = Math.round(this.graveSprite.y);
    const feetY = gy + 15; // half of the grave height (~30px sprite)

    // Check if there's solid terrain under the grave
    const hasTerrain =
      feetY < 680 && feetY >= 0 && getBitmapPixel(bitmap, gx, feetY);

    if (hasTerrain) {
      this.graveVy = 0;
      return;
    }

    // No terrain — apply gravity
    const dt = this.scene.game.loop.delta / 1000;
    this.graveVy += 400 * dt; // gravity
    this.graveSprite.y += this.graveVy * dt;

    // Find surface below and snap to it
    for (let y = Math.round(this.graveSprite.y) + 15; y < 680; y++) {
      if (getBitmapPixel(bitmap, gx, y)) {
        this.graveSprite.y = y - 15;
        this.graveVy = 0;
        return;
      }
    }

    // Fell into water — hide
    if (this.graveSprite.y > 680) {
      this.graveSprite.destroy();
      this.graveSprite = null;
    }
  }

  destroy(): void {
    this.sprite?.destroy();
    this.fallbackBody?.destroy();
    this.nameText.destroy();
    this.hpText.destroy();
    this.nameBg.destroy();
    this.hpBg.destroy();
    this.aimLine.destroy();
    this.powerGauge.destroy();
    this.crosshairTween?.stop();
    this.crosshairSprite?.destroy();
    this.graveSprite?.destroy();
    this.hideArrow();
  }
}
