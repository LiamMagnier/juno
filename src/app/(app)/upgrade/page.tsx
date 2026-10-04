"use client";

import { useApp } from "@/components/app/app-provider";
import { UpgradeView } from "@/components/billing/upgrade-view";

export default function UpgradePage() {
  const { quota, features } = useApp();
  return <UpgradeView currentPlan={quota.plan} features={features} />;
}
