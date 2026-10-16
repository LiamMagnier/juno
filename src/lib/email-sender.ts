import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * The From header. The configured address is used as written, except that a
 * sender display name still set to the codename (an `EMAIL_FROM` written
 * before the rename) is shown as the product's name: the inbox is the one
 * place every user reads it. The address itself is never touched (G44).
 *
 * Its own module, free of `server-only`, so the rule is testable without the
 * mailer.
 */
export function senderAddress(configured: string | undefined): string {
  if (!configured) return `${PRODUCT_NAME} <hello@chat.liams.dev>`;
  return configured.replace(/^\s*(["']?)Juno\1(\s*<)/, `${PRODUCT_NAME}$2`);
}
