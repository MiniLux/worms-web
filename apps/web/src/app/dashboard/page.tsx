import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { CreateLobbyButton } from "@/components/lobby/CreateLobbyButton";
import { JoinLobbyForm } from "@/components/lobby/JoinLobbyForm";
import { LogoutButton } from "@/components/LogoutButton";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  const displayName =
    user.user_metadata?.full_name ??
    user.user_metadata?.name ??
    user.email ??
    "Player";
  const avatarUrl = user.user_metadata?.avatar_url ?? "";

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-amber-400">Worms Web</h1>
          <div className="flex items-center gap-4">
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt=""
                className="w-8 h-8 rounded-full"
              />
            )}
            <span className="text-sm text-gray-400">{displayName}</span>
            <LogoutButton />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <h2 className="text-lg font-semibold">Create Game</h2>
            <p className="text-sm text-gray-400">
              Start a new lobby and invite friends with a code.
            </p>
            <CreateLobbyButton />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
            <h2 className="text-lg font-semibold">Join Game</h2>
            <p className="text-sm text-gray-400">
              Enter a 6-character lobby code to join.
            </p>
            <JoinLobbyForm />
          </div>
        </div>
      </div>
    </main>
  );
}
