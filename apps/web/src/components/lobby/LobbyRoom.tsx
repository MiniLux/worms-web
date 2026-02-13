"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PartySocket from "partysocket";
import type {
  LobbyState,
  LobbyClientMessage,
  LobbyServerMessage,
} from "@worms/shared";

interface Props {
  code: string;
  playerId: string;
  displayName: string;
  avatarUrl: string;
  partyHost: string;
}

export function LobbyRoom({
  code,
  playerId,
  displayName,
  avatarUrl,
  partyHost,
}: Props) {
  const router = useRouter();
  const socketRef = useRef<PartySocket | null>(null);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const socket = new PartySocket({
      host: partyHost,
      room: code,
      party: "lobby",
    });
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      const msg: LobbyClientMessage = {
        type: "JOIN_LOBBY",
        playerId,
        displayName,
        avatarUrl,
      };
      socket.send(JSON.stringify(msg));
    });

    socket.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as LobbyServerMessage;
      switch (msg.type) {
        case "LOBBY_STATE":
          setLobby(msg.state);
          break;
        case "PLAYER_JOINED":
          setLobby((prev) =>
            prev
              ? {
                  ...prev,
                  players: [
                    ...prev.players.filter((p) => p.id !== msg.player.id),
                    msg.player,
                  ],
                }
              : prev
          );
          break;
        case "PLAYER_LEFT":
          setLobby((prev) =>
            prev
              ? {
                  ...prev,
                  players: prev.players.filter((p) => p.id !== msg.playerId),
                }
              : prev
          );
          break;
        case "PLAYER_UPDATED":
          setLobby((prev) =>
            prev
              ? {
                  ...prev,
                  players: prev.players.map((p) =>
                    p.id === msg.player.id ? msg.player : p
                  ),
                }
              : prev
          );
          break;
        case "CONFIG_UPDATED":
          setLobby((prev) => (prev ? { ...prev, config: msg.config } : prev));
          break;
        case "GAME_STARTING":
          router.push(`/game/${msg.gameId}`);
          break;
        case "ERROR":
          setError(msg.message);
          setTimeout(() => setError(null), 3000);
          break;
      }
    });

    return () => {
      socket.close();
    };
  }, [code, playerId, displayName, avatarUrl, partyHost, router]);

  const send = (msg: LobbyClientMessage) => {
    socketRef.current?.send(JSON.stringify(msg));
  };

  const myPlayer = lobby?.players.find((p) => p.id === playerId);
  const isHost = lobby?.hostId === playerId;
  const allReady =
    lobby &&
    lobby.players.length >= 2 &&
    lobby.players.every((p) => p.isReady);

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const TEAM_COLOR_MAP: Record<string, string> = {
    red: "#ef4444",
    blue: "#3b82f6",
    green: "#22c55e",
    yellow: "#eab308",
  };

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-amber-400">Lobby</h1>
          <button
            onClick={copyCode}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 px-5 py-2 rounded-lg font-mono text-lg tracking-widest transition-colors"
          >
            {copied ? "Copied!" : code}
          </button>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Players */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Players
          </h2>
          {lobby?.players.map((player) => (
            <div
              key={player.id}
              className="flex items-center gap-3 py-2 px-3 rounded-lg bg-gray-800/50"
            >
              <div
                className="w-3 h-3 rounded-full"
                style={{
                  backgroundColor:
                    TEAM_COLOR_MAP[player.teamColor] ?? "#888",
                }}
              />
              {player.avatarUrl && (
                <img
                  src={player.avatarUrl}
                  alt=""
                  className="w-7 h-7 rounded-full"
                />
              )}
              <span className="flex-1 text-sm font-medium">
                {player.displayName}
                {player.isHost && (
                  <span className="ml-2 text-xs text-amber-400">(Host)</span>
                )}
              </span>
              <span
                className={`text-xs font-medium ${
                  player.isReady ? "text-green-400" : "text-gray-500"
                }`}
              >
                {player.isReady ? "Ready" : "Not ready"}
              </span>
            </div>
          ))}
          {(!lobby || lobby.players.length < 2) && (
            <p className="text-gray-500 text-sm text-center py-3">
              Waiting for more players...
            </p>
          )}
        </div>

        {/* Controls */}
        <div className="flex gap-3">
          <button
            onClick={() =>
              send({ type: "SET_READY", ready: !myPlayer?.isReady })
            }
            className={`flex-1 py-3 rounded-lg font-bold transition-colors ${
              myPlayer?.isReady
                ? "bg-gray-700 hover:bg-gray-600 text-gray-300"
                : "bg-green-600 hover:bg-green-500 text-white"
            }`}
          >
            {myPlayer?.isReady ? "Unready" : "Ready"}
          </button>
          {isHost && (
            <button
              onClick={() => send({ type: "START_GAME" })}
              disabled={!allReady}
              className="flex-1 py-3 rounded-lg font-bold bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              Start Game
            </button>
          )}
        </div>

        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          Back to Dashboard
        </button>
      </div>
    </main>
  );
}
