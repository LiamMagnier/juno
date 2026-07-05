import NextAuth, { type NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { env, isGoogleConfigured } from "@/lib/env";
import { encryptAccountTokens, decryptAccountTokens } from "@/lib/crypto";
import { hashPassword, verifyPassword } from "@/lib/password";
import { rateLimit, ipFromHeaders } from "@/lib/rate-limit";

/**
 * PrismaAdapter that encrypts OAuth tokens before they touch the `Account`
 * table. Only `linkAccount` writes tokens (once, at first sign-in — JWT
 * sessions never refresh them), so wrapping it is sufficient to keep
 * access_token / refresh_token / id_token encrypted at rest.
 */
function EncryptedPrismaAdapter(client: typeof prismaUnguarded): Adapter {
  const base = PrismaAdapter(client);
  return {
    ...base,
    linkAccount: (account) => base.linkAccount!(encryptAccountTokens(account) as AdapterAccount),
    // Symmetric read path (WebAuthn flows call getAccount): decrypt the tokens
    // back before handing the account to callers, so nothing downstream ever
    // sees ciphertext where it expects a usable OAuth token.
    getAccount: base.getAccount
      ? async (providerAccountId, provider) => {
          const account = await base.getAccount!(providerAccountId, provider);
          return account ? (decryptAccountTokens(account) as AdapterAccount) : account;
        }
      : undefined,
  };
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

// Brute-force limits on the credentials sign-in: per-account (lowercased email)
// plus a wider per-IP net so one attacker can't spray many accounts. Every
// failure path returns `null` — next-auth then yields the same generic
// CredentialsSignin error whether the account exists, the password is wrong,
// or the caller is throttled, so nothing leaks about account existence.
const SIGNIN_WINDOW_SEC = 15 * 60;
const SIGNIN_MAX_PER_EMAIL = 10;
const SIGNIN_MAX_PER_IP = 30;

const providers: NextAuthConfig["providers"] = [
  Credentials({
    name: "Email",
    credentials: { email: {}, password: {} },
    authorize: async (raw, request) => {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) return null;
      const email = parsed.data.email.toLowerCase();

      const ip = request?.headers ? ipFromHeaders(new Headers(request.headers)) : "unknown";
      const checks = [rateLimit({ key: `signin:email:${email}`, limit: SIGNIN_MAX_PER_EMAIL, windowSec: SIGNIN_WINDOW_SEC })];
      // Skip the IP bucket when no proxy header exists (plain local dev) —
      // otherwise every client would share one "unknown" bucket.
      if (ip !== "unknown") {
        checks.push(rateLimit({ key: `signin:ip:${ip}`, limit: SIGNIN_MAX_PER_IP, windowSec: SIGNIN_WINDOW_SEC }));
      }
      const results = await Promise.all(checks);
      if (results.some((r) => !r.success)) return null;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user?.hashedPassword) return null;
      const { ok, needsUpgrade } = await verifyPassword(parsed.data.password, user.hashedPassword);
      if (!ok) return null;
      // Suspended accounts cannot sign in. Returning null gives the same generic
      // failure as a bad password (no account-status oracle).
      if (user.bannedAt) return null;
      // Migrate a legacy (pre-72-byte-safe) hash to the current scheme now that
      // we hold the plaintext. Best-effort: a failure here must not block login.
      if (needsUpgrade) {
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { hashedPassword: await hashPassword(parsed.data.password) },
          });
        } catch {
          /* re-upgrades on the next sign-in */
        }
      }
      return { id: user.id, email: user.email, name: user.name, image: user.image };
    },
  }),
];

if (isGoogleConfigured()) {
  providers.push(
    Google({
      clientId: env.googleClientId!,
      clientSecret: env.googleClientSecret!,
      // NOT auto-linking by email: credential emails are unverified, so linking
      // a Google identity to a pre-existing same-email account would allow takeover.
    })
  );
}

export const authConfig: NextAuthConfig = {
  // The adapter queries auth models by its own unique keys (email,
  // provider+providerAccountId), so it gets the raw client. Wrapped so OAuth
  // tokens are encrypted before they land in the Account table.
  adapter: EncryptedPrismaAdapter(prismaUnguarded),
  session: { strategy: "jwt" },
  pages: { signIn: "/sign-in" },
  trustHost: true,
  cookies: process.env.COOKIE_DOMAIN
    ? {
        sessionToken: {
          name: process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token",
          options: {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            secure: process.env.NODE_ENV === "production",
            domain: process.env.COOKIE_DOMAIN,
          },
        },
      }
    : undefined,
  providers,
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token.uid && session.user) {
        session.user.id = token.uid as string;
        // JWTs embed name/image at sign-in, so a later avatar (or name) change
        // wouldn't appear until the next sign-in. Refresh both from the DB on
        // each session read so every device stays current without re-login.
        try {
          const u = await prisma.user.findUnique({
            where: { id: token.uid as string },
            select: { image: true, name: true },
          });
          if (u) {
            session.user.image = u.image ?? null;
            if (u.name) session.user.name = u.name;
          }
        } catch {
          // Keep the token's values on a transient DB hiccup.
        }
      }
      return session;
    },
  },
  events: {
    // Fires when the adapter creates a user (OAuth sign-up). Seed defaults.
    async createUser({ user }) {
      if (!user.id) return;
      await ensureUserDefaults(user.id);
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/** Create the Settings + Subscription rows a user needs, idempotently. */
export async function ensureUserDefaults(userId: string) {
  await prisma.$transaction([
    prisma.settings.upsert({
      where: { userId },
      create: { userId },
      update: {},
    }),
    prisma.subscription.upsert({
      where: { userId },
      create: { userId },
      update: {},
    }),
  ]);
}
