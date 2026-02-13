"use client";

import { createClient } from "@/lib/supabase/client";

export function LoginButton() {
  const handleLogin = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <button
      onClick={handleLogin}
      className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-3 px-8 rounded-lg text-lg transition-colors"
    >
      Sign in with Discord
    </button>
  );
}
