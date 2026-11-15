import { redirect } from "next/navigation";

/**
 * /pricing is the address people type and share; the plans live on the home
 * page (`#pricing`, landing/pricing.tsx), where the nav's Pricing link points.
 * It answered 404 ("This page isn't here"). A temporary redirect, not a
 * permanent one, so a pricing page of its own can take the address later
 * without browsers holding on to this.
 */
export default function PricingPage(): never {
  redirect("/#pricing");
}
