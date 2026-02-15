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

  // Cached pixel data for forest textures
  private soilData: ImageData | null = null;
  private soilW: number = 0;
  private soilH: number = 0;
  private grassData: ImageData | null = null;
  private grassW: number = 0;
  private grassH: number = 0;
  private gradientData: ImageData | null = null;
  private gradientH: number = 0;

  constructor(
    private scene: Phaser.Scene,
    terrainData: TerrainData,
  ) {
    this.theme = terrainData.theme;
    this.bitmap = decodeBitmap(terrainData.bitmap);

    // Always try to load forest textures if available (server may send any theme)
    this.initForestTextures();
    // Override theme to forest if we successfully loaded the textures
    if (this.soilData) {
      this.theme = "forest" as TerrainTheme;
    }

    // Background
    this.background = scene.add.graphics();
    this.background.setDepth(0);
    this.drawBackground();

    // Background scenery layer
    if (this.soilData && scene.textures.exists("terrain_back")) {
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

    // Water — Worms 2 style: deep base + 5 layered translucent waves
    const waterHeight = TERRAIN_HEIGHT - WATER_LEVEL + 100;
    this.waterRect = scene.add.rectangle(
      TERRAIN_WIDTH / 2,
      WATER_LEVEL + waterHeight / 2,
      TERRAIN_WIDTH + 200,
      waterHeight,
      0x1a1a3e,
      0.85,
    );
    this.waterRect.setDepth(2);

    // Animated wave overlay at water surface
    this.waterWave = scene.add.graphics();
    this.waterWave.setDepth(2.5);
    this.drawWave();

    // Animate wave
    this.waveUpdateEvent = scene.time.addEvent({
      delay: 40,
      loop: true,
      callback: () => {
        this.waveTime += 0.06;
        this.drawWave();
      },
    });
  }

  /** Extract pixel data from a Phaser texture using a temporary DOM canvas */
  private extractImageData(key: string): ImageData | null {
    if (!this.scene.textures.exists(key)) {
      console.warn(`[TerrainRenderer] texture "${key}" not found`);
      return null;
    }
    const tex = this.scene.textures.get(key);
    const source = tex.getSourceImage() as HTMLImageElement;
    if (!source || !source.width || !source.height) {
      console.warn(`[TerrainRenderer] texture "${key}" source invalid`);
      return null;
    }
    const w = source.width;
    const h = source.height;
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    const tmpCtx = tmpCanvas.getContext("2d")!;
    tmpCtx.drawImage(source as CanvasImageSource, 0, 0);
    return tmpCtx.getImageData(0, 0, w, h);
  }

  private initForestTextures(): void {
    const soilImgData = this.extractImageData("terrain_soil");
    if (soilImgData) {
      this.soilData = soilImgData;
      this.soilW = soilImgData.width;
      this.soilH = soilImgData.height;
      console.log(`[TerrainRenderer] soil loaded: ${this.soilW}x${this.soilH}`);
    } else {
      console.warn("[TerrainRenderer] soil texture failed to load");
    }

    const grassImgData = this.extractImageData("terrain_grass");
    if (grassImgData) {
      this.grassData = grassImgData;
      this.grassW = grassImgData.width;
      this.grassH = grassImgData.height;
      console.log(
        `[TerrainRenderer] grass loaded: ${this.grassW}x${this.grassH}`,
      );
    }

    const gradImgData = this.extractImageData("terrain_gradient");
    if (gradImgData) {
      this.gradientData = gradImgData;
      this.gradientH = gradImgData.height;
      console.log(`[TerrainRenderer] gradient loaded: h=${this.gradientH}`);
    }
  }

  /**
   * Draw 5 layered translucent waves in the Worms 2 style.
   * Each wave is a filled band that oscillates with sine waves.
   * Layers go from lightest (top) to darkest (bottom), with
   * blue/purple tones matching the classic Worms 2 palette.
   */
  private drawWave(): void {
    this.waterWave.clear();

    const baseY = WATER_LEVEL;
    const startX = -100;
    const endX = TERRAIN_WIDTH + 100;
    const step = 3;
    const bottomY = baseY + 60; // waves extend ~60px below water line

    // 5 wave layers: color, alpha, vertical offset, amplitude, frequency, speed
    const waves = [
      {
        color: 0x6070b0,
        alpha: 0.45,
        yOff: -4,
        amp: 5,
        freq: 0.015,
        speed: 1.2,
        phase: 0,
      },
      {
        color: 0x5060a0,
        alpha: 0.45,
        yOff: 4,
        amp: 4,
        freq: 0.02,
        speed: 0.9,
        phase: 1.5,
      },
      {
        color: 0x405090,
        alpha: 0.5,
        yOff: 12,
        amp: 3.5,
        freq: 0.025,
        speed: 1.4,
        phase: 3.0,
      },
      {
        color: 0x304080,
        alpha: 0.5,
        yOff: 20,
        amp: 3,
        freq: 0.018,
        speed: 0.7,
        phase: 4.5,
      },
      {
        color: 0x253070,
        alpha: 0.55,
        yOff: 28,
        amp: 2.5,
        freq: 0.022,
        speed: 1.0,
        phase: 6.0,
      },
    ];

    for (const wave of waves) {
      this.waterWave.fillStyle(wave.color, wave.alpha);
      this.waterWave.beginPath();

      // Top edge: sine wave
      const firstY =
        baseY +
        wave.yOff +
        Math.sin(startX * wave.freq + this.waveTime * wave.speed + wave.phase) *
          wave.amp +
        Math.sin(startX * wave.freq * 1.7 + this.waveTime * wave.speed * 0.6) *
          wave.amp *
          0.5;
      this.waterWave.moveTo(startX, firstY);

      for (let x = startX + step; x <= endX; x += step) {
        const y =
          baseY +
          wave.yOff +
          Math.sin(x * wave.freq + this.waveTime * wave.speed + wave.phase) *
            wave.amp +
          Math.sin(x * wave.freq * 1.7 + this.waveTime * wave.speed * 0.6) *
            wave.amp *
            0.5;
        this.waterWave.lineTo(x, y);
      }

      // Close the shape along the bottom
      this.waterWave.lineTo(endX, bottomY);
      this.waterWave.lineTo(startX, bottomY);
      this.waterWave.closePath();
      this.waterWave.fillPath();
    }

    // White highlight on the very top wave crest
    this.waterWave.lineStyle(1.5, 0xffffff, 0.3);
    this.waterWave.beginPath();
    const topWave = waves[0];
    for (let x = startX; x <= endX; x += step) {
      const y =
        baseY +
        topWave.yOff -
        1 +
        Math.sin(
          x * topWave.freq + this.waveTime * topWave.speed + topWave.phase,
        ) *
          topWave.amp +
        Math.sin(x * topWave.freq * 1.7 + this.waveTime * topWave.speed * 0.6) *
          topWave.amp *
          0.5;
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

    if (this.soilData) {
      this.renderForestFull();
    } else {
      this.renderFlatFull();
    }
  }

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

  /** Texture-based rendering for forest theme using direct ImageData pixel manipulation */
  private renderForestFull(): void {
    const imgData = this.ctx.createImageData(TERRAIN_WIDTH, TERRAIN_HEIGHT);
    const pixels = imgData.data;
    const soil = this.soilData!.data;
    const sW = this.soilW;
    const sH = this.soilH;

    // Step 1: Fill terrain pixels with tiled soil texture
    for (let y = 0; y < TERRAIN_HEIGHT; y++) {
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        if (!getBitmapPixel(this.bitmap, x, y)) continue;
        const si = ((y % sH) * sW + (x % sW)) * 4;
        const di = (y * TERRAIN_WIDTH + x) * 4;
        pixels[di] = soil[si];
        pixels[di + 1] = soil[si + 1];
        pixels[di + 2] = soil[si + 2];
        pixels[di + 3] = 255;
      }
    }

    // Step 2: Overlay grass at terrain surface edges
    if (this.grassData) {
      const grass = this.grassData.data;
      const gW = this.grassW;
      const gH = this.grassH;

      // First pass: find surface Y for each column
      const surfaceY = new Int32Array(TERRAIN_WIDTH);
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        surfaceY[x] = -1;
        for (let y = 0; y < TERRAIN_HEIGHT; y++) {
          if (getBitmapPixel(this.bitmap, x, y)) {
            surfaceY[x] = y;
            break;
          }
        }
      }

      // Second pass: smooth surface Y to prevent jagged grass placement
      const smoothY = new Int32Array(TERRAIN_WIDTH);
      const smoothRadius = 3;
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        if (surfaceY[x] < 0) {
          smoothY[x] = -1;
          continue;
        }
        let sum = 0;
        let count = 0;
        for (let dx = -smoothRadius; dx <= smoothRadius; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < TERRAIN_WIDTH && surfaceY[nx] >= 0) {
            sum += surfaceY[nx];
            count++;
          }
        }
        smoothY[x] = Math.round(sum / count);
      }

      // Third pass: draw grass using smoothed Y positions
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        const topY = smoothY[x];
        if (topY < 0) continue;

        const gx = x % gW;
        for (let gy = 0; gy < gH; gy++) {
          const drawY = topY - Math.floor(gH / 3) + gy;
          if (drawY < 0 || drawY >= TERRAIN_HEIGHT) continue;

          const gi = (gy * gW + gx) * 4;
          const ga = grass[gi + 3];
          if (ga < 10) continue;

          const di = (drawY * TERRAIN_WIDTH + x) * 4;
          const srcA = ga / 255;
          const dstA = pixels[di + 3] / 255;
          if (dstA === 0) {
            pixels[di] = grass[gi];
            pixels[di + 1] = grass[gi + 1];
            pixels[di + 2] = grass[gi + 2];
            pixels[di + 3] = ga;
          } else {
            pixels[di] = Math.round(grass[gi] * srcA + pixels[di] * (1 - srcA));
            pixels[di + 1] = Math.round(
              grass[gi + 1] * srcA + pixels[di + 1] * (1 - srcA),
            );
            pixels[di + 2] = Math.round(
              grass[gi + 2] * srcA + pixels[di + 2] * (1 - srcA),
            );
            pixels[di + 3] = 255;
          }
        }
      }
    }

    this.ctx.putImageData(imgData, 0, 0);
  }

  private renderRegion(rx: number, ry: number, rw: number, rh: number): void {
    const minX = Math.max(0, rx);
    const minY = Math.max(0, ry);
    const maxX = Math.min(TERRAIN_WIDTH, rx + rw);
    const maxY = Math.min(TERRAIN_HEIGHT, ry + rh);

    this.ctx.clearRect(minX, minY, maxX - minX, maxY - minY);

    if (this.soilData) {
      this.renderForestRegion(minX, minY, maxX, maxY);
    } else {
      this.renderFlatRegion(minX, minY, maxX, maxY);
    }
  }

  private renderFlatRegion(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
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

  private renderForestRegion(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void {
    const regionW = maxX - minX;
    const regionH = maxY - minY;
    const imgData = this.ctx.createImageData(regionW, regionH);
    const pixels = imgData.data;
    const soil = this.soilData!.data;
    const sW = this.soilW;
    const sH = this.soilH;

    // Soil fill
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        if (!getBitmapPixel(this.bitmap, x, y)) continue;
        const si = ((y % sH) * sW + (x % sW)) * 4;
        const di = ((y - minY) * regionW + (x - minX)) * 4;
        pixels[di] = soil[si];
        pixels[di + 1] = soil[si + 1];
        pixels[di + 2] = soil[si + 2];
        pixels[di + 3] = 255;
      }
    }

    // Grass edge
    if (this.grassData) {
      const grass = this.grassData.data;
      const gW = this.grassW;
      const gH = this.grassH;

      for (let x = minX; x < maxX; x++) {
        let topY = -1;
        for (let y = Math.max(0, minY - gH); y < maxY; y++) {
          if (getBitmapPixel(this.bitmap, x, y)) {
            topY = y;
            break;
          }
        }
        if (topY < 0) continue;

        const gx = x % gW;
        for (let gy = 0; gy < gH; gy++) {
          const drawY = topY - Math.floor(gH / 3) + gy;
          if (drawY < minY || drawY >= maxY) continue;

          const gi = (gy * gW + gx) * 4;
          const ga = grass[gi + 3];
          if (ga < 10) continue;

          const di = ((drawY - minY) * regionW + (x - minX)) * 4;
          const srcA = ga / 255;
          const dstA = pixels[di + 3] / 255;
          if (dstA === 0) {
            pixels[di] = grass[gi];
            pixels[di + 1] = grass[gi + 1];
            pixels[di + 2] = grass[gi + 2];
            pixels[di + 3] = ga;
          } else {
            pixels[di] = Math.round(grass[gi] * srcA + pixels[di] * (1 - srcA));
            pixels[di + 1] = Math.round(
              grass[gi + 1] * srcA + pixels[di + 1] * (1 - srcA),
            );
            pixels[di + 2] = Math.round(
              grass[gi + 2] * srcA + pixels[di + 2] * (1 - srcA),
            );
            pixels[di + 3] = 255;
          }
        }
      }
    }

    this.ctx.putImageData(imgData, minX, minY);
  }

  private updateTexture(): void {
    const source = this.texture.getSourceImage() as HTMLCanvasElement;
    const ctx = source.getContext("2d")!;
    ctx.clearRect(0, 0, TERRAIN_WIDTH, TERRAIN_HEIGHT);
    ctx.drawImage(this.canvas, 0, 0);
    this.texture.refresh();
  }

  private drawBackground(): void {
    if (this.gradientData) {
      this.drawGradientBackground();
    } else {
      this.drawFlatBackground();
    }
  }

  /** Use gradient.png pixel data to draw a smooth vertical gradient sky */
  private drawGradientBackground(): void {
    const grad = this.gradientData!.data;
    const gradH = this.gradientH;
    const gradW = this.gradientData!.width;

    const totalH = TERRAIN_HEIGHT + 400;
    for (let screenY = 0; screenY < totalH; screenY++) {
      const drawY = screenY - 200;
      const gy = Math.min(
        gradH - 1,
        Math.max(0, Math.floor((screenY / totalH) * gradH)),
      );
      const gi = gy * gradW * 4;
      const r = grad[gi];
      const g = grad[gi + 1];
      const b = grad[gi + 2];
      const color = (r << 16) | (g << 8) | b;

      this.background.fillStyle(color, 1);
      this.background.fillRect(-200, drawY, TERRAIN_WIDTH + 400, 1);
    }
  }

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
