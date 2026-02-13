import * as Phaser from "phaser";
import type { GameState, GameServerMessage, WeaponId } from "@worms/shared";
import { WEAPON_DEFINITIONS, MVP_WEAPON_IDS } from "@worms/shared";
import { GameScene } from "./GameScene";

export class HUDScene extends Phaser.Scene {
  private timerText!: Phaser.GameObjects.Text;
  private windText!: Phaser.GameObjects.Text;
  private turnText!: Phaser.GameObjects.Text;
  private powerBar!: Phaser.GameObjects.Graphics;
  private powerLabel!: Phaser.GameObjects.Text;
  private weaponButtons: Phaser.GameObjects.Container[] = [];
  private weaponPanel: Phaser.GameObjects.Container | null = null;
  private playerPanels: Phaser.GameObjects.Container[] = [];
  private playerId: string = "";
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timeRemaining: number = 45;
  private currentPower: number = 0.5;
  private showingPower: boolean = false;

  constructor() {
    super({ key: "HUDScene" });
  }

  create(): void {
    this.playerId = this.registry.get("playerId") as string;
    const { width, height } = this.cameras.main;

    // Turn timer (top right)
    this.timerText = this.add
      .text(width - 16, 16, "45", {
        fontSize: "22px",
        fontFamily: "monospace",
        color: "#ffcc00",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(1, 0);

    // Wind indicator (top center)
    this.windText = this.add
      .text(width / 2, 16, "Wind: ---", {
        fontSize: "12px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 0);

    // Turn indicator (top left)
    this.turnText = this.add
      .text(16, 16, "", {
        fontSize: "12px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0, 0);

    // Power bar (bottom center, hidden by default)
    this.powerBar = this.add.graphics();
    this.powerBar.setVisible(false);

    this.powerLabel = this.add
      .text(width / 2, height - 75, "POWER", {
        fontSize: "9px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1);
    this.powerLabel.setVisible(false);

    // Weapon bar (bottom)
    this.createWeaponBar();

    // Listen for events from GameScene
    const gameScene = this.scene.get("GameScene");
    gameScene.events.on("aim_update", this.onAimUpdate, this);
    gameScene.events.on("power_update", this.onPowerUpdate, this);
    gameScene.events.on("weapon_selected", this.onWeaponSelected, this);

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

    // Show power bar on my turn
    this.showingPower = false;
    this.powerBar.setVisible(false);
    this.powerLabel.setVisible(false);

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

  private onAimUpdate(_angle: number): void {
    if (!this.showingPower) {
      this.showingPower = true;
      this.powerBar.setVisible(true);
      this.powerLabel.setVisible(true);
    }
    this.drawPowerBar();
  }

  private onPowerUpdate(power: number): void {
    this.currentPower = power;
    this.drawPowerBar();
  }

  private onWeaponSelected(_weaponId: WeaponId): void {
    // Could highlight the selected weapon in the bar
  }

  private onGameOver(msg: { winnerId: string | null; reason: string }): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    const { width, height } = this.cameras.main;

    // Overlay
    this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0.7);

    // Winner text
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

  private updateWind(wind: number): void {
    const absWind = Math.abs(wind);
    const dir = wind > 0 ? ">>>" : "<<<";
    const arrows =
      absWind > 60 ? dir : absWind > 30 ? dir.slice(0, 2) : dir.slice(0, 1);
    const label =
      wind === 0 ? "Wind: calm" : `Wind: ${arrows} ${absWind.toFixed(0)}`;
    this.windText.setText(label);
  }

  private drawPowerBar(): void {
    const { width, height } = this.cameras.main;
    this.powerBar.clear();

    const bw = 200;
    const bh = 14;
    const bx = width / 2 - bw / 2;
    const by = height - 60;

    // Background
    this.powerBar.fillStyle(0x000000, 0.7);
    this.powerBar.fillRect(bx - 2, by - 2, bw + 4, bh + 4);

    // Fill
    const color =
      this.currentPower < 0.4
        ? 0x22cc44
        : this.currentPower < 0.7
          ? 0xffaa00
          : 0xff2222;
    this.powerBar.fillStyle(color, 1);
    this.powerBar.fillRect(bx, by, bw * this.currentPower, bh);
  }

  private createWeaponBar(): void {
    const { width, height } = this.cameras.main;
    const btnSize = 48;
    const gap = 6;
    const totalWidth = MVP_WEAPON_IDS.length * (btnSize + gap) - gap;
    const startX = width / 2 - totalWidth / 2;

    MVP_WEAPON_IDS.forEach((weaponId, i) => {
      const def = WEAPON_DEFINITIONS[weaponId];
      const x = startX + i * (btnSize + gap) + btnSize / 2;
      const y = height - 28;

      const container = this.add.container(x, y);

      const bg = this.add
        .rectangle(0, 0, btnSize, btnSize, 0x222222, 0.9)
        .setStrokeStyle(1, 0x555555)
        .setInteractive({ useHandCursor: true });

      const label = this.add
        .text(0, 0, def.name.slice(0, 3).toUpperCase(), {
          fontSize: "9px",
          fontFamily: "monospace",
          color: "#ffffff",
        })
        .setOrigin(0.5);

      container.add([bg, label]);
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

    const panelX = 16;

    state.players.forEach((player, idx) => {
      const panelY = 50 + idx * 45;
      const container = this.add.container(panelX, panelY);

      const bg = this.add
        .rectangle(60, 0, 130, 36, 0x000000, 0.6)
        .setOrigin(0, 0.5);

      const name = this.add
        .text(8, -10, player.displayName.slice(0, 10), {
          fontSize: "9px",
          fontFamily: "monospace",
          color: "#ffffff",
        })
        .setOrigin(0, 0);

      // Total HP bar
      let totalHp = 0;
      let maxHp = 0;
      player.worms.forEach((w) => {
        totalHp += w.health;
        maxHp += 100;
      });
      const pct = maxHp > 0 ? totalHp / maxHp : 0;

      const hpBg = this.add
        .rectangle(68, 8, 110, 6, 0x333333)
        .setOrigin(0, 0.5);
      const hpFill = this.add
        .rectangle(68, 8, 110 * pct, 6, this.getTeamHex(player.teamColor))
        .setOrigin(0, 0.5);

      const alive = player.worms.filter((w) => w.isAlive).length;
      const aliveText = this.add
        .text(120, -10, `${alive} alive`, {
          fontSize: "8px",
          fontFamily: "monospace",
          color: "#888888",
        })
        .setOrigin(0, 0);

      container.add([bg, name, hpBg, hpFill, aliveText]);
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
