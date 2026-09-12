import NextAuth, { type NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterAccount } from "next-auth/adapters";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import Resend from "next-auth/providers/resend";
import { z } from "zod";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { env, isGoogleConfigured } from "@/lib/env";
import { encryptAccountTokens, decryptAccountTokens } from "@/lib/crypto";
import { hashPassword, verifyPasswordConstantTime } from "@/lib/password";
import { rateLimit, ipFromHeaders } from "@/lib/rate-limit";
import { sendMagicLink } from "@/lib/email";
import { verifySecondFactor } from "@/lib/account-security";

/**
 * Sign in with Apple is configured. Apple's client secret is a JWT that
 * expires (six months, maximum), which is why this is a presence check and not
 * a validity one — an expired secret still renders the button and fails at the
 * round trip, and that is a deploy problem, not a runtime branch.
 */
export function isAppleConfigured(): boolean {
  return Boolean(process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET);
}

/**
 * The email magic link is available. It needs BOTH halves of the mail
 * configuration: Resend rejects a send with no verified From address, and a
 * sign-in button whose only outcome is a silent non-delivery is worse than no
 * button — the user believes a link is coming.
 */
export function isEmailLinkConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

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
  // The second factor, when the account has one. Optional in the schema
  // because the form does not know whether it is needed until it has asked
  // (POST /api/auth/mfa/challenge) — and because an account WITHOUT two-step
  // must never be told that a code field exists.
  code: z.string().max(64).optional(),
});

// Brute-force limits on the credentials sign-in: per caller+account pair plus
// a wider per-IP net so one attacker can't spray many accounts. Every
// failure path returns `null` — next-auth then yields the same generic
// CredentialsSignin error whether the account exists, the password is wrong,
// or the caller is throttled, so nothing leaks about account existence.
const SIGNIN_WINDOW_SEC = 15 * 60;
const SIGNIN_MAX_PER_PAIR = 10;
const SIGNIN_MAX_PER_IP = 30;

const providers: NextAuthConfig["providers"] = [
  Credentials({
    name: "Email",
    credentials: { email: {}, password: {}, code: {} },
    authorize: async (raw, request) => {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) return null;
      const email = parsed.data.email.toLowerCase();

      const ip = request?.headers ? ipFromHeaders(new Headers(request.headers)) : "unknown";
      const checks = [rateLimit({ key: `signin:pair:${ip}:${email}`, limit: SIGNIN_MAX_PER_PAIR, windowSec: SIGNIN_WINDOW_SEC })];
      if (ip !== "unknown") {
        checks.push(rateLimit({ key: `signin:ip:${ip}`, limit: SIGNIN_MAX_PER_IP, windowSec: SIGNIN_WINDOW_SEC }));
      }
      const results = await Promise.all(checks);
      if (results.some((r) => !r.success)) return null;

      const user = await prisma.user.findUnique({ where: { email } });
      const { ok, needsUpgrade } = await verifyPasswordConstantTime(parsed.data.password, user?.hashedPassword);
      if (!user?.hashedPassword) return null;
      if (!ok) return null;
      if (user.bannedAt) return null;

      // Two-step verification, checked only AFTER the password has verified.
      // Doing it in this order means a wrong password never reaches the
      // recovery-code table, so an attacker cannot burn someone's recovery
      // codes (or learn that they have two-step on) without the password.
      if (user.totpEnabledAt) {
        const code = parsed.data.code?.trim();
        if (!code) return null;
        if (!(await verifySecondFactor(user.id, code))) return null;
      }
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

if (isAppleConfigured()) {
  providers.push(
    Apple({
      clientId: process.env.AUTH_APPLE_ID!,
      clientSecret: process.env.AUTH_APPLE_SECRET!,
      // Same reasoning as Google: no auto-linking by email address. Apple's
      // private relay addresses make that doubly true — the address is real but
      // it is not the address the account was registered with.
    })
  );
}

if (isEmailLinkConfigured()) {
  providers.push(
    Resend({
      apiKey: process.env.RESEND_API_KEY!,
      from: process.env.EMAIL_FROM!,
      // Sent through the product's own sender so the link looks like every
      // other mail Juno sends, and so one place logs a delivery failure.
      sendVerificationRequest: async ({ identifier, url }) => {
        const result = await sendMagicLink(identifier, url);
        // Auth.js shows the "check your email" page whatever happens here, so a
        // send that failed has to throw or the user waits for a mail that is
        // never coming. The URL is a credential and is never logged.
        if ("ok" in result && !result.ok) throw new Error("Could not send the sign-in link.");
      },
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
    async jwt({ token, user }) {
      if (user?.id) {
        token.uid = user.id;
        const account = await prisma.user.findUnique({
          where: { id: user.id },
          select: { sessionVersion: true },
        });
        token.sessionVersion = account?.sessionVersion ?? 0;
      }
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
            select: { image: true, name: true, sessionVersion: true },
          });
          if (u) {
            const issuedVersion = typeof token.sessionVersion === "number" ? token.sessionVersion : 0;
            if (u.sessionVersion !== issuedVersion) {
              // Returning an identity-free session makes server guards treat
              // this old JWT as signed out; the next sign-in replaces it.
              session.user.id = "";
              session.user.email = "";
              session.user.name = null;
              session.user.image = null;
              return session;
            }
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
    // Fires when the adapter creates a user (OAuth or magic-link sign-up).
    async createUser({ user }) {
      if (!user.id) return;
      await ensureUserDefaults(user.id);
      // Every provider that reaches this event has already proved the address:
      // Google and Apple only return verified addresses, and a magic link is
      // itself the proof. Marking it here rather than trusting an adapter to
      // map `email_verified` means a Google sign-up can spend immediately
      // instead of waiting for a verification mail it will never be sent.
      await prisma.user
        .updateMany({ where: { id: user.id, emailVerified: null }, data: { emailVerified: new Date() } })
        .catch(() => {
          /* Best-effort: the account exists; the banner will prompt instead. */
        });
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
