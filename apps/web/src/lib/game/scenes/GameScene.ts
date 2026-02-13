import * as Phaser from "phaser";
import PartySocket from "partysocket";
import { TERRAIN_WIDTH, TERRAIN_HEIGHT, MVP_WEAPON_IDS } from "@worms/shared";
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

  // Aiming & firing
  private currentAimAngle: number = 0;
  private currentPower: number = 0;
  private selectedWeapon: WeaponId = "bazooka";
  private isAiming: boolean = false;

  // Spacebar power charging
  private isCharging: boolean = false;
  private chargeStartTime: number = 0;
  private readonly CHARGE_DURATION_MS: number = 2000;

  // Movement tracking
  private isMovingLeft: boolean = false;
  private isMovingRight: boolean = false;

  // Input
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  // Projectile animation
  private projectileGraphic: Phaser.GameObjects.Arc | null = null;

  constructor() {
    super({ key: "GameScene" });
  }

  // ─── Preload Sprites ────────────────────────────────────

  preload(): void {
    // Worm spritesheets — 60px wide vertical strips, 60x60 frames
    const wormSprites: Record<string, { file: string; frames: number }> = {
      worm_walk: { file: "wwalk.png", frames: 15 },
      worm_jump: { file: "wjump.png", frames: 10 },
      worm_backflip: { file: "wbackflp.png", frames: 22 },
      worm_fall: { file: "wfall.png", frames: 2 },
      worm_die: { file: "wdie.png", frames: 60 },
      worm_breath: { file: "wbrth1.png", frames: 20 },
      worm_blink: { file: "wblink1.png", frames: 6 },
      worm_fly: { file: "wfly1.png", frames: 32 },
      worm_baz: { file: "wbaz.png", frames: 32 },
      worm_bazd: { file: "wbazd.png", frames: 32 },
      worm_bazu: { file: "wbazu.png", frames: 32 },
      worm_throw: { file: "wthrow.png", frames: 32 },
      worm_throwd: { file: "wthrowd.png", frames: 32 },
      worm_throwu: { file: "wthrowu.png", frames: 32 },
      worm_shotf: { file: "wshotf.png", frames: 32 },
      worm_shotfd: { file: "wshotfd.png", frames: 32 },
      worm_shotfu: { file: "wshotfu.png", frames: 32 },
      worm_falldn: { file: "wfalldn.png", frames: 2 },
    };

    for (const [key, info] of Object.entries(wormSprites)) {
      this.load.spritesheet(key, `/sprites/worms/${info.file}`, {
        frameWidth: 60,
        frameHeight: 60,
      });
    }

    // Effects
    this.load.spritesheet("fx_explode_large", "/sprites/effects/circl100.png", {
      frameWidth: 200,
      frameHeight: 200,
    });
    this.load.spritesheet("fx_explode_small", "/sprites/effects/circle50.png", {
      frameWidth: 100,
      frameHeight: 100,
    });
    this.load.spritesheet("fx_smoke", "/sprites/effects/smklt50.png", {
      frameWidth: 60,
      frameHeight: 60,
    });

    // Projectiles
    this.load.spritesheet("proj_grenade", "/sprites/weapons/grenade.png", {
      frameWidth: 60,
      frameHeight: 60,
    });

    // Graves
    this.load.spritesheet("grave", "/sprites/misc/grave1.png", {
      frameWidth: 60,
      frameHeight: 60,
    });

    // Crosshairs
    this.load.spritesheet("crosshair_red", "/sprites/misc/crshairr.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
    this.load.spritesheet("crosshair_blue", "/sprites/misc/crshairb.png", {
      frameWidth: 60,
      frameHeight: 60,
    });

    // Weapon icons (single 32x32 images)
    this.load.image("icon_bazooka", "/sprites/icons/bazooka.1.png");
    this.load.image("icon_shotgun", "/sprites/icons/shotgun.1.png");
    this.load.image("icon_grenade", "/sprites/icons/grenade.1.png");
    this.load.image("icon_firepunch", "/sprites/icons/firepnch.1.png");
    this.load.image("icon_teleport", "/sprites/icons/teleport.1.png");
  }

  // ─── Create ─────────────────────────────────────────────

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
      // Send INIT_GAME if we have the payload
      const initPayloadRaw = sessionStorage.getItem("gameInitPayload");
      if (initPayloadRaw) {
        try {
          const payload = JSON.parse(initPayloadRaw);
          this.sendMessage({ type: "INIT_GAME", payload });
        } catch {
          // ignore
        }
        sessionStorage.removeItem("gameInitPayload");
      }
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

  // ─── Input Setup ────────────────────────────────────────

  private setupInput(): void {
    // Mouse move for aiming
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.isMyTurn) return;
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

    // Spacebar: hold to charge power, release to fire
    this.input.keyboard!.on("keydown-SPACE", () => {
      if (!this.isMyTurn || !this.isAiming || this.isCharging) return;
      this.isCharging = true;
      this.chargeStartTime = Date.now();
      this.currentPower = 0;
      this.events.emit("charge_start");
      this.events.emit("power_update", 0);
    });

    this.input.keyboard!.on("keyup-SPACE", () => {
      if (!this.isCharging) return;
      this.isCharging = false;
      const elapsed = Date.now() - this.chargeStartTime;
      this.currentPower = Math.min(1, elapsed / this.CHARGE_DURATION_MS);
      this.fire();
    });

    // Enter: forward jump
    this.input.keyboard!.on("keydown-ENTER", () => {
      if (!this.isMyTurn) return;
      this.sendMessage({ type: "JUMP", kind: "forward" });
    });

    // Backspace: backflip
    this.input.keyboard!.on("keydown-BACKSPACE", () => {
      if (!this.isMyTurn) return;
      this.sendMessage({ type: "JUMP", kind: "backflip" });
    });

    // Tab: skip turn
    this.input.keyboard!.on("keydown-TAB", (event: KeyboardEvent) => {
      event.preventDefault();
      if (!this.isMyTurn) return;
      this.sendMessage({ type: "SKIP_TURN" });
    });

    // Number keys 1-5: select weapon
    for (let i = 0; i < MVP_WEAPON_IDS.length; i++) {
      this.input.keyboard!.on(`keydown-${i + 1}`, () => {
        if (!this.isMyTurn) return;
        this.selectWeapon(MVP_WEAPON_IDS[i]);
      });
    }
  }

  // ─── Update Loop ────────────────────────────────────────

  update(): void {
    if (!this.gameState) return;

    // Movement — edge-triggered MOVE_START / MOVE_STOP
    if (this.isMyTurn) {
      const leftDown = this.cursors.left.isDown;
      const rightDown = this.cursors.right.isDown;

      if (leftDown && !this.isMovingLeft) {
        this.isMovingLeft = true;
        this.isMovingRight = false;
        this.sendMessage({ type: "MOVE_START", direction: "left" });
      } else if (rightDown && !this.isMovingRight) {
        this.isMovingRight = true;
        this.isMovingLeft = false;
        this.sendMessage({ type: "MOVE_START", direction: "right" });
      } else if (
        !leftDown &&
        !rightDown &&
        (this.isMovingLeft || this.isMovingRight)
      ) {
        this.isMovingLeft = false;
        this.isMovingRight = false;
        this.sendMessage({ type: "MOVE_STOP" });
      }

      // Update power bar while charging
      if (this.isCharging) {
        const elapsed = Date.now() - this.chargeStartTime;
        this.currentPower = Math.min(1, elapsed / this.CHARGE_DURATION_MS);
        this.events.emit("power_update", this.currentPower);
        const activeWorm = this.getActiveWorm();
        activeWorm?.showAimLine(this.currentAimAngle, this.currentPower);
      }
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
      case "WORM_PHYSICS_UPDATE":
        this.onWormPhysicsUpdate(msg);
        break;
      case "WORM_LANDED":
        this.onWormLanded(msg);
        break;
      case "WORM_FELL_IN_WATER":
        this.onWormFellInWater(msg);
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
        this.isAiming = false;
        this.isCharging = false;
        this.getActiveWorm()?.hideAimLine();
        break;
      case "TURN_END":
        this.isMyTurn = false;
        this.isAiming = false;
        this.isCharging = false;
        this.isMovingLeft = false;
        this.isMovingRight = false;
        break;
      case "GAME_OVER":
        this.events.emit("game_over", msg);
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

    if (!this.terrainRenderer) {
      this.terrainRenderer = new TerrainRenderer(this, state.terrain);
    }

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

    const activeWorm = this.wormEntities.get(state.activeWormId);
    if (activeWorm) {
      this.cameras.main.centerOn(activeWorm.x, activeWorm.y);
    }

    this.scene.get("HUDScene").events.emit("state_sync", state);
    this.isMyTurn = state.activePlayerId === this.playerId;
  }

  private onTurnStart(msg: {
    activePlayerId: string;
    activeWormId: string;
    wind: number;
    turnTime: number;
  }): void {
    this.wormEntities.forEach((entity) => entity.setActive(false));

    const wormEntity = this.wormEntities.get(msg.activeWormId);
    if (wormEntity) {
      wormEntity.setActive(true);
      this.cameras.main.pan(wormEntity.x, wormEntity.y, 500, "Power2");
    }

    this.isMyTurn = msg.activePlayerId === this.playerId;
    this.isAiming = this.isMyTurn; // Aiming starts immediately on your turn
    this.isCharging = false;
    this.currentPower = 0;
    this.selectedWeapon = "bazooka";
    this.isMovingLeft = false;
    this.isMovingRight = false;

    if (this.gameState) {
      this.gameState.activePlayerId = msg.activePlayerId;
      this.gameState.activeWormId = msg.activeWormId;
      this.gameState.wind = msg.wind;
      this.gameState.turnTimeRemaining = msg.turnTime;
    }

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
    const entity = this.wormEntities.get(msg.wormId);
    if (entity) {
      entity.updateState({ vx: msg.vx, vy: msg.vy });
    }
  }

  private onWormPhysicsUpdate(msg: {
    updates: Array<{
      wormId: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      facing: "left" | "right";
    }>;
  }): void {
    for (const update of msg.updates) {
      const entity = this.wormEntities.get(update.wormId);
      if (entity) {
        entity.updateState({
          x: update.x,
          y: update.y,
          vx: update.vx,
          vy: update.vy,
          facing: update.facing,
        });
      }
    }
  }

  private onWormLanded(msg: {
    wormId: string;
    x: number;
    y: number;
    fallDamage: number;
    newHealth: number;
  }): void {
    const entity = this.wormEntities.get(msg.wormId);
    if (entity) {
      entity.updateState({
        x: msg.x,
        y: msg.y,
        vx: 0,
        vy: 0,
        health: msg.newHealth,
      });
      if (msg.fallDamage > 0) {
        entity.flashDamage(msg.fallDamage);
      }
      if (msg.newHealth <= 0) {
        entity.updateState({ isAlive: false });
      }
    }
  }

  private onWormFellInWater(msg: { wormId: string }): void {
    const entity = this.wormEntities.get(msg.wormId);
    if (entity) {
      entity.updateState({ isAlive: false });
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
    if (msg.trajectory.length > 0) {
      this.animateProjectile(msg.trajectory, () => {
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
    for (const exp of msg.explosions) {
      createExplosion(this, exp.x, exp.y, exp.radius);
    }

    for (const td of msg.terrainDestruction) {
      this.terrainRenderer?.eraseCircle(td.x, td.y, td.radius);
    }

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

    // If more shots remain, allow aiming again
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

    this.projectileGraphic = this.add.circle(
      trajectory[0].x,
      trajectory[0].y,
      4,
      0xff6600,
    );
    this.projectileGraphic.setDepth(6);

    let index = 0;
    const startTime = this.time.now;

    this.cameras.main.stopFollow();

    const updateEvent = this.time.addEvent({
      delay: 16,
      loop: true,
      callback: () => {
        const elapsed = this.time.now - startTime;

        while (
          index < trajectory.length - 1 &&
          elapsed > trajectory[index + 1].t - trajectory[0].t
        ) {
          index++;
        }

        if (index >= trajectory.length - 1) {
          const last = trajectory[trajectory.length - 1];
          this.projectileGraphic?.setPosition(last.x, last.y);
          this.projectileGraphic?.destroy();
          this.projectileGraphic = null;
          updateEvent.destroy();
          onComplete();
          return;
        }

        const a = trajectory[index];
        const b = trajectory[index + 1];
        const segDuration = b.t - a.t;
        const segElapsed = elapsed - (a.t - trajectory[0].t);
        const t = segDuration > 0 ? segElapsed / segDuration : 0;

        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;

        this.projectileGraphic?.setPosition(x, y);
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
      // Keep aiming for second shot — server will tell us via shotsRemaining
      this.isAiming = true;
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
    this.currentPower = 0;
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
