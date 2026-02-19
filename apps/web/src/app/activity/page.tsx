"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { setupDiscordSdk, type DiscordUser } from "@/lib/discord";
import type { DiscordSDK } from "@discord/embedded-app-sdk";
import type { GameInitPayload, TeamColor } from "@worms/shared";
import {
  DEFAULT_HP,
  DEFAULT_WORMS_PER_TEAM,
  DEFAULT_TURN_TIME,
} from "@worms/shared";

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

const TEAM_COLORS: TeamColor[] = ["red", "blue", "green", "yellow"];
const COLOR_HEX: Record<TeamColor, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
};

interface Player {
  id: string;
  displayName: string;
  avatarUrl: string;
  teamColor: TeamColor;
}

type Phase = "loading" | "waiting" | "playing";

export default function ActivityPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState("Connecting to Discord...");
  const [error, setError] = useState<string | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [localUser, setLocalUser] = useState<DiscordUser | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [wormNames, setWormNames] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem("wormNames");
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [showTeamSettings, setShowTeamSettings] = useState(false);
  const sdkRef = useRef<DiscordSDK | null>(null);
  const initRef = useRef(false);

  // In Discord Activity mode, always use the production PartyKit host
  // (patchUrlMappings will remap it through Discord's proxy)
  const partyHost = "worms-party.minilux.partykit.dev";

  // Initialize Discord SDK and get participants
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    (async () => {
      try {
        setStatus("Authenticating with Discord...");
        const { sdk, user } = await setupDiscordSdk();
        sdkRef.current = sdk;
        setLocalUser(user);

        setStatus("Getting participants...");

        // Use the Activity instance ID as the game room code
        const roomId = sdk.instanceId;
        setGameId(roomId);

        // Get current participants in the Activity
        const { participants } =
          await sdk.commands.getInstanceConnectedParticipants();

        // Build player list from participants (up to 4)
        const playerList: Player[] = participants.slice(0, 4).map((p, i) => {
          const avatarHash = p.avatar;
          const avatarUrl = avatarHash
            ? `https://cdn.discordapp.com/avatars/${p.id}/${avatarHash}.png?size=128`
            : `https://cdn.discordapp.com/embed/avatars/${Number(p.id) % 6}.png`;

          return {
            id: p.id,
            displayName: p.global_name ?? p.username ?? "Player",
            avatarUrl,
            teamColor: TEAM_COLORS[i % TEAM_COLORS.length],
          };
        });

        setPlayers(playerList);
        setPhase("waiting");

        // Listen for participants joining/leaving
        sdk.subscribe(
          "ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE",
          (event: {
            participants: Array<{
              id: string;
              username: string;
              global_name?: string | null;
              avatar?: string | null;
            }>;
          }) => {
            const updated: Player[] = event.participants
              .slice(0, 4)
              .map((p, i) => {
                const avatarHash = p.avatar;
                const avatarUrl = avatarHash
                  ? `https://cdn.discordapp.com/avatars/${p.id}/${avatarHash}.png?size=128`
                  : `https://cdn.discordapp.com/embed/avatars/${Number(p.id) % 6}.png`;

                return {
                  id: p.id,
                  displayName: p.global_name ?? p.username ?? "Player",
                  avatarUrl,
                  teamColor: TEAM_COLORS[i % TEAM_COLORS.length],
                };
              });
            setPlayers(updated);
          },
        );
      } catch (err) {
        console.error("Discord SDK setup failed:", err);
        setError(
          err instanceof Error ? err.message : "Failed to connect to Discord",
        );
      }
    })();
  }, []);

  const updateWormName = useCallback((index: number, name: string) => {
    setWormNames((prev) => {
      const next = [...prev];
      while (next.length < DEFAULT_WORMS_PER_TEAM) next.push("");
      next[index] = name;
      localStorage.setItem("wormNames", JSON.stringify(next));
      return next;
    });
  }, []);

  // Start the game — build the init payload and transition to game phase
  const startGame = useCallback(() => {
    if (!localUser || !gameId || players.length < 1) return;

    // Build the player list for the init payload
    // Only the local user gets custom worm names
    const gamePlayers = players.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl,
      teamColor: p.teamColor,
      wormNames: p.id === localUser.playerId ? wormNames : undefined,
    }));

    // Add CPU opponent for solo play (same as lobby server does)
    if (gamePlayers.length === 1) {
      const usedColors = gamePlayers.map((p) => p.teamColor);
      const cpuColor =
        TEAM_COLORS.find((c) => !usedColors.includes(c)) ?? "blue";
      gamePlayers.push({
        id: "cpu-0",
        displayName: "CPU",
        avatarUrl: "",
        teamColor: cpuColor,
        wormNames: ["Prézidan", "Maitre clébard", "Testoludo", "Agagougou"],
      });
    }

    const payload: GameInitPayload = {
      players: gamePlayers,
      config: {
        wormsPerTeam: DEFAULT_WORMS_PER_TEAM,
        hp: DEFAULT_HP,
        turnTime: DEFAULT_TURN_TIME,
        terrainTheme: "forest",
      },
    };

    // Store in sessionStorage so GameScene can send it via INIT_GAME
    sessionStorage.setItem("gameInitPayload", JSON.stringify(payload));
    setPhase("playing");
  }, [localUser, gameId, players, wormNames]);

  // Determine if current user is "host" (first in participant list)
  const isHost =
    localUser && players.length > 0 && players[0].id === localUser.playerId;

  // ─── Render ──────────────────────────────────────────────

  if (error) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-red-400 text-lg font-bold">Error</p>
          <p className="text-gray-400 text-sm max-w-md">{error}</p>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <p className="text-amber-400 text-lg font-bold animate-pulse">
          {status}
        </p>
      </div>
    );
  }

  if (phase === "playing" && gameId && localUser) {
    return (
      <div className="w-screen h-screen overflow-hidden bg-black">
        <PhaserGame
          gameId={gameId}
          playerId={localUser.playerId}
          partyHost={partyHost}
        />
      </div>
    );
  }

  // Waiting room
  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center">
      <div className="max-w-md w-full space-y-6 p-6">
        <h1 className="text-2xl font-bold text-amber-400 text-center">
          Worms: Le Parking
        </h1>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Players ({players.length}/4)
          </h2>
          {players.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 py-2 px-3 rounded-lg bg-gray-800/50"
            >
              {p.avatarUrl && (
                <img
                  src={p.avatarUrl}
                  alt=""
                  className="w-8 h-8 rounded-full"
                />
              )}
              <span
                className="font-medium"
                style={{ color: COLOR_HEX[p.teamColor] }}
              >
                {p.displayName}
              </span>
              {p.id === localUser?.playerId && (
                <span className="text-xs text-gray-500 ml-auto">(you)</span>
              )}
            </div>
          ))}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <button
            onClick={() => setShowTeamSettings(!showTeamSettings)}
            className="flex items-center justify-between w-full text-sm font-semibold text-gray-400 uppercase tracking-wider"
          >
            <span>Team Settings</span>
            <span className="text-xs">{showTeamSettings ? "▲" : "▼"}</span>
          </button>
          {showTeamSettings && (
            <div className="space-y-2 pt-3">
              <p className="text-xs text-gray-500">
                Name your worms (saved for future games)
              </p>
              {Array.from({ length: DEFAULT_WORMS_PER_TEAM }).map((_, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-6 text-right">
                    {i + 1}.
                  </span>
                  <input
                    type="text"
                    value={wormNames[i] ?? ""}
                    onChange={(e) => updateWormName(i, e.target.value)}
                    placeholder={`Worm ${i + 1}`}
                    maxLength={20}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-gray-500"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {isHost ? (
          <button
            onClick={startGame}
            disabled={players.length < 1}
            className="w-full bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-bold py-3 px-6 rounded-lg text-lg transition-colors"
          >
            {players.length < 2 ? "Start Solo (vs CPU)" : "Start Game"}
          </button>
        ) : (
          <p className="text-center text-gray-500 text-sm">
            Waiting for host to start the game...
          </p>
        )}
      </div>
    </div>
  );
}
