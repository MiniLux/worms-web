"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function CreateLobbyButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleCreate = () => {
    setLoading(true);
    const code = generateCode();
    router.push(`/lobby/${code}`);
  };

  return (
    <button
      onClick={handleCreate}
      disabled={loading}
      className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-bold py-3 px-6 rounded-lg transition-colors"
    >
      {loading ? "Creating..." : "Create Lobby"}
    </button>
  );
}
