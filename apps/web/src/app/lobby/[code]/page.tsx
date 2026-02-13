import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { LobbyRoom } from "@/components/lobby/LobbyRoom";

interface Props {
  params: Promise<{ code: string }>;
}

export default async function LobbyPage({ params }: Props) {
  const { code } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  const displayName =
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    "Player";
  const avatarUrl = user.user_metadata?.avatar_url ?? "";

  return (
    <LobbyRoom
      code={code.toUpperCase()}
      playerId={user.id}
      displayName={displayName}
      avatarUrl={avatarUrl}
      partyHost={process.env.NEXT_PUBLIC_PARTYKIT_HOST!}
    />
  );
}
