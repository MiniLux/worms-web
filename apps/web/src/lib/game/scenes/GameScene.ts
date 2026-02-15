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
  private aimLocked: boolean = false;

  // Movement tracking
  private isMovingLeft: boolean = false;
  private isMovingRight: boolean = false;

  // Input
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  // Grenade fuse timer (1-3 seconds, default 3)
  private grenadeFuseSeconds: number = 3;

  // Projectile animation
  private projectileSprite: Phaser.GameObjects.Sprite | null = null;
  private projectileFallback: Phaser.GameObjects.Arc | null = null;
  private grenadeCountdownText: Phaser.GameObjects.Text | null = null;

  // Teleport cursor
  private teleportCursor: Phaser.GameObjects.Sprite | null = null;

  // Wind particles
  private windParticles: Phaser.GameObjects.Sprite[] = [];
  private currentWind: number = 0;

  // Edge-scroll camera
  private readonly EDGE_SCROLL_ZONE = 40; // pixels from screen edge
  private readonly EDGE_SCROLL_SPEED = 500; // px/s
  private cameraFollowingWorm: boolean = false;

  constructor() {
    super({ key: "GameScene" });
  }

  // ─── Preload Sprites ────────────────────────────────────

  preload(): void {
    // Worm spritesheets — 60px wide vertical strips, 60x60 frames
    const wormSprites: Record<string, { file: string }> = {
      worm_walk: { file: "wwalk.png" },
      worm_jump: { file: "wjump.png" },
      worm_backflip: { file: "wbackflp.png" },
      worm_fall: { file: "wfall.png" },
      worm_die: { file: "wdie.png" },
      worm_breath: { file: "wbrth1.png" },
      worm_blink: { file: "wblink1.png" },
      worm_fly: { file: "wfly1.png" },
      worm_baz: { file: "wbaz.png" },
      worm_bazd: { file: "wbazd.png" },
      worm_bazu: { file: "wbazu.png" },
      worm_throw: { file: "wthrow.png" },
      worm_throwd: { file: "wthrowd.png" },
      worm_throwu: { file: "wthrowu.png" },
      worm_shotf: { file: "wshotf.png" },
      worm_shotfd: { file: "wshotfd.png" },
      worm_shotfu: { file: "wshotfu.png" },
      worm_shotg: { file: "wshotg.png" },
      worm_bazlnk: { file: "wbazlnk.png" },
      worm_falldn: { file: "wfalldn.png" },
      // Fire punch sprites
      worm_japbak: { file: "wjapbak.png" },
      worm_fist: { file: "wfist.png" },
      worm_firblast: { file: "wfirbl1.png" },
      // Shotgun draw and put-away animations
      worm_shglnk: { file: "wshglnk.png" },
      worm_shgbak: { file: "wshgbak.png" },
      // Grenade throw with visible grenade
      worm_thrgrn: { file: "wthrgrn.png" },
      // Grenade draw (get out) and put-away
      worm_grnlnk: { file: "wgrnlnk.png" },
      worm_grnbak: { file: "wgrnbak.png" },
      // Teleporter sprites
      worm_tellnk: { file: "wtellnk.png" },
      worm_telbak: { file: "wtelbak.png" },
      worm_teltlk: { file: "wteltlk.png" },
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
    // Worms 2-style fire explosion (100x100 frames, 20 frames)
    this.load.spritesheet("fx_exfoom", "/sprites/effects/exfoom.png", {
      frameWidth: 100,
      frameHeight: 100,
    });
    this.load.spritesheet("fx_smoke", "/sprites/effects/smklt50.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
    this.load.spritesheet("fx_feather", "/sprites/effects/feather.png", {
      frameWidth: 60,
      frameHeight: 60,
    });

    // Projectiles
    this.load.spritesheet("proj_missile", "/sprites/weapons/missile.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
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

    // Teleport cursors
    this.load.spritesheet("cursor_red", "/sprites/misc/cursorr.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
    this.load.spritesheet("cursor_blue", "/sprites/misc/cursorb.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
    this.load.spritesheet("cursor_green", "/sprites/misc/cursorg.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
    this.load.spritesheet("cursor_yellow", "/sprites/misc/cursory.png", {
      frameWidth: 60,
      frameHeight: 60,
    });

    // Turn indicator arrows (60x60 frames, 30 frames each)
    this.load.spritesheet("arrowdn_red", "/sprites/misc/arrowdnr.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
    this.load.spritesheet("arrowdn_blue", "/sprites/misc/arrowdnb.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
    this.load.spritesheet("arrowdn_green", "/sprites/misc/arrowdng.png", {
      frameWidth: 60,
      frameHeight: 60,
    });
    this.load.spritesheet("arrowdn_yellow", "/sprites/misc/arrowdny.png", {
      frameWidth: 60,
      frameHeight: 60,
    });

    // Wind arrows
    this.load.image("wind_left", "/sprites/misc/windl.png");
    this.load.image("wind_right", "/sprites/misc/windr.png");

    // Terrain textures (forest theme)
    this.load.image("terrain_soil", "/sprites/terrain/soil.png");
    this.load.image("terrain_grass", "/sprites/terrain/grass.png");
    this.load.image("terrain_gradient", "/sprites/terrain/gradient.png");
    this.load.image("terrain_back", "/sprites/terrain/back.png");
    this.load.spritesheet("terrain_debris", "/sprites/terrain/debris.png", {
      frameWidth: 32,
      frameHeight: 32,
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
    // Ensure the browser cursor stays visible over the game canvas
    this.input.setDefaultCursor("default");

    const gameId = this.registry.get("gameId") as string;
    this.playerId = this.registry.get("playerId") as string;
    const partyHost = this.registry.get("partyHost") as string;

    this.cameras.main.setBounds(
      -100,
      -100,
      TERRAIN_WIDTH + 200,
      TERRAIN_HEIGHT + 200,
    );
    this.cameras.main.setZoom(1);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.setupInput();
    this.createProjectileAnims();
    this.createSmokeAnim();
    this.createWindParticleAnims();

    this.socket = new PartySocket({
      host: partyHost,
      room: gameId,
      party: "game",
    });

    this.socket.addEventListener("open", () => {
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

    this.scene.launch("HUDScene");
  }

  // Smoke trail sprites
  private smokeTrail: Phaser.GameObjects.Sprite[] = [];

  private createProjectileAnims(): void {
    if (
      this.textures.exists("proj_missile") &&
      !this.anims.exists("anim_missile")
    ) {
      this.anims.create({
        key: "anim_missile",
        frames: this.anims.generateFrameNumbers("proj_missile", {
          start: 0,
          end: 31,
        }),
        frameRate: 30,
        repeat: -1,
      });
    }
    if (
      this.textures.exists("proj_grenade") &&
      !this.anims.exists("anim_grenade")
    ) {
      this.anims.create({
        key: "anim_grenade",
        frames: this.anims.generateFrameNumbers("proj_grenade", {
          start: 0,
          end: 31,
        }),
        frameRate: 30,
        repeat: -1,
      });
    }
  }

  private createSmokeAnim(): void {
    if (this.textures.exists("fx_smoke") && !this.anims.exists("anim_smoke")) {
      this.anims.create({
        key: "anim_smoke",
        frames: this.anims.generateFrameNumbers("fx_smoke", {
          start: 0,
          end: 27,
        }),
        frameRate: 30,
        repeat: 0,
      });
    }
  }

  private createWindParticleAnims(): void {
    // Debris sprites (forest theme wind particles: 122 frames of 22x22)
    if (
      this.textures.exists("terrain_debris") &&
      !this.anims.exists("anim_debris")
    ) {
      this.anims.create({
        key: "anim_debris",
        frames: this.anims.generateFrameNumbers("terrain_debris", {
          start: 0,
          end: 121,
        }),
        frameRate: 30,
        repeat: -1,
      });
    }
    // Feather fallback
    if (
      this.textures.exists("fx_feather") &&
      !this.anims.exists("anim_feather")
    ) {
      this.anims.create({
        key: "anim_feather",
        frames: this.anims.generateFrameNumbers("fx_feather", {
          start: 0,
          end: 73,
        }),
        frameRate: 30,
        repeat: -1,
      });
    }
  }

  // ─── Input Setup ────────────────────────────────────────

  private setupInput(): void {
    // Mouse move for aiming
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.isMyTurn) return;

      // Update teleport cursor position
      if (this.selectedWeapon === "teleport" && this.teleportCursor) {
        const worldPoint = this.cameras.main.getWorldPoint(
          pointer.x,
          pointer.y,
        );
        this.teleportCursor.setPosition(worldPoint.x, worldPoint.y);
        return;
      }

      // Skip aim updates for fire punch (direction-only weapon)
      if (this.selectedWeapon === "fire_punch") return;

      // Lock aim direction while charging power (spacebar held)
      if (this.aimLocked) return;

      const activeWorm = this.getActiveWorm();
      if (!activeWorm) return;

      const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      this.currentAimAngle = Math.atan2(
        worldPoint.y - activeWorm.y,
        worldPoint.x - activeWorm.x,
      );
      activeWorm.showAimLine(this.currentAimAngle, this.currentPower);
      activeWorm.setAimAngle(this.currentAimAngle);
      this.events.emit("aim_update", this.currentAimAngle);
    });

    // Click for teleport
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (!this.isMyTurn || !this.isAiming) return;
      if (this.selectedWeapon === "teleport") {
        const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        this.sendMessage({ type: "USE_TELEPORT", x: world.x, y: world.y });
        this.isAiming = false;
        this.hideTeleportCursor();
      }
    });

    // Spacebar: hold to charge power, release to fire
    this.input.keyboard!.on("keydown-SPACE", () => {
      if (!this.isMyTurn || !this.isAiming) return;

      // Teleport uses click, not spacebar
      if (this.selectedWeapon === "teleport") return;

      // Fire punch: instant fire on press, no charge
      if (this.selectedWeapon === "fire_punch") {
        this.firePunch();
        return;
      }

      // Shotgun: instant fire on press, no charge
      if (this.selectedWeapon === "shotgun") {
        this.fire();
        return;
      }

      if (this.isCharging) return;
      this.isCharging = true;
      this.aimLocked = true;
      this.chargeStartTime = Date.now();
      this.currentPower = 0;
      this.events.emit("charge_start");
      this.events.emit("power_update", 0);
      // Pause the turn timer while charging (like original Worms 2)
      this.sendMessage({ type: "PAUSE_TIMER" });
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

    // Number keys 1-5: select weapon (or set grenade fuse timer when grenade is selected)
    // Uses physical key codes (Digit1-Digit5) so it works on both QWERTY and AZERTY
    this.input.keyboard!.on("keydown", (event: KeyboardEvent) => {
      if (!this.isMyTurn) return;
      const digitMatch = event.code.match(/^Digit([1-5])$/);
      if (!digitMatch) return;
      const num = parseInt(digitMatch[1], 10); // 1-5
      const idx = num - 1; // 0-4

      // When grenade is selected and aiming, keys 1-3 set fuse timer
      if (this.selectedWeapon === "grenade" && this.isAiming && num <= 3) {
        this.grenadeFuseSeconds = num;
        this.events.emit("grenade_fuse", this.grenadeFuseSeconds);
        return;
      }

      if (idx < MVP_WEAPON_IDS.length) {
        this.selectWeapon(MVP_WEAPON_IDS[idx]);
      }
    });

    // Hide bouncing arrow on any keypress during my turn
    this.input.keyboard!.on("keydown", () => {
      if (!this.isMyTurn) return;
      this.getActiveWorm()?.hideArrow();
    });
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
        this.getActiveWorm()?.setWalking(true);
      } else if (rightDown && !this.isMovingRight) {
        this.isMovingRight = true;
        this.isMovingLeft = false;
        this.sendMessage({ type: "MOVE_START", direction: "right" });
        this.getActiveWorm()?.setWalking(true);
      } else if (
        !leftDown &&
        !rightDown &&
        (this.isMovingLeft || this.isMovingRight)
      ) {
        this.isMovingLeft = false;
        this.isMovingRight = false;
        this.sendMessage({ type: "MOVE_STOP" });
        this.getActiveWorm()?.setWalking(false);
      }

      // Update power while charging
      if (this.isCharging) {
        const elapsed = Date.now() - this.chargeStartTime;
        this.currentPower = Math.min(1, elapsed / this.CHARGE_DURATION_MS);
        this.events.emit("power_update", this.currentPower);
        const activeWorm = this.getActiveWorm();
        activeWorm?.showAimLine(this.currentAimAngle, this.currentPower);
        activeWorm?.updatePowerGauge(this.currentPower);

        // Auto-fire at max power
        if (this.currentPower >= 1) {
          this.isCharging = false;
          this.fire();
        }
      }
    }

    // Update worm lerping
    this.wormEntities.forEach((entity) => entity.update());

    // Camera: follow active worm when it moves, otherwise allow edge-scroll
    const activeWorm = this.getActiveWorm();
    if (activeWorm && this.isMyTurn) {
      const isWormMoving = this.isMovingLeft || this.isMovingRight;
      if (isWormMoving && !this.cameraFollowingWorm) {
        this.cameraFollowingWorm = true;
      }
      if (this.cameraFollowingWorm) {
        this.cameras.main.centerOn(activeWorm.x, activeWorm.y);
        if (!isWormMoving) {
          this.cameraFollowingWorm = false;
        }
      }
    }

    // Edge-of-screen camera panning
    if (!this.cameraFollowingWorm) {
      const pointer = this.input.activePointer;
      const cam = this.cameras.main;
      const dt = this.game.loop.delta / 1000;
      const zone = this.EDGE_SCROLL_ZONE;
      const speed = this.EDGE_SCROLL_SPEED;
      let scrollX = 0;
      let scrollY = 0;

      if (pointer.x < zone) {
        scrollX = -speed * dt;
      } else if (pointer.x > cam.width - zone) {
        scrollX = speed * dt;
      }
      if (pointer.y < zone) {
        scrollY = -speed * dt;
      } else if (pointer.y > cam.height - zone) {
        scrollY = speed * dt;
      }

      if (scrollX !== 0 || scrollY !== 0) {
        cam.scrollX += scrollX;
        cam.scrollY += scrollY;
      }
    }

    // Update wind particles
    this.updateWindParticles();
  }

  // ─── Wind Particles ─────────────────────────────────────

  private spawnWindParticles(): void {
    this.destroyWindParticles();
    if (Math.abs(this.currentWind) < 5) return;

    const useDebris = this.textures.exists("terrain_debris");
    const useFeather = this.textures.exists("fx_feather");
    if (!useDebris && !useFeather) return;

    const textureKey = useDebris ? "terrain_debris" : "fx_feather";
    const animKey = useDebris ? "anim_debris" : "anim_feather";
    const totalFrames = useDebris ? 122 : 74;

    const count = Math.min(
      25,
      Math.max(8, Math.floor(Math.abs(this.currentWind) / 5)),
    );
    const camBounds = this.cameras.main.worldView;

    for (let i = 0; i < count; i++) {
      // Spread debris across the full screen width
      const startX = camBounds.left + Math.random() * camBounds.width;
      const startY = camBounds.top + Math.random() * camBounds.height;

      const particle = this.add.sprite(startX, startY, textureKey, 0);
      particle.setDepth(0.5);
      const scale = useDebris ? 0.6 + Math.random() * 0.3 : 1.2;
      particle.setScale(scale);
      particle.setAlpha(0.4 + Math.random() * 0.3);
      if (this.anims.exists(animKey)) {
        // Start at a random frame and play at a slower speed for subtler motion
        particle.play({
          key: animKey,
          startFrame: Math.floor(Math.random() * totalFrames),
          frameRate: 15,
        });
      }
      if (this.currentWind < 0) particle.setFlipX(true);
      this.windParticles.push(particle);
    }
  }

  private updateWindParticles(): void {
    if (this.windParticles.length === 0) return;

    const speed = Math.abs(this.currentWind) * 1.5;
    const dir = this.currentWind > 0 ? 1 : -1;
    const dt = this.game.loop.delta / 1000;
    const camBounds = this.cameras.main.worldView;

    for (const feather of this.windParticles) {
      feather.x += speed * dir * dt;
      feather.y += Math.sin(feather.x * 0.01 + feather.y * 0.005) * 15 * dt;

      // Wrap around when off-screen
      if (dir > 0 && feather.x > camBounds.right + 80) {
        feather.x = camBounds.left - 60;
        feather.y = camBounds.top + Math.random() * camBounds.height;
      } else if (dir < 0 && feather.x < camBounds.left - 80) {
        feather.x = camBounds.right + 60;
        feather.y = camBounds.top + Math.random() * camBounds.height;
      }
    }
  }

  private destroyWindParticles(): void {
    for (const p of this.windParticles) p.destroy();
    this.windParticles = [];
  }

  // ─── Teleport Cursor ───────────────────────────────────

  private showTeleportCursor(): void {
    this.hideTeleportCursor();

    // Pick cursor by team color
    const myPlayer = this.gameState?.players.find(
      (p) => p.id === this.playerId,
    );
    const colorKey = myPlayer?.teamColor ?? "red";
    const cursorTextureMap: Record<string, string> = {
      red: "cursor_red",
      blue: "cursor_blue",
      green: "cursor_green",
      yellow: "cursor_yellow",
    };
    const textureKey = cursorTextureMap[colorKey] ?? "cursor_red";

    if (!this.textures.exists(textureKey)) return;

    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    this.teleportCursor = this.add.sprite(
      worldPoint.x,
      worldPoint.y,
      textureKey,
      0,
    );
    this.teleportCursor.setDepth(10);
    this.teleportCursor.setScale(0.8);

    // Animate cursor
    const animKey = `anim_${textureKey}`;
    if (!this.anims.exists(animKey)) {
      this.anims.create({
        key: animKey,
        frames: this.anims.generateFrameNumbers(textureKey, {
          start: 0,
          end: 31,
        }),
        frameRate: 30,
        repeat: -1,
      });
    }
    this.teleportCursor.play(animKey);
  }

  private hideTeleportCursor(): void {
    this.teleportCursor?.destroy();
    this.teleportCursor = null;
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
      case "WORM_DAMAGE": {
        const entity = this.wormEntities.get(msg.wormId);
        if (entity) {
          entity.flashDamage(msg.damage);
          entity.updateState({ health: msg.newHealth });
        }
        this.updateGameStateWorm(msg.wormId, { health: msg.newHealth });
        this.refreshHUDPanels();
        break;
      }
      case "WORM_DIED": {
        const entity = this.wormEntities.get(msg.wormId);
        entity?.updateState({ isAlive: false });
        this.updateGameStateWorm(msg.wormId, { isAlive: false, health: 0 });
        this.refreshHUDPanels();
        break;
      }
      case "RETREAT_START":
        this.isAiming = false;
        this.isCharging = false;
        this.aimLocked = false;
        this.getActiveWorm()?.hideAimLine();
        this.getActiveWorm()?.hidePowerGauge();
        this.hideTeleportCursor();
        break;
      case "TURN_END":
        this.isMyTurn = false;
        this.isAiming = false;
        this.isCharging = false;
        this.aimLocked = false;
        this.isMovingLeft = false;
        this.isMovingRight = false;
        this.getActiveWorm()?.hidePowerGauge();
        this.hideTeleportCursor();
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

    // Set initial wind particles
    this.currentWind = state.wind;
    this.spawnWindParticles();
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
    this.isAiming = this.isMyTurn;
    this.isCharging = false;
    this.currentPower = 0;
    this.selectedWeapon = "bazooka";
    this.isMovingLeft = false;
    this.isMovingRight = false;
    this.hideTeleportCursor();

    // Set weapon hold on active worm
    if (this.isMyTurn && wormEntity) {
      wormEntity.setWeaponHold("bazooka");
    }

    if (this.gameState) {
      this.gameState.activePlayerId = msg.activePlayerId;
      this.gameState.activeWormId = msg.activeWormId;
      this.gameState.wind = msg.wind;
      this.gameState.turnTimeRemaining = msg.turnTime;
    }

    // Update wind
    this.currentWind = msg.wind;
    this.spawnWindParticles();

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

  private onWormJumped(msg: {
    wormId: string;
    vx: number;
    vy: number;
    kind: "forward" | "backflip";
  }): void {
    const entity = this.wormEntities.get(msg.wormId);
    if (entity) {
      entity.updateState({ vx: msg.vx, vy: msg.vy });
      entity.playJumpAnim(msg.kind);
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
        this.updateGameStateWorm(msg.wormId, { isAlive: false, health: 0 });
      }
    }
    this.updateGameStateWorm(msg.wormId, { health: msg.newHealth });
    this.refreshHUDPanels();
  }

  private onWormFellInWater(msg: { wormId: string }): void {
    const entity = this.wormEntities.get(msg.wormId);
    if (entity) {
      entity.updateState({ isAlive: false });
    }
    this.updateGameStateWorm(msg.wormId, { isAlive: false, health: 0 });
    this.refreshHUDPanels();
  }

  private onFireResult(msg: {
    trajectory: TrajectoryPoint[];
    weaponId: WeaponId;
    fuseMs?: number;
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
      this.animateProjectile(
        msg.trajectory,
        msg.weaponId,
        () => {
          this.applyFireEffects(msg);
        },
        msg.fuseMs,
      );
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
      this.updateGameStateWorm(dmg.wormId, { health: dmg.newHealth });
    }

    for (const death of msg.deaths) {
      const entity = this.wormEntities.get(death.wormId);
      entity?.updateState({ isAlive: false });
      this.updateGameStateWorm(death.wormId, { isAlive: false, health: 0 });
    }

    this.refreshHUDPanels();
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
    // Play shotgun fire animation on the worm
    const activeWorm = this.getActiveWorm();
    activeWorm?.playFireAnim();

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

    if (msg.shotsRemaining > 0) {
      this.isAiming = true;
    } else {
      // Last shot — play weapon put-away animation
      activeWorm?.playPutAwayAnim();
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
    this.hideTeleportCursor();
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

      // Play teleporter put-away animation after teleporting
      entity.playPutAwayAnim();

      this.cameras.main.pan(msg.x, msg.y, 300);
    }
  }

  // ─── Projectile Animation ───────────────────────────────

  private animateProjectile(
    trajectory: TrajectoryPoint[],
    weaponId: WeaponId,
    onComplete: () => void,
    fuseMs?: number,
  ): void {
    if (trajectory.length < 2) {
      onComplete();
      return;
    }

    // Create sprite or fallback circle for projectile
    const useMissile =
      weaponId === "bazooka" && this.textures.exists("proj_missile");
    const useGrenade =
      weaponId === "grenade" && this.textures.exists("proj_grenade");

    if (useMissile) {
      this.projectileSprite = this.add.sprite(
        trajectory[0].x,
        trajectory[0].y,
        "proj_missile",
        0,
      );
      this.projectileSprite.setDepth(6);
      this.projectileSprite.setScale(1.0);
    } else if (useGrenade) {
      this.projectileSprite = this.add.sprite(
        trajectory[0].x,
        trajectory[0].y,
        "proj_grenade",
        0,
      );
      this.projectileSprite.setDepth(6);
      this.projectileSprite.setScale(1.0);
      if (this.anims.exists("anim_grenade")) {
        this.projectileSprite.play("anim_grenade");
      }
      // Create countdown text above grenade if fuse timer is set
      if (fuseMs && fuseMs > 0) {
        this.grenadeCountdownText = this.add.text(
          trajectory[0].x,
          trajectory[0].y - 20,
          String(Math.ceil(fuseMs / 1000)),
          {
            fontSize: "14px",
            fontFamily: "monospace",
            color: "#ffffff",
            stroke: "#000000",
            strokeThickness: 3,
            fontStyle: "bold",
          },
        );
        this.grenadeCountdownText.setOrigin(0.5);
        this.grenadeCountdownText.setDepth(7);
      }
    } else {
      this.projectileFallback = this.add.circle(
        trajectory[0].x,
        trajectory[0].y,
        4,
        0xff6600,
      );
      this.projectileFallback.setDepth(6);
    }

    let index = 0;
    const startTime = this.time.now;
    let lastSmokeTime = 0;
    const smokeInterval = 80; // ms between smoke puffs
    const hasSmoke = useMissile && this.anims.exists("anim_smoke");
    // Initialize missile angle from first two trajectory points
    let missileAngle = Math.atan2(
      trajectory[1].y - trajectory[0].y,
      trajectory[1].x - trajectory[0].x,
    );
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
          this.projectileSprite?.setPosition(last.x, last.y);
          this.projectileFallback?.setPosition(last.x, last.y);
          this.grenadeCountdownText?.destroy();
          this.grenadeCountdownText = null;
          this.projectileSprite?.destroy();
          this.projectileFallback?.destroy();
          this.projectileSprite = null;
          this.projectileFallback = null;
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

        if (this.projectileSprite) {
          this.projectileSprite.setPosition(x, y);
          // Missile: select spritesheet frame based on flight angle
          // The missile spritesheet has 32 frames showing the missile
          // at different rotation angles (frame 0 = up, rotating clockwise)
          if (useMissile) {
            const lookAhead = Math.min(index + 8, trajectory.length - 1);
            const ldx = trajectory[lookAhead].x - trajectory[index].x;
            const ldy = trajectory[lookAhead].y - trajectory[index].y;
            if (Math.abs(ldx) > 0.5 || Math.abs(ldy) > 0.5) {
              const targetAngle = Math.atan2(ldy, ldx);
              let diff = targetAngle - missileAngle;
              if (diff > Math.PI) diff -= 2 * Math.PI;
              if (diff < -Math.PI) diff += 2 * Math.PI;
              missileAngle += diff * 0.25;
            }
            // Map angle to frame: frame 0 = up (-PI/2), clockwise
            // Normalize angle to [0, 2*PI), then map to frame
            let normalizedAngle = missileAngle + Math.PI / 2; // offset so 0 = up
            if (normalizedAngle < 0) normalizedAngle += 2 * Math.PI;
            normalizedAngle = normalizedAngle % (2 * Math.PI);
            const frame =
              Math.round((normalizedAngle / (2 * Math.PI)) * 32) % 32;
            this.projectileSprite.setFrame(frame);
          }
        }
        if (this.projectileFallback) {
          this.projectileFallback.setPosition(x, y);
        }

        // Update grenade countdown text
        if (this.grenadeCountdownText && fuseMs) {
          this.grenadeCountdownText.setPosition(x, y - 20);
          const remaining = Math.ceil((fuseMs - elapsed) / 1000);
          this.grenadeCountdownText.setText(String(Math.max(0, remaining)));
        }

        // Spawn smoke puffs behind missile
        if (hasSmoke && elapsed - lastSmokeTime > smokeInterval) {
          lastSmokeTime = elapsed;
          const smoke = this.add.sprite(x, y, "fx_smoke", 0);
          smoke.setDepth(5);
          smoke.setScale(1.0);
          smoke.setAlpha(0.7);
          smoke.play("anim_smoke");
          smoke.once("animationcomplete", () => smoke.destroy());
          this.smokeTrail.push(smoke);
        }

        this.cameras.main.centerOn(x, y);
      },
    });
  }

  // ─── Fire Weapon ────────────────────────────────────────

  private fire(): void {
    this.isAiming = false;
    this.aimLocked = false;
    const activeWorm = this.getActiveWorm();
    activeWorm?.hideAimLine();
    activeWorm?.hidePowerGauge();

    if (this.selectedWeapon === "shotgun") {
      this.sendMessage({
        type: "FIRE_HITSCAN",
        weaponId: this.selectedWeapon,
        angle: this.currentAimAngle,
      });
      this.isAiming = true;
    } else {
      const fireMsg: {
        type: "FIRE";
        weaponId: WeaponId;
        angle: number;
        power: number;
        fuseMs?: number;
      } = {
        type: "FIRE",
        weaponId: this.selectedWeapon,
        angle: this.currentAimAngle,
        power: this.currentPower,
      };
      // Send fuse timer for grenades
      if (this.selectedWeapon === "grenade") {
        fireMsg.fuseMs = this.grenadeFuseSeconds * 1000;
      }
      this.sendMessage(fireMsg);
      // Play weapon put-away animation for projectile weapons (bazooka, grenade)
      activeWorm?.playPutAwayAnim();
    }
  }

  private firePunch(): void {
    this.isAiming = false;
    const worm = this.getActiveWorm();
    worm?.hidePowerGauge();
    const direction = worm?.facing ?? "right";

    // Play punch animation, then send the message
    if (worm) {
      worm.playPunchAnim().then(() => {
        // Animation done (or skipped if no sprite)
      });
    }

    // Send melee immediately (server processes it; animation is cosmetic)
    this.sendMessage({
      type: "FIRE_MELEE",
      weaponId: "fire_punch",
      direction,
    });
  }

  // ─── Helpers ────────────────────────────────────────────

  private getActiveWorm(): WormEntity | undefined {
    if (!this.gameState) return undefined;
    return this.wormEntities.get(this.gameState.activeWormId);
  }

  /** Update a worm's health/alive status in the local gameState copy */
  private updateGameStateWorm(
    wormId: string,
    patch: Partial<{ health: number; isAlive: boolean }>,
  ): void {
    if (!this.gameState) return;
    for (const player of this.gameState.players) {
      for (const worm of player.worms) {
        if (worm.id === wormId) {
          Object.assign(worm, patch);
          return;
        }
      }
    }
  }

  /** Re-render the HUD player panels with current gameState */
  private refreshHUDPanels(): void {
    if (!this.gameState) return;
    this.scene.get("HUDScene").events.emit("state_sync", this.gameState);
  }

  selectWeapon(weaponId: WeaponId): void {
    this.selectedWeapon = weaponId;
    this.isAiming = true;
    this.currentPower = 0;
    this.sendMessage({ type: "SELECT_WEAPON", weaponId });
    this.events.emit("weapon_selected", weaponId);

    // Set weapon hold animation on active worm
    const worm = this.getActiveWorm();
    if (worm) {
      worm.setWeaponHold(weaponId);
    }

    // Teleport: show cursor, hide aim line
    if (weaponId === "teleport") {
      worm?.hideAimLine();
      this.showTeleportCursor();
    } else {
      this.hideTeleportCursor();
    }

    // Fire punch: hide aim line (direction only)
    if (weaponId === "fire_punch") {
      worm?.hideAimLine();
    }
  }

  shutdown(): void {
    this.socket?.close();
    this.terrainRenderer?.destroy();
    this.wormEntities.forEach((w) => w.destroy());
    this.wormEntities.clear();
    this.projectileSprite?.destroy();
    this.projectileFallback?.destroy();
    for (const s of this.smokeTrail) s.destroy();
    this.smokeTrail = [];
    this.hideTeleportCursor();
    this.destroyWindParticles();
  }
}
