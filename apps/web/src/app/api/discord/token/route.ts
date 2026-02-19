import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const { code } = (await request.json()) as { code: string };

  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  const clientId = process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "Discord credentials not configured" },
      { status: 500 },
    );
  }

  // Exchange the authorization code for an access token with Discord
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
    }),
  });

  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    console.error("Discord token exchange failed:", errorText);
    return NextResponse.json(
      { error: "Token exchange failed" },
      { status: 502 },
    );
  }

  const tokenData = (await tokenRes.json()) as { access_token: string };

  return NextResponse.json({ access_token: tokenData.access_token });
}
