"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function ReconnectAction() {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return <div className="flex flex-col items-center gap-4">
    {online !== null && <p role="status" className="text-ui text-muted-foreground">{online ? "Your device is connected. You can try again." : "Your device is still offline."}</p>}
    <Button asChild><Link href="/chat">Try again</Link></Button>
  </div>;
}
