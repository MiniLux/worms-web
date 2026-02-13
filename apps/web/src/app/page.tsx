import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { LoginButton } from "@/components/LoginButton";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center space-y-4">
        <h1 className="text-5xl font-bold tracking-tight text-amber-400">
          Worms Web
        </h1>
        <p className="text-lg text-gray-400 max-w-md">
          A Worms 2: Armageddon clone — destructible terrain, explosive weapons,
          turn-based multiplayer mayhem in your browser.
        </p>
      </div>
      <LoginButton />
    </main>
  );
}
