import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { GameLoader } from "@/components/game/GameLoader";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function GamePage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  return (
    <div className="w-screen h-screen overflow-hidden bg-black">
      <GameLoader
        gameId={id}
        playerId={user.id}
        partyHost={process.env.NEXT_PUBLIC_PARTYKIT_HOST!}
      />
    </div>
  );
}
