"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

const ActivityPage = dynamic(() => import("@/app/activity/page"), {
  ssr: false,
  loading: () => (
    <div className="w-screen h-screen bg-black flex items-center justify-center">
      <p className="text-amber-400 text-lg font-bold animate-pulse">
        Loading...
      </p>
    </div>
  ),
});

/**
 * Detects if the app is running inside a Discord Activity iframe.
 * If yes, renders the Activity page instead of the normal content.
 * If no, renders children (the normal landing page).
 */
export function DiscordActivityGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isDiscord, setIsDiscord] = useState<boolean | null>(null);

  useEffect(() => {
    // Discord Activities pass frame_id, instance_id, and platform as URL search params
    const params = new URLSearchParams(window.location.search);
    const hasDiscordParams =
      params.has("frame_id") &&
      params.has("instance_id") &&
      params.has("platform");

    setIsDiscord(hasDiscordParams);
  }, []);

  // Still detecting — show nothing to avoid flash
  if (isDiscord === null) {
    return null;
  }

  // Inside Discord — render the Activity page
  if (isDiscord) {
    return <ActivityPage />;
  }

  // Normal web — render the landing page
  return <>{children}</>;
}
