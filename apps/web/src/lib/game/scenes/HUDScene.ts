import * as Phaser from "phaser";
import type { GameState, WeaponId } from "@worms/shared";
import { WEAPON_DEFINITIONS, MVP_WEAPON_IDS } from "@worms/shared";
import { GameScene } from "./GameScene";

export class HUDScene extends Phaser.Scene {
  private timerText!: Phaser.GameObjects.Text;
  private weaponButtons: Phaser.GameObjects.Container[] = [];
  private playerPanels: Phaser.GameObjects.Container[] = [];
  // Tracked references for animated health drain
  private hpFills: Phaser.GameObjects.Rectangle[] = [];
  private hpMaxWidths: number[] = [];
  private hpCurrentTotals: number[] = [];
  private hpMaxTotals: number[] = [];
  private playerId: string = "";
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timeRemaining: number = 45;

  // Grenade fuse timer display
  private fuseText: Phaser.GameObjects.Text | null = null;

  // Turn announcement banner
  private turnBanner: Phaser.GameObjects.Container | null = null;
  private turnBannerTween: Phaser.Tweens.Tween | null = null;
  private cachedGameState: GameState | null = null;

  // Wind display (Worms 2 style bar)
  private windContainer!: Phaser.GameObjects.Container;
  private windBarFill!: Phaser.GameObjects.Rectangle;
  private windArrows: Phaser.GameObjects.Image[] = [];
  private windLabel!: Phaser.GameObjects.Text;
  private readonly WIND_BAR_WIDTH = 120;
  private readonly WIND_BAR_HEIGHT = 8;

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
    gameScene.events.on("grenade_fuse", this.onGrenadeFuse, this);

    // Listen for network events forwarded by GameScene
    this.events.on("state_sync", this.onStateSync, this);
    this.events.on("animate_damage", this.onAnimateDamage, this);
    this.events.on("turn_start", this.onTurnStart, this);
    this.events.on("timer_sync", this.onTimerSync, this);
    this.events.on("game_over", this.onGameOver, this);
    this.events.on("chat", this.onChat, this);

    // Dismiss turn banner on any key press
    this.input.keyboard!.on("keydown", () => {
      this.dismissTurnBanner();
    });

