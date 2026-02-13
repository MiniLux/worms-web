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
};

export class TerrainRenderer {
  private bitmap: Uint8Array;
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private texture: Phaser.Textures.CanvasTexture;
  private image: Phaser.GameObjects.Image;
  private waterRect: Phaser.GameObjects.Rectangle;
  private background: Phaser.GameObjects.Graphics;
  private theme: TerrainTheme;

  constructor(
    private scene: Phaser.Scene,
    terrainData: TerrainData,
  ) {
    this.theme = terrainData.theme;
    this.bitmap = decodeBitmap(terrainData.bitmap);

    // Background
    this.background = scene.add.graphics();
    this.background.setDepth(0);
    this.drawBackground();

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
    const colors = THEME_COLORS[this.theme];
    this.ctx.clearRect(0, 0, TERRAIN_WIDTH, TERRAIN_HEIGHT);

    // Draw terrain fill
    this.ctx.fillStyle = colors.fill;
    for (let y = 0; y < TERRAIN_HEIGHT; y++) {
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        if (getBitmapPixel(this.bitmap, x, y)) {
          this.ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // Draw edge (pixels that are solid with air above)
    this.ctx.fillStyle = colors.edge;
    const edgeThickness = 3;
    for (let y = 0; y < TERRAIN_HEIGHT; y++) {
      for (let x = 0; x < TERRAIN_WIDTH; x++) {
        if (!getBitmapPixel(this.bitmap, x, y)) continue;
        // Check if any neighbor within edgeThickness is air
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

  private renderRegion(rx: number, ry: number, rw: number, rh: number): void {
    const colors = THEME_COLORS[this.theme];
    const minX = Math.max(0, rx);
    const minY = Math.max(0, ry);
    const maxX = Math.min(TERRAIN_WIDTH, rx + rw);
    const maxY = Math.min(TERRAIN_HEIGHT, ry + rh);

    this.ctx.clearRect(minX, minY, maxX - minX, maxY - minY);

    // Fill
    this.ctx.fillStyle = colors.fill;
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        if (getBitmapPixel(this.bitmap, x, y)) {
          this.ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // Edge
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

  private updateTexture(): void {
    const source = this.texture.getSourceImage() as HTMLCanvasElement;
    const ctx = source.getContext("2d")!;
    ctx.clearRect(0, 0, TERRAIN_WIDTH, TERRAIN_HEIGHT);
    ctx.drawImage(this.canvas, 0, 0);
    this.texture.refresh();
  }

  private drawBackground(): void {
    const colors = THEME_COLORS[this.theme];
    const c1 = parseInt(colors.sky[0].replace("#", ""), 16);
    const c2 = parseInt(colors.sky[1].replace("#", ""), 16);

    // Simple two-tone sky
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
    this.background.destroy();
    if (this.scene.textures.exists("terrain")) {
      this.scene.textures.remove("terrain");
    }
  }
}
