import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Image from "next/image";
import { LoginButton } from "@/components/LoginButton";

export default async function Home() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      redirect("/dashboard");
    }
  } catch {
    // Supabase not configured yet — show landing page anyway
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <Image
        src="/logo.png"
        alt="Worms: Le Parking"
        width={600}
        height={186}
        priority
      />
      <LoginButton />
    </main>
  );
}