    // Handle window resize — reposition all HUD elements
    this.scale.on("resize", (gameSize: Phaser.Structs.Size) => {
      this.cameras.main.setSize(gameSize.width, gameSize.height);
      this.repositionHUD();
    });
  }

  // ─── Wind Display ──────────────────────────────────────

  private createWindDisplay(): void {
    const { width, height } = this.cameras.main;
    const barW = this.WIND_BAR_WIDTH;
    const barH = this.WIND_BAR_HEIGHT;
    // Position: bottom-right, bar centered on this anchor
    const cx = width - 20 - barW / 2;
    const cy = height - 16;
    this.windContainer = this.add.container(cx, cy);
    this.windContainer.setDepth(20);

    // Bar background (dark)
    const barBg = this.add
      .rectangle(0, 0, barW, barH, 0x111111, 0.9)
      .setStrokeStyle(1, 0x444444);
    this.windContainer.add(barBg);

    // Center divider line
    const divider = this.add.rectangle(0, 0, 2, barH + 2, 0xffffff, 0.8);
    this.windContainer.add(divider);

    // Fill bar (starts at 0 width, will be resized in updateWind)
    this.windBarFill = this.add.rectangle(0, 0, 0, barH - 2, 0x44aaff);
    this.windContainer.add(this.windBarFill);

    // "WIND" label above
    this.windLabel = this.add
      .text(0, -(barH / 2 + 2), "WIND", {
        fontSize: "7px",
        fontFamily: "monospace",
        color: "#aaaaaa",
        stroke: "#000000",
        strokeThickness: 1,
      })
      .setOrigin(0.5, 1);
    this.windContainer.add(this.windLabel);
  }

  private updateWind(wind: number): void {
    // Clear old arrows
    for (const arrow of this.windArrows) arrow.destroy();
    this.windArrows = [];

    const barW = this.WIND_BAR_WIDTH;
    const barH = this.WIND_BAR_HEIGHT;
    const halfBar = barW / 2;
    const absWind = Math.abs(wind);
    const maxWind = 100;
    const pct = Math.min(1, absWind / maxWind);

    // Fill bar: extends from center toward the wind direction
    const fillWidth = pct * (halfBar - 1);

    // Color: green (low) → yellow (medium) → red (high)
    let fillColor: number;
    if (pct < 0.33) fillColor = 0x44cc44;
    else if (pct < 0.66) fillColor = 0xcccc44;
    else fillColor = 0xcc4444;

    this.windBarFill.setFillStyle(fillColor);
    this.windBarFill.setSize(fillWidth, barH - 2);

    if (wind > 0) {
      // Fill extends right from center
      this.windBarFill.setOrigin(0, 0.5);
      this.windBarFill.setPosition(1, 0);
    } else if (wind < 0) {
      // Fill extends left from center
      this.windBarFill.setOrigin(1, 0.5);
      this.windBarFill.setPosition(-1, 0);
    } else {
      this.windBarFill.setSize(0, 0);
    }

    // Place small arrow indicators alongside the bar
    if (absWind >= 3) {
      const arrowCount = Math.min(6, Math.max(1, Math.ceil(absWind / 16)));
      const textureKey = wind > 0 ? "wind_right" : "wind_left";
      const hasTexture = this.textures.exists(textureKey);

      if (hasTexture) {
        const arrowW = 14;

        for (let i = 0; i < arrowCount; i++) {
          // Right wind: arrows go right of bar; Left wind: arrows go left of bar
          const x =
            wind > 0
              ? halfBar + 4 + i * arrowW + arrowW / 2
              : -(halfBar + 4 + i * arrowW + arrowW / 2);
          const arrow = this.add.image(x, 0, textureKey);
          arrow.setDisplaySize(12, barH);
          arrow.setOrigin(0.5, 0.5);
          arrow.setTint(fillColor);
          this.windContainer.add(arrow);
          this.windArrows.push(arrow);
        }
      }
    }
  }

  // ─── Resize Repositioning ──────────────────────────────

  private repositionHUD(): void {
    const { width, height } = this.cameras.main;

    // Timer (bottom-left)
    this.timerText.setPosition(20, height - 20);

    // Turn text (top-left) — no change needed, stays at (16, 16)

    // Wind display (bottom-right)
    const barW = this.WIND_BAR_WIDTH;
    this.windContainer.setPosition(width - 20 - barW / 2, height - 16);

    // Weapon bar (bottom center)
    const btnSize = 48;
    const gap = 6;
    const totalWeaponWidth = this.weaponButtons.length * (btnSize + gap) - gap;
    const weaponStartX = width / 2 - totalWeaponWidth / 2;
    this.weaponButtons.forEach((btn, i) => {
      btn.setPosition(
        weaponStartX + i * (btnSize + gap) + btnSize / 2,
        height - 28,
      );
    });

    // Player panels — reposition if they exist
    if (this.cachedGameState) {
      this.updatePlayerPanels(this.cachedGameState);
    }

    // Fuse timer (top center)
    if (this.fuseText) {
      this.fuseText.setPosition(width / 2, 30);
    }

    // Turn banner (top center)
    if (this.turnBanner) {
      this.turnBanner.setX(width / 2);
    }
  }

  // ─── Event Handlers ────────────────────────────────────

  private onStateSync(state: GameState): void {
    this.cachedGameState = state;
    this.timeRemaining = state.turnTimeRemaining;
    this.timerText.setText(String(this.timeRemaining));
    this.updateWind(state.wind);
    this.updatePlayerPanels(state);

    // Show turn banner on initial sync
    const wormInfo = this.findWormInfo(state, state.activeWormId);
    if (wormInfo) this.showTurnBanner(wormInfo.name, wormInfo.teamColor);
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

    // Show turn banner with active worm name
    if (this.cachedGameState) {
      this.cachedGameState.activeWormId = msg.activeWormId;
      this.cachedGameState.activePlayerId = msg.activePlayerId;
    }
    const wormInfo = this.cachedGameState
      ? this.findWormInfo(this.cachedGameState, msg.activeWormId)
      : null;
    if (wormInfo) this.showTurnBanner(wormInfo.name, wormInfo.teamColor);

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

  private onWeaponSelected(weaponId: WeaponId): void {
    if (weaponId === "grenade") {
      this.showFuseTimer(3);
    } else {
      this.hideFuseTimer();
    }
  }

  private onGrenadeFuse(seconds: number): void {
    this.showFuseTimer(seconds);
  }

  private showFuseTimer(seconds: number): void {
    const { width } = this.cameras.main;
    if (!this.fuseText) {
      this.fuseText = this.add.text(width / 2, 30, "", {
        fontSize: "12px",
        fontFamily: "monospace",
        color: "#ffcc00",
        stroke: "#000000",
        strokeThickness: 2,
      });
      this.fuseText.setOrigin(0.5);
      this.fuseText.setDepth(100);
    }
    this.fuseText.setText(`Fuse: ${seconds}s`);
    this.fuseText.setVisible(true);
  }

  private hideFuseTimer(): void {
    if (this.fuseText) {
      this.fuseText.setVisible(false);
    }
  }

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

  // ─── Turn Banner ─────────────────────────────────────────

  private showTurnBanner(wormName: string, teamColor: string): void {
    this.dismissTurnBanner(true);

    const { width } = this.cameras.main;
    const text = `C'est au tour de ${wormName}`;

    const colorHexMap: Record<string, string> = {
      red: "#ef4444",
      blue: "#3b82f6",
      green: "#22c55e",
      yellow: "#eab308",
    };
    const textColor = colorHexMap[teamColor] ?? "#ffffff";

    const bannerText = this.add.text(0, 0, text, {
      fontSize: "18px",
      fontFamily: "monospace",
      color: textColor,
    });
    bannerText.setOrigin(0.5, 0.5);

    const pad = 12;
    const radius = 6;
    const bw = bannerText.width + pad * 2;
    const bh = bannerText.height + pad * 2;

    const bg = this.add.graphics();
    bg.fillStyle(0x000000, 0.4);
    bg.fillRoundedRect(-bw / 2, -bh / 2, bw, bh, radius);
    bg.lineStyle(1, 0xffffff, 0.1);
    bg.strokeRoundedRect(-bw / 2, -bh / 2, bw, bh, radius);

    this.turnBanner = this.add.container(width / 2, -40);
    this.turnBanner.add([bg, bannerText]);
    this.turnBanner.setDepth(30);

    // Slide in from top
    this.turnBannerTween = this.tweens.add({
      targets: this.turnBanner,
      y: 40,
      duration: 400,
      ease: "Back.easeOut",
    });
  }

  private dismissTurnBanner(immediate?: boolean): void {
    if (!this.turnBanner) return;
    if (this.turnBannerTween) {
      this.turnBannerTween.stop();
      this.turnBannerTween = null;
    }
    const banner = this.turnBanner;
    this.turnBanner = null;
    if (immediate) {
      banner.destroy();
      return;
    }
    // Slide out upward
    this.tweens.add({
      targets: banner,
      y: -60,
      duration: 300,
      ease: "Back.easeIn",
      onComplete: () => banner.destroy(),
    });
  }

  // ─── UI Drawing ─────────────────────────────────────────

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
    this.hpFills = [];
    this.hpMaxWidths = [];
    this.hpCurrentTotals = [];
    this.hpMaxTotals = [];

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
      const fillWidth = (barWidth - 2) * pct;

      const hpFill = this.add
        .rectangle(1, 1, fillWidth, barHeight - 2, teamColor)
        .setOrigin(0, 0);

      container.add([hpBg, hpFill, name]);
      container.setDepth(20);
      this.playerPanels.push(container);

      // Track references for animated drain
      this.hpFills.push(hpFill);
      this.hpMaxWidths.push(barWidth - 2);
      this.hpCurrentTotals.push(totalHp);
      this.hpMaxTotals.push(maxHp);
    });
  }

  /** Animate health bars draining to new values (Worms 2 style) */
  private onAnimateDamage(state: GameState): void {
    this.cachedGameState = state;
    const duration = 800;

    state.players.forEach((player, idx) => {
      if (idx >= this.hpFills.length) return;

      let newTotalHp = 0;
      player.worms.forEach((w) => {
        newTotalHp += w.health;
      });

      const oldTotal = this.hpCurrentTotals[idx];
      const maxHp = this.hpMaxTotals[idx];
      const maxW = this.hpMaxWidths[idx];
      const fill = this.hpFills[idx];

      if (newTotalHp === oldTotal) return;

      // Tween bar width
      const newWidth = maxHp > 0 ? maxW * (newTotalHp / maxHp) : 0;
      this.tweens.add({
        targets: fill,
        displayWidth: newWidth,
        duration,
        ease: "Linear",
      });

      this.hpCurrentTotals[idx] = newTotalHp;
    });
  }

  private findWormInfo(
    state: GameState,
    wormId: string,
  ): { name: string; teamColor: string } | null {
    for (const player of state.players) {
      for (const worm of player.worms) {
        if (worm.id === wormId)
          return { name: worm.name, teamColor: player.teamColor };
      }
    }
    return null;
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
