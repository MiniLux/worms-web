import * as Phaser from "phaser";
import type { WormState, TeamColor } from "@worms/shared";

const COLOR_MAP: Record<TeamColor, number> = {
  red: 0xef4444,
  blue: 0x3b82f6,
  green: 0x22c55e,
  yellow: 0xeab308,
};

export class WormEntity {
  private body: Phaser.GameObjects.Ellipse;
  private nameText: Phaser.GameObjects.Text;
  private hpBar: Phaser.GameObjects.Graphics;
  private aimLine: Phaser.GameObjects.Graphics;
  private state: WormState;
  private targetX: number;
  private targetY: number;

  constructor(
    private scene: Phaser.Scene,
    initialState: WormState,
    private teamColor: TeamColor,
  ) {
    this.state = { ...initialState };
    this.targetX = initialState.x;
    this.targetY = initialState.y;

    const color = COLOR_MAP[teamColor] ?? 0xffffff;

    // Worm body (simple ellipse for now)
    this.body = scene.add.ellipse(
      initialState.x,
      initialState.y,
      20,
      24,
      color,
    );
    this.body.setDepth(3);

    // Eyes
    const eyeX = initialState.facing === "right" ? 4 : -4;
    // Eyes are drawn as part of the body visual — we keep it simple

    // Name label
    this.nameText = scene.add.text(
      initialState.x,
      initialState.y - 24,
      initialState.name,
      {
        fontSize: "10px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      },
    );
    this.nameText.setOrigin(0.5, 1);
    this.nameText.setDepth(4);

    // HP bar
    this.hpBar = scene.add.graphics();
    this.hpBar.setDepth(4);
    this.drawHpBar();

    // Aim line (hidden by default)
    this.aimLine = scene.add.graphics();
    this.aimLine.setDepth(5);
    this.aimLine.setVisible(false);
  }

  get id(): string {
    return this.state.id;
  }

  get x(): number {
    return this.body.x;
  }

  get y(): number {
    return this.body.y;
  }

  updateState(newState: Partial<WormState>): void {
    Object.assign(this.state, newState);
    if (newState.x !== undefined) this.targetX = newState.x;
    if (newState.y !== undefined) this.targetY = newState.y;
    if (newState.facing !== undefined) {
      this.body.setScale(newState.facing === "left" ? -1 : 1, 1);
    }
    if (newState.health !== undefined) {
      this.drawHpBar();
    }
    if (newState.isAlive === false) {
      this.die();
    }
  }

  setActive(active: boolean): void {
    this.state.isActive = active;
    if (active) {
      // Highlight active worm
      this.body.setStrokeStyle(2, 0xffffff);
    } else {
      this.body.setStrokeStyle(0);
      this.hideAimLine();
    }
  }

  showAimLine(angle: number, power: number): void {
    this.aimLine.setVisible(true);
    this.aimLine.clear();

    const length = 40 + power * 80;
    const endX = this.body.x + Math.cos(angle) * length;
    const endY = this.body.y + Math.sin(angle) * length;

    this.aimLine.lineStyle(2, 0xffff00, 0.8);
    this.aimLine.lineBetween(this.body.x, this.body.y, endX, endY);

    // Draw crosshair at end
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
    // Lerp toward target position
    const lerp = 0.15;
    this.body.x += (this.targetX - this.body.x) * lerp;
    this.body.y += (this.targetY - this.body.y) * lerp;

    // Update name and HP bar positions
    this.nameText.setPosition(this.body.x, this.body.y - 24);
    this.drawHpBar();
  }

  flashDamage(damage: number): void {
    // Flash red
    this.body.setFillStyle(0xff0000);
    this.scene.time.delayedCall(200, () => {
      const color = COLOR_MAP[this.teamColor] ?? 0xffffff;
      if (this.state.isAlive) {
        this.body.setFillStyle(color);
      }
    });

    // Show damage number
    const dmgText = this.scene.add.text(
      this.body.x,
      this.body.y - 35,
      `-${damage}`,
      {
        fontSize: "14px",
        fontFamily: "monospace",
        color: "#ff4444",
        stroke: "#000000",
        strokeThickness: 3,
        fontStyle: "bold",
      },
    );
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
    this.body.setFillStyle(0x666666);
    this.body.setAlpha(0.5);
    this.nameText.setAlpha(0.5);
    this.hpBar.setVisible(false);
    this.hideAimLine();

    // Tombstone text
    const rip = this.scene.add.text(this.body.x, this.body.y - 10, "RIP", {
      fontSize: "8px",
      fontFamily: "monospace",
      color: "#888888",
      stroke: "#000000",
      strokeThickness: 1,
    });
    rip.setOrigin(0.5);
    rip.setDepth(3);
  }

  private drawHpBar(): void {
    this.hpBar.clear();
    const barWidth = 28;
    const barHeight = 4;
    const x = this.body.x - barWidth / 2;
    const y = this.body.y - 18;

    // Background
    this.hpBar.fillStyle(0x000000, 0.7);
    this.hpBar.fillRect(x - 1, y - 1, barWidth + 2, barHeight + 2);

    // Health fill
    const pct = Math.max(0, this.state.health / 100);
    const color = pct > 0.5 ? 0x22c55e : pct > 0.25 ? 0xeab308 : 0xef4444;
    this.hpBar.fillStyle(color, 1);
    this.hpBar.fillRect(x, y, barWidth * pct, barHeight);
  }

  destroy(): void {
    this.body.destroy();
    this.nameText.destroy();
    this.hpBar.destroy();
    this.aimLine.destroy();
  }
}
