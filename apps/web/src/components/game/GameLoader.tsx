"use client";

import dynamic from "next/dynamic";

const PhaserGame = dynamic(() => import("@/components/game/PhaserGame"), {
  ssr: false,
  loading: () => (
    <div className="w-screen h-screen bg-black flex items-center justify-center">
      <p className="text-amber-400 text-lg font-bold animate-pulse">
        Loading game...
      </p>
    </div>
  ),
});

interface Props {
  gameId: string;
  playerId: string;
  partyHost: string;
}

export function GameLoader({ gameId, playerId, partyHost }: Props) {
  return (
    <PhaserGame gameId={gameId} playerId={playerId} partyHost={partyHost} />
  );
}
