import * as Phaser from "phaser";
import {
  TERRAIN_WIDTH,
  TERRAIN_HEIGHT,
  WATER_LEVEL,
  decodeBitmap,
  getBitmapPixel,
  eraseCircleFromBitmap,
} from "@worms/shared";
import type { TerrainData, TerrainTheme } from "@worms/shared";

interface ThemeColors {
  fill: string;
  edge: string;
  sky: [string, string];
  water: string;
}

const THEME_COLORS: Record<TerrainTheme, ThemeColors> = {
  prairie: {
    fill: "#6B4226",
    edge: "#4CAF50",
    sky: ["#87CEEB", "#1565C0"],
    water: "#1976D2",
  },
  hell: {
    fill: "#1A0A0A",
    edge: "#B71C1C",
    sky: ["#4A0000", "#1A0000"],
    water: "#FF6F00",
  },
  arctic: {
    fill: "#E0E0E0",
    edge: "#FFFFFF",
    sky: ["#B3E5FC", "#90CAF9"],
    water: "#4FC3F7",
  },
  cheese: {
    fill: "#FFC107",
    edge: "#FF8F00",
    sky: ["#0D1B2A", "#1B2838"],
    water: "#76FF03",
  },
  urban: {
    fill: "#616161",
    edge: "#424242",
    sky: ["#37474F", "#263238"],
    water: "#455A64",
  },
  mars: {
    fill: "#BF360C",
    edge: "#8D6E63",
    sky: ["#FF8A65", "#4E342E"],
    water: "#76FF03",
  },
  forest: {
    fill: "#6B4226",
    edge: "#4CAF50",
    sky: ["#87CEEB", "#1565C0"],
    water: "#1976D2",
  },
};

/** Check if a terrain texture was preloaded in Phaser */
function hasTexture(scene: Phaser.Scene, key: string): boolean {
  return scene.textures.exists(key) && key !== "__MISSING";
}

export class TerrainRenderer {
  private bitmap: Uint8Array;
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private texture: Phaser.Textures.CanvasTexture;
  private image: Phaser.GameObjects.Image;
  private waterRect: Phaser.GameObjects.Rectangle;
  private waterWave: Phaser.GameObjects.Graphics;
  private waveTime: number = 0;
  private waveUpdateEvent: Phaser.Time.TimerEvent | null = null;
  private background: Phaser.GameObjects.Graphics;
  private backImage: Phaser.GameObjects.TileSprite | null = null;
  private theme: TerrainTheme;

  // Cached texture canvases for forest theme
  private soilPattern: CanvasPattern | null = null;
  private grassCanvas: OffscreenCanvas | null = null;

  constructor(
    private scene: Phaser.Scene,
    terrainData: TerrainData,
  ) {
    this.theme = terrainData.theme;
    this.bitmap = decodeBitmap(terrainData.bitmap);

    // Cache texture patterns for forest theme
    if (this.theme === "forest") {
      this.initForestTextures();
    }

    // Background
    this.background = scene.add.graphics();
    this.background.setDepth(0);
    this.drawBackground();

    // Background scenery layer (forest back.png)
    if (this.theme === "forest" && hasTexture(scene, "terrain_back")) {
      this.backImage = scene.add.tileSprite(
        TERRAIN_WIDTH / 2,
        TERRAIN_HEIGHT - 159 / 2 - 40,
        TERRAIN_WIDTH,
        159,
        "terrain_back",
      );
      this.backImage.setDepth(0.5);
      this.backImage.setAlpha(0.8);
    }

    // Terrain canvas
    this.canvas = new OffscreenCanvas(TERRAIN_WIDTH, TERRAIN_HEIGHT);
    this.ctx = this.canvas.getContext("2d")!;
    this.renderFull();

    // Create Phaser texture from canvas
    const texCanvas = document.createElement("canvas");
    texCanvas.width = TERRAIN_WIDTH;
    texCanvas.height = TERRAIN_HEIGHT;
    const texCtx = texCanvas.getContext("2d")!;
    texCtx.drawImage(this.canvas, 0, 0);

    this.texture = scene.textures.addCanvas("terrain", texCanvas)!;
    this.image = scene.add.image(
      TERRAIN_WIDTH / 2,
      TERRAIN_HEIGHT / 2,
      "terrain",
    );
    this.image.setDepth(1);

    // Water
    const waterHeight = TERRAIN_HEIGHT - WATER_LEVEL + 100;
    const colors = THEME_COLORS[this.theme];
    const waterColor = parseInt(colors.water.replace("#", ""), 16);
    this.waterRect = scene.add.rectangle(
      TERRAIN_WIDTH / 2,
      WATER_LEVEL + waterHeight / 2,
      TERRAIN_WIDTH + 200,
      waterHeight,
      waterColor,
      0.7,
    );
    this.waterRect.setDepth(2);

    // Animated wave overlay at water surface
    this.waterWave = scene.add.graphics();
    this.waterWave.setDepth(2.5);
    this.drawWave();

    // Animate wave
    this.waveUpdateEvent = scene.time.addEvent({
      delay: 50,
      loop: true,
      callback: () => {
        this.waveTime += 0.08;
        this.drawWave();
      },
    });
  }

