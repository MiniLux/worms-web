"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function JoinLobbyForm() {
  const router = useRouter();
  const [code, setCode] = useState("");

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length === 6) {
      router.push(`/lobby/${trimmed}`);
    }
  };

  return (
    <form onSubmit={handleJoin} className="flex gap-3">
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="ABCD12"
        maxLength={6}
        className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm uppercase tracking-widest font-mono flex-1 focus:outline-none focus:border-amber-500"
      />
      <button
        type="submit"
        disabled={code.trim().length !== 6}
        className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-bold px-6 py-3 rounded-lg transition-colors"
      >
        Join
      </button>
    </form>
  );
}
