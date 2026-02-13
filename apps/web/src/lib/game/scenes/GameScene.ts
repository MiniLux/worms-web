import * as Phaser from "phaser";
import PartySocket from "partysocket";
import {
  TERRAIN_WIDTH,
  TERRAIN_HEIGHT,
  WORM_WIDTH,
  WORM_HEIGHT,
} from "@worms/shared";
import type {
  GameState,
  GameClientMessage,
  GameServerMessage,
  TrajectoryPoint,
  WeaponId,
} from "@worms/shared";
import { TerrainRenderer } from "../terrain/TerrainRenderer";
import { WormEntity } from "../entities/WormEntity";
import { createExplosion } from "../effects/ExplosionEffect";

export class GameScene extends Phaser.Scene {
  private socket: PartySocket | null = null;
  private terrainRenderer: TerrainRenderer | null = null;
  private wormEntities: Map<string, WormEntity> = new Map();
  private gameState: GameState | null = null;
  private playerId: string = "";
  private isMyTurn: boolean = false;
  private currentAimAngle: number = 0;
  private currentPower: number = 0.5;
  private selectedWeapon: WeaponId = "bazooka";
  private isAiming: boolean = false;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private projectileGraphic: Phaser.GameObjects.Arc | null = null;
  private trajectoryTween: Phaser.Tweens.Tween | null = null;

  constructor() {
    super({ key: "GameScene" });
  }

