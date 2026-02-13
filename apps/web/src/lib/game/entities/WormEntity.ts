import * as Phaser from "phaser";
import type { WormState, TeamColor, WeaponId } from "@worms/shared";

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

export class WormEntity {
  private sprite: Phaser.GameObjects.Sprite | null = null;
  private fallbackBody: Phaser.GameObjects.Ellipse | null = null;
  private nameText: Phaser.GameObjects.Text;
  private hpBar: Phaser.GameObjects.Graphics;
  private aimLine: Phaser.GameObjects.Graphics;
  private state: WormState;
  private targetX: number;
  private targetY: number;
  private currentAnim: string = "";
  private isWalking: boolean = false;
  private usesSprites: boolean = false;
  private isDead: boolean = false;
  private holdingWeapon: WeaponId | null = null;
  private overrideAnim: string | null = null;

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
      // No tint — sprites have proper transparency now
      this.sprite.setFlipX(initialState.facing === "left");
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

    // Name label colored by team
    this.nameText = scene.add.text(
      initialState.x,
      initialState.y - 28,
      initialState.name,
      {
        fontSize: "10px",
        fontFamily: "monospace",
        color: COLOR_HEX[teamColor] ?? "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      },
    );
    this.nameText.setOrigin(0.5, 1);
    this.nameText.setDepth(4);

    this.hpBar = scene.add.graphics();
    this.hpBar.setDepth(4);
    this.drawHpBar();

    this.aimLine = scene.add.graphics();
    this.aimLine.setDepth(5);
    this.aimLine.setVisible(false);
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
      // Weapon hold poses (first frame only)
      { key: "worm_baz_hold", texture: "worm_baz", end: 0, rate: 1, repeat: 0 },
      {
        key: "worm_throw_hold",
        texture: "worm_throw",
        end: 0,
        rate: 1,
        repeat: 0,
      },
      {
        key: "worm_shot_hold",
        texture: "worm_shotf",
        end: 0,
        rate: 1,
        repeat: 0,
      },
      // Fire punch: bandana idle, fist punch, fire blast
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

    // Update facing from explicit field OR from velocity direction
    if (newState.facing !== undefined) {
      this.applyFacing(newState.facing);
    } else if (newState.vx !== undefined && Math.abs(newState.vx) > 5) {
      const inferred = newState.vx > 0 ? "right" : "left";
      this.state.facing = inferred;
      this.applyFacing(inferred);
    }

    if (newState.health !== undefined) {
      this.drawHpBar();
    }
    if (newState.isAlive === false && !this.isDead) {
      this.die();
    }

    if (newState.vx !== undefined) {
      this.isWalking =
        Math.abs(this.state.vx) > 1 && Math.abs(this.state.vy) < 5;
    }
  }

