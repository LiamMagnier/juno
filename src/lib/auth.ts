import NextAuth, { type NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { env, isGoogleConfigured } from "@/lib/env";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

const providers: NextAuthConfig["providers"] = [
  Credentials({
    name: "Email",
    credentials: { email: {}, password: {} },
    authorize: async (raw) => {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) return null;
      const email = parsed.data.email.toLowerCase();
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user?.hashedPassword) return null;
      const ok = await bcrypt.compare(parsed.data.password, user.hashedPassword);
      if (!ok) return null;
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
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  pages: { signIn: "/sign-in" },
  trustHost: true,
  providers,
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = token.uid as string;
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
