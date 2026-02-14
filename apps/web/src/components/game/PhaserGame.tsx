"use client";

import { useEffect, useRef } from "react";
import * as Phaser from "phaser";
import { GameScene } from "@/lib/game/scenes/GameScene";
import { HUDScene } from "@/lib/game/scenes/HUDScene";

interface Props {
  gameId: string;
  playerId: string;
  partyHost: string;
}

export default function PhaserGame({ gameId, playerId, partyHost }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: "#1a1a2e",
      scene: [GameScene, HUDScene],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      input: {
        keyboard: true,
        mouse: true,
      },
      fps: {
        target: 30,
        forceSetTimeOut: true,
      },
      render: {
        pixelArt: true,
        antialias: false,
      },
    };

    const game = new Phaser.Game(config);
    gameRef.current = game;

    // Pass data to scenes via registry
    game.registry.set("gameId", gameId);
    game.registry.set("playerId", playerId);
    game.registry.set("partyHost", partyHost);

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, [gameId, playerId, partyHost]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ cursor: "crosshair" }}
    />
  );
}
