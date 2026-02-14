import * as Phaser from "phaser";
import type { GameState, WeaponId } from "@worms/shared";
import { WEAPON_DEFINITIONS, MVP_WEAPON_IDS } from "@worms/shared";
import { GameScene } from "./GameScene";

export class HUDScene extends Phaser.Scene {
  private timerText!: Phaser.GameObjects.Text;
  private turnText!: Phaser.GameObjects.Text;
  private weaponButtons: Phaser.GameObjects.Container[] = [];
  private playerPanels: Phaser.GameObjects.Container[] = [];
  private playerId: string = "";
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timeRemaining: number = 45;

  // Wind display
  private windContainer!: Phaser.GameObjects.Container;
  private windArrows: Phaser.GameObjects.Image[] = [];
  private windLabel!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "HUDScene" });
  }

  create(): void {
    this.playerId = this.registry.get("playerId") as string;
    const { width, height } = this.cameras.main;

    // Timer (bottom-left corner)
    this.timerText = this.add
      .text(20, height - 20, "45", {
        fontSize: "24px",
        fontFamily: "monospace",
        color: "#ffcc00",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0, 1)
      .setDepth(20);

    // Turn indicator (top-left)
    this.turnText = this.add
      .text(16, 16, "", {
        fontSize: "12px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0, 0)
      .setDepth(20);

    // Wind display (bottom-right corner)
    this.createWindDisplay();

    // Weapon bar (bottom center)
    this.createWeaponBar();

    // Listen for events from GameScene
    const gameScene = this.scene.get("GameScene");
    gameScene.events.on("aim_update", this.onAimUpdate, this);
    gameScene.events.on("power_update", this.onPowerUpdate, this);
    gameScene.events.on("weapon_selected", this.onWeaponSelected, this);
    gameScene.events.on("charge_start", this.onChargeStart, this);

    // Listen for network events forwarded by GameScene
    this.events.on("state_sync", this.onStateSync, this);
    this.events.on("turn_start", this.onTurnStart, this);
    this.events.on("timer_sync", this.onTimerSync, this);
    this.events.on("game_over", this.onGameOver, this);
    this.events.on("chat", this.onChat, this);

    // Handle window resize
    this.scale.on("resize", (gameSize: Phaser.Structs.Size) => {
      this.cameras.main.setSize(gameSize.width, gameSize.height);
    });
  }

  // ─── Wind Display ──────────────────────────────────────

  private createWindDisplay(): void {
    const { width, height } = this.cameras.main;
    this.windContainer = this.add.container(width - 20, height - 20);
    this.windContainer.setDepth(20);

    this.windLabel = this.add
      .text(0, 0, "WIND", {
        fontSize: "8px",
        fontFamily: "monospace",
        color: "#aaaaaa",
        stroke: "#000000",
        strokeThickness: 1,
      })
      .setOrigin(1, 1);
    this.windContainer.add(this.windLabel);
  }

  private updateWind(wind: number): void {
    // Clear old arrows
    for (const arrow of this.windArrows) arrow.destroy();
    this.windArrows = [];

    const absWind = Math.abs(wind);
    if (absWind < 3) {
      this.windLabel.setText("WIND: calm");
      return;
    }

    this.windLabel.setText("WIND");

    // Number of arrows based on wind strength (1-5)
    const arrowCount = Math.min(5, Math.max(1, Math.ceil(absWind / 20)));
    const textureKey = wind > 0 ? "wind_right" : "wind_left";
    const hasTexture = this.textures.exists(textureKey);

    if (!hasTexture) {
      // Fallback to text arrows
      const dir = wind > 0 ? ">" : "<";
      this.windLabel.setText("WIND " + dir.repeat(arrowCount));
      return;
    }

    // Stack arrows horizontally
    const arrowWidth = 20; // display width per arrow
    const startX = -arrowCount * arrowWidth;

    for (let i = 0; i < arrowCount; i++) {
      const arrow = this.add.image(
        startX + i * arrowWidth + arrowWidth / 2,
        -14,
        textureKey,
      );
      arrow.setDisplaySize(18, 6);
      arrow.setOrigin(0.5, 0.5);
      // Color arrows based on wind strength: green → yellow → red
      const t = i / Math.max(1, arrowCount - 1);
      const tint = this.getWindTint(t, absWind);
      arrow.setTint(tint);
      this.windContainer.add(arrow);
      this.windArrows.push(arrow);
    }
  }

  private getWindTint(t: number, absWind: number): number {
    // Low wind: green, medium: yellow, high: red
    const intensity = absWind / 100;
    if (intensity < 0.33) return 0x44ff44;
    if (intensity < 0.66) return 0xffff44;
    return 0xff4444;
  }

  // ─── Event Handlers ────────────────────────────────────

  private onStateSync(state: GameState): void {
    this.timeRemaining = state.turnTimeRemaining;
    this.timerText.setText(String(this.timeRemaining));
    this.updateWind(state.wind);
    this.updateTurnText(state.activePlayerId === this.playerId);
    this.updatePlayerPanels(state);
  }

  private onTurnStart(msg: {
    activePlayerId: string;
    activeWormId: string;
    wind: number;
    turnTime: number;
  }): void {
    this.timeRemaining = msg.turnTime;
    this.timerText.setText(String(this.timeRemaining));
    this.timerText.setColor("#ffcc00");
    this.updateWind(msg.wind);

    const isMyTurn = msg.activePlayerId === this.playerId;
    this.updateTurnText(isMyTurn);

    // Start countdown
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.timeRemaining = Math.max(0, this.timeRemaining - 1);
      this.timerText.setText(String(this.timeRemaining));
      if (this.timeRemaining <= 5) {
        this.timerText.setColor("#ff4444");
      } else if (this.timeRemaining <= 10) {
        this.timerText.setColor("#ffaa00");
      }
    }, 1000);
  }

  private onTimerSync(remaining: number): void {
    this.timeRemaining = remaining;
    this.timerText.setText(String(remaining));
  }

  private onAimUpdate(_angle: number): void {}
  private onPowerUpdate(_power: number): void {}
  private onChargeStart(): void {}
  private onWeaponSelected(_weaponId: WeaponId): void {}

  private onGameOver(msg: { winnerId: string | null; reason: string }): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    const { width, height } = this.cameras.main;

    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.7);

    const isWinner = msg.winnerId === this.playerId;
    this.add
      .text(
        width / 2,
        height / 2 - 30,
        isWinner ? "VICTORY!" : msg.winnerId ? "DEFEAT" : "DRAW",
        {
          fontSize: "32px",
          fontFamily: "monospace",
          color: isWinner ? "#ffcc00" : "#ff4444",
          stroke: "#000000",
          strokeThickness: 4,
        },
      )
      .setOrigin(0.5);

    this.add
      .text(width / 2, height / 2 + 10, msg.reason, {
        fontSize: "14px",
        fontFamily: "monospace",
        color: "#cccccc",
      })
      .setOrigin(0.5);

    const backBtn = this.add
      .text(width / 2, height / 2 + 50, "[ Back to Dashboard ]", {
        fontSize: "14px",
        fontFamily: "monospace",
        color: "#ffffff",
        backgroundColor: "#333333",
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    backBtn.on("pointerdown", () => {
      window.location.href = "/dashboard";
    });
    backBtn.on("pointerover", () => backBtn.setColor("#ffcc00"));
    backBtn.on("pointerout", () => backBtn.setColor("#ffffff"));
  }

  private onChat(msg: {
    playerId: string;
    displayName: string;
    text: string;
  }): void {
    const chatText = this.add
      .text(16, 200, `${msg.displayName}: ${msg.text}`, {
        fontSize: "10px",
        fontFamily: "monospace",
        color: "#cccccc",
        stroke: "#000000",
        strokeThickness: 1,
      })
      .setDepth(20);

    this.tweens.add({
      targets: chatText,
      alpha: 0,
      y: chatText.y - 20,
      delay: 3000,
      duration: 1000,
      onComplete: () => chatText.destroy(),
    });
  }

  // ─── UI Drawing ─────────────────────────────────────────

  private updateTurnText(isMyTurn: boolean): void {
    this.turnText.setText(isMyTurn ? "YOUR TURN" : "Opponent's turn");
    this.turnText.setColor(isMyTurn ? "#22c55e" : "#999999");
  }

  private createWeaponBar(): void {
    const { width, height } = this.cameras.main;
    const btnSize = 48;
    const gap = 6;
    const totalWidth = MVP_WEAPON_IDS.length * (btnSize + gap) - gap;
    const startX = width / 2 - totalWidth / 2;

    const WEAPON_ICON_MAP: Record<string, string> = {
      bazooka: "icon_bazooka",
      shotgun: "icon_shotgun",
      grenade: "icon_grenade",
      fire_punch: "icon_firepunch",
      teleport: "icon_teleport",
    };

    MVP_WEAPON_IDS.forEach((weaponId, i) => {
      const def = WEAPON_DEFINITIONS[weaponId];
      const x = startX + i * (btnSize + gap) + btnSize / 2;
      const y = height - 28;

      const container = this.add.container(x, y);

      const bg = this.add
        .rectangle(0, 0, btnSize, btnSize, 0x222222, 0.9)
        .setStrokeStyle(1, 0x555555)
        .setInteractive({ useHandCursor: true });

      const iconKey = WEAPON_ICON_MAP[weaponId];
      const hasIcon = iconKey && this.textures.exists(iconKey);

      const children: Phaser.GameObjects.GameObject[] = [bg];

      if (hasIcon) {
        const icon = this.add.image(0, 0, iconKey).setDisplaySize(32, 32);
        children.push(icon);
      } else {
        const label = this.add
          .text(0, 0, def.name.slice(0, 3).toUpperCase(), {
            fontSize: "9px",
            fontFamily: "monospace",
            color: "#ffffff",
          })
          .setOrigin(0.5);
        children.push(label);
      }

      container.add(children);
      container.setDepth(20);

      bg.on("pointerdown", () => {
        const gameScene = this.scene.get("GameScene") as GameScene;
        gameScene.selectWeapon(weaponId);
      });
      bg.on("pointerover", () => bg.setFillStyle(0x444444));
      bg.on("pointerout", () => bg.setFillStyle(0x222222));

      this.weaponButtons.push(container);
    });
  }

  private updatePlayerPanels(state: GameState): void {
    // Clear old panels
    this.playerPanels.forEach((p) => p.destroy());
    this.playerPanels = [];

    const { width, height } = this.cameras.main;

    // Team health bars centered at bottom, above weapon bar
    const barWidth = 120;
    const barHeight = 12;
    const gap = 8;
    const panelCount = state.players.length;
    const totalWidth = panelCount * (barWidth + gap) - gap;
    const startX = width / 2 - totalWidth / 2;
    const panelY = height - 62; // above weapon bar

    state.players.forEach((player, idx) => {
      const x = startX + idx * (barWidth + gap);
      const container = this.add.container(x, panelY);

      // Team name
      const name = this.add
        .text(barWidth / 2, -4, player.displayName.slice(0, 12), {
          fontSize: "9px",
          fontFamily: "monospace",
          color: "#ffffff",
          stroke: "#000000",
          strokeThickness: 2,
        })
        .setOrigin(0.5, 1);

      // HP bar background
      const hpBg = this.add
        .rectangle(0, 0, barWidth, barHeight, 0x111111, 0.8)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0x444444);

      // HP bar fill
      let totalHp = 0;
      let maxHp = 0;
      player.worms.forEach((w) => {
        totalHp += w.health;
        maxHp += 100;
      });
      const pct = maxHp > 0 ? totalHp / maxHp : 0;
      const teamColor = this.getTeamHex(player.teamColor);

      const hpFill = this.add
        .rectangle(1, 1, (barWidth - 2) * pct, barHeight - 2, teamColor)
        .setOrigin(0, 0);

      // HP text on bar
      const hpLabel = this.add
        .text(barWidth / 2, barHeight / 2, `${totalHp}`, {
          fontSize: "8px",
          fontFamily: "monospace",
          color: "#ffffff",
          stroke: "#000000",
          strokeThickness: 1,
        })
        .setOrigin(0.5, 0.5);

      container.add([hpBg, hpFill, name, hpLabel]);
      container.setDepth(20);
      this.playerPanels.push(container);
    });
  }

  private getTeamHex(color: string): number {
    switch (color) {
      case "red":
        return 0xef4444;
      case "blue":
        return 0x3b82f6;
      case "green":
        return 0x22c55e;
      case "yellow":
        return 0xeab308;
      default:
        return 0xffffff;
    }
  }
}