  create(): void {
    const gameId = this.registry.get("gameId") as string;
    this.playerId = this.registry.get("playerId") as string;
    const partyHost = this.registry.get("partyHost") as string;

    // Camera setup
    this.cameras.main.setBounds(
      -100,
      -100,
      TERRAIN_WIDTH + 200,
      TERRAIN_HEIGHT + 200,
    );
    this.cameras.main.setZoom(1);

    // Input
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.setupInput();

    // Connect to game server
    this.socket = new PartySocket({
      host: partyHost,
      room: gameId,
      party: "game",
    });

    this.socket.addEventListener("open", () => {
      // Send INIT_GAME if we have the payload (first client to connect initializes the game)
      const initPayloadRaw = sessionStorage.getItem("gameInitPayload");
      if (initPayloadRaw) {
        try {
          const payload = JSON.parse(initPayloadRaw);
          this.sendMessage({ type: "INIT_GAME", payload });
        } catch {
          // ignore parse errors
        }
        sessionStorage.removeItem("gameInitPayload");
      }

      // Then join the game
      this.sendMessage({ type: "JOIN_GAME", playerId: this.playerId });
    });

    this.socket.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as GameServerMessage;
      this.handleServerMessage(msg);
    });

    this.socket.addEventListener("close", () => {
      this.events.emit("disconnected");
    });

    // Launch HUD scene in parallel
    this.scene.launch("HUDScene");
  }

  private setupInput(): void {
    // Mouse move for aiming
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.isMyTurn || !this.isAiming) return;
      const activeWorm = this.getActiveWorm();
      if (!activeWorm) return;

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.currentAimAngle = Math.atan2(
        worldPoint.y - activeWorm.y,
        worldPoint.x - activeWorm.x,
      );
      activeWorm.showAimLine(this.currentAimAngle, this.currentPower);
      this.events.emit("aim_update", this.currentAimAngle);
    });

    // Scroll for power
    this.input.on(
      "wheel",
      (_p: unknown, _go: unknown, _dx: number, dy: number) => {
        if (!this.isMyTurn || !this.isAiming) return;
        this.currentPower = Phaser.Math.Clamp(
          this.currentPower - dy * 0.001,
          0.05,
          1,
        );
        this.events.emit("power_update", this.currentPower);
        const activeWorm = this.getActiveWorm();
        activeWorm?.showAimLine(this.currentAimAngle, this.currentPower);
      },
    );

    // Click to fire
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!this.isMyTurn || !this.isAiming || !pointer.leftButtonDown()) return;
      this.fire();
    });
  }

  update(): void {
    if (!this.isMyTurn || !this.gameState) return;

    // Keyboard movement
    if (this.cursors.left.isDown) {
      this.sendMessage({ type: "MOVE", direction: "left" });
    } else if (this.cursors.right.isDown) {
      this.sendMessage({ type: "MOVE", direction: "right" });
    }

    // Update worm lerping
    this.wormEntities.forEach((entity) => entity.update());
  }

  // ─── Network ────────────────────────────────────────────

  private sendMessage(msg: GameClientMessage): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private handleServerMessage(msg: GameServerMessage): void {
    switch (msg.type) {
      case "GAME_STATE_SYNC":
        this.onGameStateSync(msg.state);
        break;
      case "TURN_START":
        this.onTurnStart(msg);
        break;
      case "WORM_MOVED":
        this.onWormMoved(msg);
        break;
      case "WORM_JUMPED":
        this.onWormJumped(msg);
        break;
      case "FIRE_RESULT":
        this.onFireResult(msg);
        break;
      case "HITSCAN_RESULT":
        this.onHitscanResult(msg);
        break;
      case "MELEE_RESULT":
        this.onMeleeResult(msg);
        break;
      case "TELEPORT_RESULT":
        this.onTeleportResult(msg);
        break;
      case "RETREAT_START":
        this.isMyTurn = false;
        this.isAiming = false;
        this.getActiveWorm()?.hideAimLine();
        break;
      case "TURN_END":
        this.isMyTurn = false;
        this.isAiming = false;
        break;
      case "GAME_OVER":
        this.events.emit("game_over", msg);
        // Forward to HUD
        this.scene.get("HUDScene").events.emit("game_over", msg);
        break;
      case "TIMER_SYNC":
        this.scene.get("HUDScene").events.emit("timer_sync", msg.remaining);
        break;
      case "CHAT":
        this.scene.get("HUDScene").events.emit("chat", msg);
        break;
      case "ERROR":
        console.error("Game error:", msg.message);
        break;
    }
  }

  // ─── State Sync ─────────────────────────────────────────

  private onGameStateSync(state: GameState): void {
    this.gameState = state;

    // Create terrain
    if (!this.terrainRenderer) {
      this.terrainRenderer = new TerrainRenderer(this, state.terrain);
    }

    // Create worm entities
    for (const player of state.players) {
      for (const worm of player.worms) {
        if (!this.wormEntities.has(worm.id)) {
          const entity = new WormEntity(this, worm, player.teamColor);
          this.wormEntities.set(worm.id, entity);
        } else {
          this.wormEntities.get(worm.id)!.updateState(worm);
        }
        if (worm.isActive) {
          this.wormEntities.get(worm.id)!.setActive(true);
        }
      }
    }

    // Camera to active worm
    const activeWorm = this.wormEntities.get(state.activeWormId);
    if (activeWorm) {
      this.cameras.main.centerOn(activeWorm.x, activeWorm.y);
    }

    // Forward state to HUD
    this.scene.get("HUDScene").events.emit("state_sync", state);

    // Check if it's our turn
    this.isMyTurn = state.activePlayerId === this.playerId;
  }

  private onTurnStart(msg: {
    activePlayerId: string;
    activeWormId: string;
    wind: number;
    turnTime: number;
  }): void {
    // Deactivate all worms
    this.wormEntities.forEach((entity) => entity.setActive(false));

    // Activate the new worm
    const wormEntity = this.wormEntities.get(msg.activeWormId);
    if (wormEntity) {
      wormEntity.setActive(true);
      this.cameras.main.pan(wormEntity.x, wormEntity.y, 500, "Power2");
    }

    this.isMyTurn = msg.activePlayerId === this.playerId;
    this.isAiming = false;
    this.currentPower = 0.5;
    this.selectedWeapon = "bazooka";

    if (this.gameState) {
      this.gameState.activePlayerId = msg.activePlayerId;
      this.gameState.activeWormId = msg.activeWormId;
      this.gameState.wind = msg.wind;
      this.gameState.turnTimeRemaining = msg.turnTime;
    }

    // Forward to HUD
    this.scene.get("HUDScene").events.emit("turn_start", msg);
  }

  private onWormMoved(msg: {
    wormId: string;
    x: number;
    y: number;
    facing: "left" | "right";
  }): void {
    const entity = this.wormEntities.get(msg.wormId);
    entity?.updateState({ x: msg.x, y: msg.y, facing: msg.facing });
  }

  private onWormJumped(msg: { wormId: string; vx: number; vy: number }): void {
    // Visual jump effect - the server will send position updates
    const entity = this.wormEntities.get(msg.wormId);
    if (entity) {
      // Simple visual bounce - actual position comes from server
    }
  }

  private onFireResult(msg: {
    trajectory: TrajectoryPoint[];
    weaponId: WeaponId;
    explosions: Array<{ x: number; y: number; radius: number }>;
    terrainDestruction: Array<{ x: number; y: number; radius: number }>;
    damages: Array<{
      wormId: string;
      damage: number;
      newHealth: number;
      knockbackVx: number;
      knockbackVy: number;
    }>;
    deaths: Array<{ wormId: string; cause: string }>;
  }): void {
    // Animate projectile along trajectory
    if (msg.trajectory.length > 0) {
      this.animateProjectile(msg.trajectory, () => {
        // After projectile arrives, show explosions
        this.applyFireEffects(msg);
      });
    } else {
      this.applyFireEffects(msg);
    }
  }

  private applyFireEffects(msg: {
    explosions: Array<{ x: number; y: number; radius: number }>;
    terrainDestruction: Array<{ x: number; y: number; radius: number }>;
    damages: Array<{
      wormId: string;
      damage: number;
      newHealth: number;
      knockbackVx?: number;
      knockbackVy?: number;
    }>;
    deaths: Array<{ wormId: string; cause: string }>;
  }): void {
    // Explosions
    for (const exp of msg.explosions) {
      createExplosion(this, exp.x, exp.y, exp.radius);
    }

    // Terrain destruction
    for (const td of msg.terrainDestruction) {
      this.terrainRenderer?.eraseCircle(td.x, td.y, td.radius);
    }

    // Damages
    for (const dmg of msg.damages) {
      const entity = this.wormEntities.get(dmg.wormId);
      if (entity) {
        entity.flashDamage(dmg.damage);
        entity.updateState({ health: dmg.newHealth });
      }
    }

    // Deaths
    for (const death of msg.deaths) {
      const entity = this.wormEntities.get(death.wormId);
      entity?.updateState({ isAlive: false });
    }
  }

  private onHitscanResult(msg: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    explosions: Array<{ x: number; y: number; radius: number }>;
    terrainDestruction: Array<{ x: number; y: number; radius: number }>;
    damages: Array<{
      wormId: string;
      damage: number;
      newHealth: number;
    }>;
    deaths: Array<{ wormId: string; cause: string }>;
    shotsRemaining: number;
  }): void {
    // Draw hitscan line
    const line = this.add.graphics();
    line.setDepth(10);
    line.lineStyle(2, 0xffff00, 1);
    line.lineBetween(msg.fromX, msg.fromY, msg.toX, msg.toY);
    this.tweens.add({
      targets: line,
      alpha: 0,
      duration: 300,
      onComplete: () => line.destroy(),
    });

    this.applyFireEffects(msg);

    // If more shots remain, keep aiming
    if (msg.shotsRemaining > 0) {
      this.isAiming = true;
    }
  }

  private onMeleeResult(msg: {
    damages: Array<{
      wormId: string;
      damage: number;
      newHealth: number;
    }>;
    deaths: Array<{ wormId: string; cause: string }>;
  }): void {
    for (const dmg of msg.damages) {
      const entity = this.wormEntities.get(dmg.wormId);
      if (entity) {
        entity.flashDamage(dmg.damage);
        entity.updateState({ health: dmg.newHealth });
      }
    }
    for (const death of msg.deaths) {
      const entity = this.wormEntities.get(death.wormId);
      entity?.updateState({ isAlive: false });
    }
  }

  private onTeleportResult(msg: {
    wormId: string;
    x: number;
    y: number;
  }): void {
    // Teleport flash at old position
    const entity = this.wormEntities.get(msg.wormId);
    if (entity) {
      const oldFlash = this.add.circle(entity.x, entity.y, 15, 0xffffff, 0.8);
      oldFlash.setDepth(10);
      this.tweens.add({
        targets: oldFlash,
        alpha: 0,
        scaleX: 2,
        scaleY: 2,
        duration: 300,
        onComplete: () => oldFlash.destroy(),
      });

      entity.updateState({ x: msg.x, y: msg.y });

      // Flash at new position
      const newFlash = this.add.circle(msg.x, msg.y, 15, 0xffffff, 0.8);
      newFlash.setDepth(10);
      this.tweens.add({
        targets: newFlash,
        alpha: 0,
        scaleX: 2,
        scaleY: 2,
        duration: 300,
        onComplete: () => newFlash.destroy(),
      });

      this.cameras.main.pan(msg.x, msg.y, 300);
    }
  }

  // ─── Projectile Animation ───────────────────────────────

  private animateProjectile(
    trajectory: TrajectoryPoint[],
    onComplete: () => void,
  ): void {
    if (trajectory.length < 2) {
      onComplete();
      return;
    }

    // Create projectile visual
    this.projectileGraphic = this.add.circle(
      trajectory[0].x,
      trajectory[0].y,
      4,
      0xff6600,
    );
    this.projectileGraphic.setDepth(6);

    let index = 0;
    const totalDuration = trajectory[trajectory.length - 1].t - trajectory[0].t;
    const startTime = this.time.now;

    // Follow projectile with camera
    this.cameras.main.stopFollow();

    const updateEvent = this.time.addEvent({
      delay: 16,
      loop: true,
      callback: () => {
        const elapsed = this.time.now - startTime;

        // Find current position in trajectory
        while (
          index < trajectory.length - 1 &&
          elapsed > trajectory[index + 1].t - trajectory[0].t
        ) {
          index++;
        }

        if (index >= trajectory.length - 1) {
          // Arrived
          const last = trajectory[trajectory.length - 1];
          this.projectileGraphic?.setPosition(last.x, last.y);
          this.projectileGraphic?.destroy();
          this.projectileGraphic = null;
          updateEvent.destroy();
          onComplete();
          return;
        }

        // Interpolate between points
        const a = trajectory[index];
        const b = trajectory[index + 1];
        const segDuration = b.t - a.t;
        const segElapsed = elapsed - (a.t - trajectory[0].t);
        const t = segDuration > 0 ? segElapsed / segDuration : 0;

        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;

        this.projectileGraphic?.setPosition(x, y);

        // Camera follows projectile
        this.cameras.main.centerOn(x, y);
      },
    });
  }

  // ─── Fire Weapon ────────────────────────────────────────

  private fire(): void {
    this.isAiming = false;
    this.getActiveWorm()?.hideAimLine();

    if (this.selectedWeapon === "teleport") {
      const pointer = this.input.activePointer;
      const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.sendMessage({ type: "USE_TELEPORT", x: world.x, y: world.y });
    } else if (this.selectedWeapon === "fire_punch") {
      const worm = this.getActiveWorm();
      const direction =
        worm && Math.cos(this.currentAimAngle) >= 0 ? "right" : "left";
      this.sendMessage({
        type: "FIRE_MELEE",
        weaponId: this.selectedWeapon,
        direction: direction as "left" | "right",
      });
    } else if (this.selectedWeapon === "shotgun") {
      this.sendMessage({
        type: "FIRE_HITSCAN",
        weaponId: this.selectedWeapon,
        angle: this.currentAimAngle,
      });
    } else {
      this.sendMessage({
        type: "FIRE",
        weaponId: this.selectedWeapon,
        angle: this.currentAimAngle,
        power: this.currentPower,
      });
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  private getActiveWorm(): WormEntity | undefined {
    if (!this.gameState) return undefined;
    return this.wormEntities.get(this.gameState.activeWormId);
  }

  /** Called from HUD when player selects a weapon */
  selectWeapon(weaponId: WeaponId): void {
    this.selectedWeapon = weaponId;
    this.isAiming = true;
    this.sendMessage({ type: "SELECT_WEAPON", weaponId });
    this.events.emit("weapon_selected", weaponId);
  }

  shutdown(): void {
    this.socket?.close();
    this.terrainRenderer?.destroy();
    this.wormEntities.forEach((w) => w.destroy());
    this.wormEntities.clear();
    this.projectileGraphic?.destroy();
  }
}
