import * as Phaser from "phaser";

export function createExplosion(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
): void {
  // Flash circle
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

  // Orange fire ring
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

  // Smoke puff
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

  // Camera shake
  const intensity = Math.min(0.02, radius * 0.0003);
  scene.cameras.main.shake(200, intensity);
}