  /** Extract canvas image data from a Phaser texture for use in OffscreenCanvas */
  private extractTextureCanvas(key: string): OffscreenCanvas | null {
    if (!hasTexture(this.scene, key)) return null;
    const source = this.scene.textures.get(key).getSourceImage();
    const w = source.width;
    const h = source.height;
    const offscreen = new OffscreenCanvas(w, h);
    const ctx = offscreen.getContext("2d")!;
    ctx.drawImage(source as CanvasImageSource, 0, 0);
    return offscreen;
  }

  private initForestTextures(): void {
    // Soil pattern
    const soilCanvas = this.extractTextureCanvas("terrain_soil");
    if (soilCanvas) {
      const tempCanvas = new OffscreenCanvas(1, 1);
      const tempCtx = tempCanvas.getContext("2d")!;
      this.soilPattern = tempCtx.createPattern(soilCanvas, "repeat");
    }

    // Grass canvas
    this.grassCanvas = this.extractTextureCanvas("terrain_grass");
  }

  private drawWave(): void {
    this.waterWave.clear();
    const colors = THEME_COLORS[this.theme];
    const waterColor = parseInt(colors.water.replace("#", ""), 16);

    const r = (waterColor >> 16) & 0xff;
    const g = (waterColor >> 8) & 0xff;
    const b = waterColor & 0xff;
    const lighterColor =
      (Math.min(255, r + 60) << 16) |
      (Math.min(255, g + 60) << 8) |
      Math.min(255, b + 60);
    const whiteHighlight = 0xffffff;

    const waveY = WATER_LEVEL;
    const startX = -100;
    const endX = TERRAIN_WIDTH + 100;
    const step = 4;

    this.waterWave.lineStyle(2, whiteHighlight, 0.6);
    this.waterWave.beginPath();
    for (let x = startX; x <= endX; x += step) {
      const y =
        waveY +
        Math.sin(x * 0.02 + this.waveTime) * 3 +
        Math.sin(x * 0.035 + this.waveTime * 1.3) * 2;
      if (x === startX) {
        this.waterWave.moveTo(x, y);
      } else {
        this.waterWave.lineTo(x, y);
      }
    }
    this.waterWave.strokePath();

    this.waterWave.lineStyle(3, lighterColor, 0.5);
    this.waterWave.beginPath();
    for (let x = startX; x <= endX; x += step) {
      const y =
        waveY +
        4 +
        Math.sin(x * 0.025 + this.waveTime * 0.8 + 1.5) * 2.5 +
        Math.sin(x * 0.015 + this.waveTime * 1.1) * 1.5;
      if (x === startX) {
        this.waterWave.moveTo(x, y);
      } else {
        this.waterWave.lineTo(x, y);
      }
    }
    this.waterWave.strokePath();

    this.waterWave.lineStyle(1, whiteHighlight, 0.3);
    this.waterWave.beginPath();
    for (let x = startX; x <= endX; x += step) {
      const y =
        waveY -
        2 +
        Math.sin(x * 0.03 + this.waveTime * 1.5 + 3.0) * 2 +
        Math.sin(x * 0.01 + this.waveTime * 0.6) * 3;
      if (x === startX) {
        this.waterWave.moveTo(x, y);
      } else {
        this.waterWave.lineTo(x, y);
      }
    }
    this.waterWave.strokePath();
  }

  getBitmap(): Uint8Array {
    return this.bitmap;
  }

