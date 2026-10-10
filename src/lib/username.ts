import { z } from "zod";

/**
 * The @handle an account chooses: its rules, as one pure module the API, the
 * Settings field and the tests all read (no database, no browser imports).
 *
 *   3–30 characters
 *   lowercase letters, digits, dot, underscore and hyphen
 *   starts with a letter or a digit
 *   no two dots in a row, and no dot at the end
 *   not a reserved word (the product's names, roles, and every top-level
 *   route under src/app, so /settings can never be someone's handle)
 *
 * Input is forgiving and the stored form is strict: a leading "@" and
 * surrounding space are dropped, and capitals are lowered, so "@Liam" is read
 * as "liam". The column stores that lowercased form (a CHECK constraint in
 * the migration holds it), which is what makes the unique index on it a
 * case-insensitive one.
 *
 * Until an account picks one, the profile shows a handle derived from the
 * email (`displayHandle`, `profileHandle`).
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/**
 * Words no account may take. The top-level route names are listed by hand (a
 * module the browser loads cannot read the file system); a test walks
 * src/app and fails when a new route is missing from here.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Product, roles and identities a reader could mistake for staff.
  "admin",
  "administrator",
  "alevr",
  "juno",
  "orbit",
  "continuum",
  "support",
  "pair",
  "help",
  "helpdesk",
  "api",
  "settings",
  "profile",
  "root",
  "system",
  "owner",
  "null",
  "undefined",
  "nil",
  "none",
  "anonymous",
  "everyone",
  "here",
  "staff",
  "team",
  "official",
  "moderator",
  "mod",
  "security",
  "billing",
  "abuse",
  "postmaster",
  "webmaster",
  "hostmaster",
  "noreply",
  "no-reply",
  "mail",
  "email",
  "www",
  "about",
  "privacy",
  "terms",
  "status",
  "blog",
  "docs",
  "static",
  "assets",
  "public",
  "user",
  "users",
  "account",
  "accounts",
  "login",
  "logout",
  "signin",
  "signup",
  "register",
  "me",
  "you",
  "new",
  "home",
  "index",
  "favicon",
  "robots",
  "sitemap",
  "manifest",
  "opengraph-image",
  "twitter-image",
  "apple-icon",
  "icon",
  // Top-level routes under src/app (route groups flattened).
  "admin",
  "agents",
  "app-auth",
  "artifacts",
  "assistants",
  "aura-preview",
  "auth-error",
  "automations",
  "chat",
  "check-email",
  "code",
  "compare",
  "computer-view",
  "connections",
  "crew",
  "customize",
  "design",
  "dev",
  "download",
  "engineering",
  "fonts",
  "forgot-password",
  "knowledge",
  "legal",
  "library",
  "memory",
  "offline",
  "permissions",
  "projects",
  "research",
  "reset-password",
  "roadmap",
  "sandbox",
  "share",
  "sign-in",
  "sign-up",
  "skills",
  "suspended",
  "tasks",
  "upgrade",
  "work",
]);

export type UsernameProblem = "too_short" | "too_long" | "characters" | "start" | "dots" | "reserved";

export const USERNAME_MESSAGES: Record<UsernameProblem, string> = {
  too_short: `Use at least ${USERNAME_MIN} characters.`,
  too_long: `Keep it to ${USERNAME_MAX} characters or fewer.`,
  characters: "Use only lowercase letters, numbers, dots, underscores and hyphens.",
  start: "Start with a letter or a number.",
  dots: "Dots can’t sit next to each other or end the name.",
  reserved: "That name is reserved.",
};

/** The forgiving read of what someone typed: no "@", no surrounding space, lowercase. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

export type UsernameCheck = { ok: true; username: string } | { ok: false; problem: UsernameProblem; message: string };

/** Validates a typed name. The first problem wins, in the order a reader would fix them. */
export function checkUsername(raw: string): UsernameCheck {
  const username = normalizeUsername(raw);
  const fail = (problem: UsernameProblem): UsernameCheck => ({ ok: false, problem, message: USERNAME_MESSAGES[problem] });
  if (!/^[a-z0-9._-]*$/.test(username)) return fail("characters");
  if (username.length < USERNAME_MIN) return fail("too_short");
  if (username.length > USERNAME_MAX) return fail("too_long");
  if (!/^[a-z0-9]/.test(username)) return fail("start");
  if (username.includes("..") || username.endsWith(".")) return fail("dots");
  if (RESERVED_USERNAMES.has(username)) return fail("reserved");
  return { ok: true, username };
}

/** The server's schema: parses to the normalised, valid username, or fails with the friendly copy. */
export const usernameSchema = z
  .string({ error: "Choose a username." })
  .max(200, USERNAME_MESSAGES.too_long)
  .transform((value, ctx) => {
    const result = checkUsername(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message, params: { problem: result.problem } });
      return z.NEVER;
    }
    return result.username;
  });

/**
 * The @handle to show for an account: the chosen username, or, until there is
 * one, a handle derived from the email's local part (never the domain); failing
 * that, the name as a slug.
 */
export function displayHandle(user: { username?: string | null; name: string | null; email: string | null }): string {
  if (user.username) return user.username;
  return derivedHandle(user);
}

/** The handle derived from the email (or the name) for an account with no username. */
export function derivedHandle(user: { name: string | null; email: string | null }): string {
  const local = user.email?.split("@")[0]?.split("+")[0] ?? "";
  const fromEmail = local.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (fromEmail) return fromEmail;
  const fromName = (user.name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "");
  return fromName || "you";
}