  private applyFacing(facing: "left" | "right"): void {
    if (this.sprite) {
      this.sprite.setFlipX(facing === "left");
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
    if (!active) {
      this.hideAimLine();
      this.holdingWeapon = null;
      this.overrideAnim = null;
    }
  }

  /** Set weapon hold pose for the active worm */
  setWeaponHold(weaponId: WeaponId | null): void {
    this.holdingWeapon = weaponId;
    if (weaponId === "fire_punch") {
      this.overrideAnim = "worm_japbak";
    } else {
      this.overrideAnim = null;
    }
  }

  /** Play the punch animation, returns a promise that resolves when done */
  playPunchAnim(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.sprite || !this.scene.anims.exists("worm_fist")) {
        resolve();
        return;
      }
      this.overrideAnim = "worm_fist";
      this.currentAnim = "";
      this.sprite.play("worm_fist");
      this.sprite.once("animationcomplete", () => {
        this.overrideAnim = "worm_japbak";
        this.currentAnim = "";
        resolve();
      });
    });
  }

  showAimLine(angle: number, power: number): void {
    this.aimLine.setVisible(true);
    this.aimLine.clear();

    const length = 40 + power * 80;
    const endX = this.x + Math.cos(angle) * length;
    const endY = this.y + Math.sin(angle) * length;

    this.aimLine.lineStyle(2, 0xffff00, 0.8);
    this.aimLine.lineBetween(this.x, this.y, endX, endY);

    const ch = 6;
    this.aimLine.lineStyle(1, 0xff0000, 1);
    this.aimLine.lineBetween(endX - ch, endY, endX + ch, endY);
    this.aimLine.lineBetween(endX, endY - ch, endX, endY + ch);
  }

  hideAimLine(): void {
    this.aimLine.setVisible(false);
    this.aimLine.clear();
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

    this.nameText.setPosition(newX, newY - 28);
    this.drawHpBar();
    this.updateAnimationState();
  }

  private updateAnimationState(): void {
    if (!this.usesSprites || !this.sprite || this.isDead) return;

    // Override animation (e.g. punch anim playing)
    if (this.overrideAnim === "worm_fist") return; // let it finish

    // Flying from knockback
    if (Math.abs(this.state.vx) > 10 || this.state.vy < -20) {
      this.playAnimation("worm_fly_anim");
      return;
    }

    // Falling
    if (this.state.vy > 30) {
      this.playAnimation("worm_fall_anim");
      return;
    }

    // Walking
    if (this.isWalking) {
      this.playAnimation("worm_walk");
      return;
    }

    // Override idle with weapon-specific pose
    if (this.overrideAnim) {
      this.playAnimation(this.overrideAnim);
      return;
    }

    // Weapon hold poses (only when idle on ground)
    if (this.state.isActive && this.holdingWeapon) {
      const holdAnim = this.getWeaponHoldAnim(this.holdingWeapon);
      if (holdAnim) {
        this.playAnimation(holdAnim);
        return;
      }
    }

    this.playAnimation("worm_idle");
  }

  private getWeaponHoldAnim(weaponId: WeaponId): string | null {
    switch (weaponId) {
      case "bazooka":
        return "worm_baz_hold";
      case "grenade":
        return "worm_throw_hold";
      case "shotgun":
        return "worm_shot_hold";
      default:
        return null;
    }
  }

  private playAnimation(key: string): void {
    if (!this.sprite || !this.scene.anims.exists(key)) return;
    if (this.currentAnim === key) return;
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

    this.nameText.setAlpha(0.5);
    this.hpBar.setVisible(false);
    this.hideAimLine();
  }

  private showGrave(): void {
    if (hasSpritesheet(this.scene, "grave")) {
      const grave = this.scene.add.sprite(this.x, this.y, "grave", 0);
      grave.setDepth(3);
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

  private drawHpBar(): void {
    this.hpBar.clear();
    const barWidth = 28;
    const barHeight = 4;
    const x = this.x - barWidth / 2;
    const y = this.y - 22;

    // Background
    this.hpBar.fillStyle(0x000000, 0.7);
    this.hpBar.fillRect(x - 1, y - 1, barWidth + 2, barHeight + 2);

    // Health fill
    const pct = Math.max(0, this.state.health / 100);
    const color = pct > 0.5 ? 0x22c55e : pct > 0.25 ? 0xeab308 : 0xef4444;
    this.hpBar.fillStyle(color, 1);
    this.hpBar.fillRect(x, y, barWidth * pct, barHeight);

    // Team color indicator bar (thin stripe under HP bar)
    const teamColor = COLOR_MAP[this.teamColor] ?? 0xffffff;
    this.hpBar.fillStyle(teamColor, 1);
    this.hpBar.fillRect(x, y + barHeight + 1, barWidth, 2);
  }

  destroy(): void {
    this.sprite?.destroy();
    this.fallbackBody?.destroy();
    this.nameText.destroy();
    this.hpBar.destroy();
    this.aimLine.destroy();
  }
}