  eraseCircle(cx: number, cy: number, radius: number): void {
    eraseCircleFromBitmap(this.bitmap, cx, cy, radius);
    this.renderRegion(
      cx - radius - 2,
      cy - radius - 2,
      radius * 2 + 4,
      radius * 2 + 4,
    );
    this.updateTexture();
  }

  private renderFull(): void {
    this.ctx.clearRect(0, 0, TERRAIN_WIDTH, TERRAIN_HEIGHT);

    if (this.theme === "forest" && this.soilPattern) {
      this.renderForestFull();
    } else {
      this.renderFlatFull();
    }
  }

  /** Original flat-color rendering for non-forest themes */
  private renderFlatFull(): void {
    const colors = THEME_COLORS[this.theme];

    this.ctx.fillStyle = colors.fill;
    for (let y = 0; y < TERRAIN_HEIGHT; y++) {
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        if (getBitmapPixel(this.bitmap, x, y)) {
          this.ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    this.ctx.fillStyle = colors.edge;
    const edgeThickness = 3;
    for (let y = 0; y < TERRAIN_HEIGHT; y++) {
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        if (!getBitmapPixel(this.bitmap, x, y)) continue;
        let isEdge = false;
        for (let dy = -edgeThickness; dy <= edgeThickness && !isEdge; dy++) {
          for (let dx = -edgeThickness; dx <= edgeThickness && !isEdge; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (!getBitmapPixel(this.bitmap, x + dx, y + dy)) {
              isEdge = true;
            }
          }
        }
        if (isEdge) {
          this.ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }

  /** Texture-based rendering for forest theme */
  private renderForestFull(): void {
    // Step 1: Fill all terrain pixels with soil texture pattern
    this.ctx.save();
    this.ctx.fillStyle = this.soilPattern!;
    for (let y = 0; y < TERRAIN_HEIGHT; y++) {
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        if (getBitmapPixel(this.bitmap, x, y)) {
          this.ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    this.ctx.restore();

    // Step 2: Draw grass edge texture at terrain surface
    this.renderGrassEdge(0, 0, TERRAIN_WIDTH, TERRAIN_HEIGHT);
  }

  /** Draw grass texture at terrain surface edges */
  private renderGrassEdge(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    if (!this.grassCanvas) return;

    const grassW = this.grassCanvas.width; // 144
    const grassH = this.grassCanvas.height; // 16
    const grassCtx = this.grassCanvas.getContext("2d")!;
    const grassData = grassCtx.getImageData(0, 0, grassW, grassH);

    // For each column, find the topmost terrain pixel and draw grass there
    for (let x = minX; x < maxX; x++) {
      // Find topmost solid pixel in this column
      let topY = -1;
      for (let y = Math.max(0, minY); y < Math.min(TERRAIN_HEIGHT, maxY); y++) {
        if (getBitmapPixel(this.bitmap, x, y)) {
          topY = y;
          break;
        }
      }
      if (topY < 0) continue;

      // Sample grass texture column (tile horizontally)
      const gx = x % grassW;
      for (let gy = 0; gy < grassH; gy++) {
        const drawY = topY - grassH / 2 + gy;
        if (drawY < 0 || drawY >= TERRAIN_HEIGHT) continue;
        // Only draw on terrain pixels (or slightly above for the grass tips)
        const onTerrain = getBitmapPixel(this.bitmap, x, drawY);
        const aboveTerrain = gy < grassH / 2;
        if (!onTerrain && !aboveTerrain) continue;

        const gi = (gy * grassW + gx) * 4;
        const a = grassData.data[gi + 3];
        if (a < 10) continue; // skip transparent

        const r = grassData.data[gi];
        const g = grassData.data[gi + 1];
        const b = grassData.data[gi + 2];
        this.ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
        this.ctx.fillRect(x, drawY, 1, 1);
      }
    }
  }

  private renderRegion(rx: number, ry: number, rw: number, rh: number): void {
    const minX = Math.max(0, rx);
    const minY = Math.max(0, ry);
    const maxX = Math.min(TERRAIN_WIDTH, rx + rw);
    const maxY = Math.min(TERRAIN_HEIGHT, ry + rh);

    this.ctx.clearRect(minX, minY, maxX - minX, maxY - minY);

    if (this.theme === "forest" && this.soilPattern) {
      // Soil fill
      this.ctx.save();
      this.ctx.fillStyle = this.soilPattern;
      for (let y = minY; y < maxY; y++) {
        for (let x = minX; x < maxX; x++) {
          if (getBitmapPixel(this.bitmap, x, y)) {
            this.ctx.fillRect(x, y, 1, 1);
          }
        }
      }
      this.ctx.restore();

      // Grass edge
      this.renderGrassEdge(minX, minY, maxX, maxY);
    } else {
      const colors = THEME_COLORS[this.theme];

      this.ctx.fillStyle = colors.fill;
      for (let y = minY; y < maxY; y++) {
        for (let x = minX; x < maxX; x++) {
          if (getBitmapPixel(this.bitmap, x, y)) {
            this.ctx.fillRect(x, y, 1, 1);
          }
        }
      }

      this.ctx.fillStyle = colors.edge;
      const edgeThickness = 3;
      for (let y = minY; y < maxY; y++) {
        for (let x = minX; x < maxX; x++) {
          if (!getBitmapPixel(this.bitmap, x, y)) continue;
          let isEdge = false;
          for (let dy = -edgeThickness; dy <= edgeThickness && !isEdge; dy++) {
            for (
              let dx = -edgeThickness;
              dx <= edgeThickness && !isEdge;
              dx++
            ) {
              if (dx === 0 && dy === 0) continue;
              if (!getBitmapPixel(this.bitmap, x + dx, y + dy)) {
                isEdge = true;
              }
            }
          }
          if (isEdge) {
            this.ctx.fillRect(x, y, 1, 1);
          }
        }
      }
    }
  }

  private updateTexture(): void {
    const source = this.texture.getSourceImage() as HTMLCanvasElement;
    const ctx = source.getContext("2d")!;
    ctx.clearRect(0, 0, TERRAIN_WIDTH, TERRAIN_HEIGHT);
    ctx.drawImage(this.canvas, 0, 0);
    this.texture.refresh();
  }

  private drawBackground(): void {
    if (this.theme === "forest") {
      this.drawGradientBackground();
    } else {
      this.drawFlatBackground();
    }
  }

  /** Use gradient.png to draw a smooth vertical gradient sky */
  private drawGradientBackground(): void {
    const gradCanvas = this.extractTextureCanvas("terrain_gradient");
    if (!gradCanvas) {
      this.drawFlatBackground();
      return;
    }

    const gradCtx = gradCanvas.getContext("2d")!;
    const gradData = gradCtx.getImageData(
      0,
      0,
      gradCanvas.width,
      gradCanvas.height,
    );
    const gradH = gradCanvas.height; // 916

    // Sample the gradient strip and draw horizontal bands
    const totalH = TERRAIN_HEIGHT + 400; // cover camera bounds
    for (let screenY = 0; screenY < totalH; screenY++) {
      const drawY = screenY - 200;
      // Map screen Y to gradient Y
      const gy = Math.min(
        gradH - 1,
        Math.max(0, Math.floor((screenY / totalH) * gradH)),
      );
      // Sample pixel at x=0 (it's a uniform strip)
      const gi = gy * gradCanvas.width * 4;
      const r = gradData.data[gi];
      const g = gradData.data[gi + 1];
      const b = gradData.data[gi + 2];
      const color = (r << 16) | (g << 8) | b;

      this.background.fillStyle(color, 1);
      this.background.fillRect(-200, drawY, TERRAIN_WIDTH + 400, 1);
    }
  }

  /** Original flat two-tone sky */
  private drawFlatBackground(): void {
    const colors = THEME_COLORS[this.theme];
    const c1 = parseInt(colors.sky[0].replace("#", ""), 16);
    const c2 = parseInt(colors.sky[1].replace("#", ""), 16);

    this.background.fillStyle(c1, 1);
    this.background.fillRect(
      -200,
      -200,
      TERRAIN_WIDTH + 400,
      TERRAIN_HEIGHT / 2 + 200,
    );
    this.background.fillStyle(c2, 1);
    this.background.fillRect(
      -200,
      TERRAIN_HEIGHT / 2,
      TERRAIN_WIDTH + 400,
      TERRAIN_HEIGHT / 2 + 200,
    );
  }

  destroy(): void {
    this.image.destroy();
    this.waterRect.destroy();
    this.waterWave.destroy();
    this.backImage?.destroy();
    if (this.waveUpdateEvent) {
      this.waveUpdateEvent.destroy();
      this.waveUpdateEvent = null;
    }
    this.background.destroy();
    if (this.scene.textures.exists("terrain")) {
      this.scene.textures.remove("terrain");
    }
  }
}
