import { DiscordSDK, patchUrlMappings } from "@discord/embedded-app-sdk";

const DISCORD_CLIENT_ID = process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID ?? "";

// Singleton SDK instance — only created when running inside Discord
let discordSdk: DiscordSDK | null = null;

export function getDiscordSdk(): DiscordSDK | null {
  return discordSdk;
}

/** Check if the app is running inside a Discord Activity iframe */
export function isDiscordActivity(): boolean {
  if (typeof window === "undefined") return false;
  // Discord Activities embed via iframe and set specific URL search params
  // The SDK also checks for the presence of the parent frame
  try {
    return (
      window.self !== window.top &&
      new URLSearchParams(window.location.search).has("frame_id")
    );
  } catch {
    // Cross-origin iframe check can throw — if it does, we're likely in an iframe
    return true;
  }
}

export interface DiscordUser {
  playerId: string;
  displayName: string;
  avatarUrl: string;
}

/**
 * Initialize the Discord SDK, authenticate the user, and patch URL mappings.
 * Must be called before any PartySocket connections in Activity mode.
 */
export async function setupDiscordSdk(): Promise<{
  sdk: DiscordSDK;
  user: DiscordUser;
}> {
  if (!DISCORD_CLIENT_ID) {
    throw new Error("NEXT_PUBLIC_DISCORD_CLIENT_ID is not set");
  }

  discordSdk = new DiscordSDK(DISCORD_CLIENT_ID);

  // Wait for the SDK handshake with Discord client
  await discordSdk.ready();

  // Authorize — get a one-time code
  const { code } = await discordSdk.commands.authorize({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });

  // Exchange code for access_token on our server (keeps client_secret safe)
  const tokenRes = await fetch("/api/discord/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (!tokenRes.ok) {
    throw new Error("Failed to exchange Discord auth code for token");
  }

  const { access_token } = (await tokenRes.json()) as {
    access_token: string;
  };

  // Authenticate with Discord using the access token
  const authResult = await discordSdk.commands.authenticate({
    access_token,
  });

  const discordUser = authResult.user;
  const avatarHash = discordUser.avatar;
  const avatarUrl = avatarHash
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${avatarHash}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(discordUser.id) % 6}.png`;

  // Patch global fetch/WebSocket/XHR so they route through Discord's proxy
  const partyKitHost =
    process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "worms-party.minilux.partykit.dev";

  patchUrlMappings(
    [
      {
        prefix: "/partykit",
        target: `https://${partyKitHost}`,
      },
    ],
    {
      patchFetch: true,
      patchWebSocket: true,
      patchXhr: true,
    },
  );

  return {
    sdk: discordSdk,
    user: {
      playerId: discordUser.id,
      displayName: discordUser.global_name ?? discordUser.username ?? "Player",
      avatarUrl,
    },
  };
}
