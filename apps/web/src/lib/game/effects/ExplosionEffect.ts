import * as Phaser from "phaser";

export function createExplosion(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
): void {
  // Prefer the Worms 2-style fire explosion (exfoom), fall back to circle sprites
  const hasExfoom = scene.textures.exists("fx_exfoom");

  if (hasExfoom) {
    const animKey = "explode_foom";
    if (!scene.anims.exists(animKey)) {
      scene.anims.create({
        key: animKey,
        frames: scene.anims.generateFrameNumbers("fx_exfoom", {
          start: 0,
          end: 19,
        }),
        frameRate: 24,
        repeat: 0,
      });
    }

    const explosion = scene.add.sprite(x, y, "fx_exfoom", 0);
    explosion.setDepth(15);
    const scale = (radius * 2) / 100;
    explosion.setScale(scale);
    explosion.play(animKey);
    explosion.once("animationcomplete", () => explosion.destroy());
  } else {
    // Fallback: geometric shapes
    const flash = scene.add.circle(x, y, radius, 0xffffff, 0.9);
    flash.setDepth(15);
    scene.tweens.add({
      targets: flash,
      alpha: 0,
      scaleX: 1.3,
      scaleY: 1.3,
      duration: 250,
      onComplete: () => flash.destroy(),
    });

    const fire = scene.add.circle(x, y, radius * 0.6, 0xff6600, 0.8);
    fire.setDepth(14);
    scene.tweens.add({
      targets: fire,
      alpha: 0,
      scaleX: 1.8,
      scaleY: 1.8,
      duration: 400,
      onComplete: () => fire.destroy(),
    });
  }

  // Smoke puff (sprite or fallback)
  const hasSmokeSprite = scene.textures.exists("fx_smoke");
  if (hasSmokeSprite) {
    const smokeAnimKey = "smoke_puff";
    if (!scene.anims.exists(smokeAnimKey)) {
      scene.anims.create({
        key: smokeAnimKey,
        frames: scene.anims.generateFrameNumbers("fx_smoke", {
          start: 0,
          end: 27,
        }),
        frameRate: 20,
        repeat: 0,
      });
    }
    const smoke = scene.add.sprite(x, y - 10, "fx_smoke", 0);
    smoke.setDepth(13);
    smoke.setAlpha(0.6);
    smoke.play(smokeAnimKey);
    smoke.once("animationcomplete", () => smoke.destroy());
  } else {
    const smoke = scene.add.circle(x, y, radius * 0.4, 0x888888, 0.5);
    smoke.setDepth(13);
    scene.tweens.add({
      targets: smoke,
      alpha: 0,
      scaleX: 2.5,
      scaleY: 2.5,
      y: y - 20,
      duration: 600,
      onComplete: () => smoke.destroy(),
    });
  }

  // Camera shake
  const intensity = Math.min(0.02, radius * 0.0003);
  scene.cameras.main.shake(200, intensity);
}
