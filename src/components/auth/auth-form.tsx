"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Pressable } from "@/components/ui/pressable";

function AppleIcon() {
  return (
    // Apple's mark is monochrome by specification, so unlike the Google mark it
    // takes the button's own foreground token rather than a literal colour.
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true" fill="currentColor">
      <path d="M16.37 12.78c.02-2.1 1.72-3.11 1.8-3.16-0.98-1.44-2.5-1.64-3.05-1.66-1.3-.13-2.54.76-3.2.76-.66 0-1.68-.74-2.76-.72-1.42.02-2.73.82-3.46 2.09-1.48 2.56-.38 6.35 1.06 8.43.7 1.02 1.54 2.16 2.64 2.12 1.06-.04 1.46-.68 2.74-.68 1.28 0 1.64.68 2.76.66 1.14-.02 1.86-1.03 2.56-2.05.8-1.18 1.13-2.32 1.15-2.38-.03-.01-2.2-.84-2.24-3.34ZM14.3 6.4c.58-.71.97-1.7.86-2.68-.83.03-1.84.55-2.44 1.26-.54.62-1.01 1.63-.88 2.59.93.07 1.88-.47 2.46-1.17Z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    // The four hex fills are Google's brand mark, which may not be recoloured —
    // this is the one place in the tree where a literal colour is correct, and it
    // is why the mark is inlined rather than tinted from a token.
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

const MIN_PASSWORD = 8;

/**
 * What Auth.js sends back on `?error=` when an OAuth round trip fails.
 *
 * Same-email account linking is deliberately off (src/lib/auth.ts), so a
 * password user who presses "Continue with Google" comes back here as
 * `OAuthAccountNotLinked` — and until this map existed the parameter was
 * dropped on the floor and the card simply reappeared, blank. The Auth.js
 * codes are its public contract (`pages.signIn` is set, so every sign-in
 * error lands on this page); anything unlisted gets the generic line.
 */
const OAUTH_ERRORS: Record<string, string> = {
  OAuthAccountNotLinked:
    "This email already signs in with a password. Use it below — Google can be linked to the account from Settings afterwards.",
  OAuthCallbackError: "Google didn't finish signing you in. Try again, or use your email and password.",
  OAuthSignin: "Google sign-in couldn't start. Try again in a moment.",
  AccessDenied: "That Google account isn't allowed to sign in here.",
  Configuration: "Sign-in isn't configured correctly on this server. Please contact the site owner.",
};

function oauthErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return OAUTH_ERRORS[code] ?? "Sign-in didn't go through. Try again, or use your email and password.";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  email?: string;
  password?: string;
  code?: string;
}

/**
 * What `/api/auth/verify-email` sends the browser back with. Shown here rather
 * than on a page of its own so that the one link in the mail always lands
 * somewhere the user can act: signed out, that is this form.
 */
const VERIFICATION_NOTICES: Record<string, string> = {
  verified: "Your email address is confirmed. Sign in to pick up where you left off.",
  expired: "That confirmation link has expired. Sign in and we'll send you a fresh one.",
  invalid: "That confirmation link has already been used, or isn't valid any more.",
};

/**
 * The server's message, routed to the field it is about.
 *
 * /api/auth/register answers with zod's own sentences — "Password must be at
 * least 8 characters", "Invalid email" — as one `error` string. Matching on
 * the noun is enough to put each next to its input, which is what SC 3.3.1
 * asks for; anything that names neither field stays a form-level message.
 */
function routeServerError(message: string): FieldErrors | null {
  if (/password/i.test(message)) return { password: message };
  if (/email/i.test(message)) return { email: message };
  return null;
}

export interface AuthFormProps {
  mode: "signin" | "signup";
  /**
   * One flag per provider, resolved on the server from the environment.
   *
   * A sign-in button that cannot work is worse than an absent one: it takes
   * the user out of the form, through a redirect, and back to an error they
   * can do nothing about. So every button here is rendered only when its
   * provider is actually configured, and the decision is made where the
   * secrets are — never guessed in the browser.
   */
  googleEnabled: boolean;
  appleEnabled: boolean;
  emailLinkEnabled: boolean;
}

export function AuthForm({ mode, googleEnabled, appleEnabled, emailLinkEnabled }: AuthFormProps) {
  const params = useSearchParams();
  const requestedCallback = params.get("callbackUrl");
  const callbackUrl = React.useMemo(() => {
    if (!requestedCallback || !requestedCallback.startsWith("/") || requestedCallback.startsWith("//")) return "/chat";
    try {
      const parsed = new URL(requestedCallback, "https://juno.invalid");
      if (parsed.origin !== "https://juno.invalid") return "/chat";
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return "/chat";
    }
  }, [requestedCallback]);

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [googleLoading, setGoogleLoading] = React.useState(false);
  const [appleLoading, setAppleLoading] = React.useState(false);
  const [linkLoading, setLinkLoading] = React.useState(false);

  // The two-step code step. The form only ever enters it after
  // /api/auth/mfa/challenge has said this account has two-step on, so an
  // account without it never sees a code box — which is also why the challenge
  // exists rather than the form always asking.
  const [step, setStep] = React.useState<"credentials" | "code">("credentials");
  const [code, setCode] = React.useState("");
  const codeRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  const [notice, setNotice] = React.useState<string | null>(
    () => VERIFICATION_NOTICES[params.get("verified") ?? ""] ?? null
  );
  const busy = loading || googleLoading || appleLoading || linkLoading;

  // Inline, not toast: a message about a field lives under that field; a
  // message about the whole attempt lives above the form. Toasts are kept for
  // the one thing that is neither — the network failing.
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<React.ReactNode>(() => oauthErrorMessage(params.get("error")));
  // Validate on blur only once a submit has been attempted — never on the first
  // keystroke, which flags a half-typed address as wrong while it is being typed.
  const [submitted, setSubmitted] = React.useState(false);

  const validate = React.useCallback(
    (values: { email: string; password: string }): FieldErrors => {
      const next: FieldErrors = {};
      if (!values.email.trim()) next.email = "Enter your email address.";
      else if (!EMAIL_RE.test(values.email.trim())) next.email = "That doesn't look like an email address.";
      if (!values.password) next.password = "Enter your password.";
      else if (mode === "signup" && values.password.length < MIN_PASSWORD)
        next.password = `Use at least ${MIN_PASSWORD} characters.`;
      return next;
    },
    [mode]
  );

  const revalidate = () => {
    if (submitted) setFieldErrors(validate({ email, password }));
  };

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const effectiveName = (formData.get("name") as string) || name;
    const effectiveEmail = ((formData.get("email") as string) || email).trim();
    const effectivePassword = (formData.get("password") as string) || password;

    setSubmitted(true);
    setFormError(null);
    setNotice(null);

    // The code step re-submits the credentials it already holds along with the
    // code. They are not re-validated: they were correct a moment ago, and
    // re-running the rules here would flag a password the server has accepted.
    if (step === "code") {
      const submittedCode = code.trim();
      if (!submittedCode) {
        setFieldErrors({ code: "Enter the code from your authenticator app." });
        return;
      }
      setLoading(true);
      try {
        const result = await signIn("credentials", {
          email: effectiveEmail,
          password: effectivePassword,
          code: submittedCode,
          redirect: false,
        });
        if (result?.error) {
          // Deliberately one message for both "wrong code" and "expired code":
          // the server does not distinguish them either, and a used recovery
          // code must not be identifiable as one that was once valid.
          setFieldErrors({ code: "That code isn't right. Try the current one, or a recovery code." });
          return;
        }
        window.location.href = callbackUrl;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setLoading(false);
      }
      return;
    }

    const clientErrors = validate({ email: effectiveEmail, password: effectivePassword });
    setFieldErrors(clientErrors);
    if (clientErrors.email || clientErrors.password) return;

    setLoading(true);
    try {
      if (mode === "signin") {
        // Pre-flight: does this account want a second factor? Answers false for
        // everything else, including a wrong password, so nothing is learned
        // here that submitting the form would not already reveal.
        const challenge = await fetch("/api/auth/mfa/challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: effectiveEmail, password: effectivePassword }),
        })
          .then((r) => (r.ok ? (r.json() as Promise<{ mfaRequired?: boolean }>) : { mfaRequired: false }))
          .catch(() => ({ mfaRequired: false }));
        if (challenge.mfaRequired) {
          setStep("code");
          return;
        }
      }

      if (mode === "signup") {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: effectiveName, email: effectiveEmail, password: effectivePassword }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          const message = data.error ?? "Couldn’t create your account.";
          const routed = routeServerError(message);
          if (routed) setFieldErrors(routed);
          else setFormError(message);
          return;
        }
      }

      const result = await signIn("credentials", { email: effectiveEmail, password: effectivePassword, redirect: false });
      if (result?.error) {
        if (mode === "signup") {
          // Registration answers 201 for an address that already exists, on
          // purpose (it must not be an account-membership oracle) — so a failed
          // sign-in right after it is the only signal, and it must not claim an
          // account was created. Say what is true and offer both ways out.
          setFormError(
            <>
              If an account already exists for this email,{" "}
              <Link href={`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="font-medium underline underline-offset-4">
                sign in
              </Link>{" "}
              instead — or{" "}
              <Link href="/forgot-password" className="font-medium underline underline-offset-4">
                reset your password
              </Link>
              .
            </>
          );
        } else {
          setFormError("Invalid email or password.");
        }
        return;
      }
      window.location.href = callbackUrl;
    } catch (err) {
      // The one toast left: a fetch that never came back is not about a field.
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      {formError && (
        // role="alert" so an error that arrives after a submit is announced;
        // the destructive tint at low alpha is the product's warning-well
        // recipe (rounded-field, /35 border, /10 fill) in the failure hue.
        <p
          role="alert"
          className="flex items-start gap-2 rounded-field border border-destructive/35 bg-destructive/10 px-3.5 py-3 text-body text-foreground"
        >
          <StatusIcons.error className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <span>{formError}</span>
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-field border border-border/60 bg-muted/40 px-3.5 py-3 text-body text-foreground"
        >
          <span>{notice}</span>
        </p>
      )}

      {/* Hidden during the code step: there is nothing to choose there, and a
          provider button mid-challenge would abandon a half-finished sign-in. */}
      {step === "credentials" && googleEnabled && (
        <>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={busy}
            aria-busy={googleLoading}
            onClick={() => {
              setGoogleLoading(true);
              signIn("google", { callbackUrl });
            }}
          >
            {/* motion-safe:, which is what eleven of the product's nineteen
                spinners already do and these four did not. A control that spins
                forever is the plainest case prefers-reduced-motion exists for,
                and nothing is lost: the button is disabled and aria-busy, so the
                busy state is still both announced and drawn. */}
            {googleLoading ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <GoogleIcon />}
            Continue with Google
          </Button>
        </>
      )}

      {step === "credentials" && appleEnabled && (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={busy}
          aria-busy={appleLoading}
          onClick={() => {
            setAppleLoading(true);
            signIn("apple", { callbackUrl });
          }}
        >
          {appleLoading ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <AppleIcon />}
          Continue with Apple
        </Button>
      )}

      {step === "credentials" && (googleEnabled || appleEnabled) && (
        <>
          {/* The rule is written explicitly at border-border/60. With no colour
              class it inherited the global `* { border-color: hsl(var(--border)) }`
              at full 21%, so the one hairline INSIDE the card was louder than the
              card's own edge and every damped rule on the surrounding pages.
              `bg-card` on the label, not `bg-background`: the knockout has to
              match the surface it actually sits on, and on the true-black theme
              --background punched a pure-black notch through a 6.5% panel. */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden>
              <span className="w-full border-t border-border/60" />
            </div>
            {/* text-label, the product's one label voice (mono, sentence case),
                rather than a bare Tailwind text-xs that appears nowhere else. */}
            <div className="relative flex justify-center">
              <span className="bg-card px-2 font-mono text-label text-muted-foreground">or</span>
            </div>
          </div>
        </>
      )}

      {/* method="post" matters even though onSubmit handles every real
          submission: a form with no method defaults to GET, so a press that
          lands before React has hydrated navigates to
          /sign-in?email=…&password=… — putting the password in the address
          bar, the browser history, the referrer and any access log in front
          of it. POST is not a working fallback (there is no route to receive
          it) but it fails without leaking the credential, which is the only
          property that matters here. */}
      <form method="post" onSubmit={onSubmit} className="space-y-4" noValidate>
        {/* The credentials stay mounted but hidden during the code step: the
            password is still in state and still submitted, and unmounting the
            inputs would hand the browser's password manager a form that looks
            like a different one. */}
        <div className={step === "code" ? "hidden" : "space-y-4"} aria-hidden={step === "code"}>
        {mode === "signup" && (
          <Field
            id="name"
            name="name"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="How Juno should address you"
            autoComplete="name"
          />
        )}
        <Field
          id="email"
          name="email"
          type="email"
          label="Email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={revalidate}
          error={fieldErrors.email}
          placeholder="you@example.com"
          autoComplete="email"
          inputMode="email"
        />
        <Field
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          label="Password"
          required
          minLength={MIN_PASSWORD}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={revalidate}
          error={fieldErrors.password}
          hint={mode === "signup" ? `At least ${MIN_PASSWORD} characters.` : undefined}
          placeholder={mode === "signup" ? "Choose a password" : "Your password"}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          labelAction={
            mode === "signin" ? (
              <Link
                href="/forgot-password"
                className="rounded-xs text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline focus-visible:text-foreground"
              >
                Forgot your password?
              </Link>
            ) : undefined
          }
          trailing={
            // aria-pressed, not a label swap: the accessible name stays "Show
            // password" and the state says whether it is on, so a screen reader
            // hears one control changing rather than two controls trading places.
            <Pressable
              kind="icon"
              size="sm"
              aria-label="Show password"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </Pressable>
          }
        />
        </div>

        {step === "code" && (
          <>
            <p className="text-body text-muted-foreground">
              This account uses two-step verification. Enter the 6-digit code from your authenticator app — or one of
              your recovery codes if you can&apos;t reach it.
            </p>
            <Field
              ref={codeRef}
              id="mfa-code"
              name="code"
              label="Verification code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              error={fieldErrors.code}
              placeholder="123456"
              // one-time-code so iOS and password managers offer the code from
              // the keyboard; text rather than number so a recovery code (which
              // has letters and a dash) can be typed into the same field.
              autoComplete="one-time-code"
              inputMode="text"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={20}
            />
          </>
        )}

        {/* Disabled while the Google redirect is in flight too. Clicking Continue
            with Google and then Sign in fired a second auth attempt against a
            page that was already navigating away — the Google button already
            guards against the reverse order, and this closes the pair.
            aria-busy so the state is announced, not only drawn. */}
        <Button type="submit" className="w-full" disabled={busy} aria-busy={loading}>
          {loading && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
          {step === "code" ? "Verify and sign in" : mode === "signup" ? "Create account" : "Sign in"}
        </Button>

        {step === "code" && (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={loading}
            onClick={() => {
              setStep("credentials");
              setCode("");
              setFieldErrors({});
            }}
          >
            Use a different account
          </Button>
        )}
      </form>

      {/* The magic link reuses the address already typed rather than opening a
          second form — there is only ever one email on this card, and asking
          for it twice is how a user ends up sending a link to a typo. */}
      {step === "credentials" && emailLinkEnabled && (
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          disabled={busy}
          aria-busy={linkLoading}
          onClick={() => {
            const address = email.trim();
            if (!address || !EMAIL_RE.test(address)) {
              setSubmitted(true);
              setFieldErrors({ email: "Enter your email address to get a sign-in link." });
              return;
            }
            setLinkLoading(true);
            setFormError(null);
            signIn("resend", { email: address, callbackUrl });
          }}
        >
          {linkLoading && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
          Email me a sign-in link instead
        </Button>
      )}

      <p className="text-center text-body text-muted-foreground">
        {mode === "signup" ? (
          <>
            Already have an account?{" "}
            <Link href={`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="rounded-xs font-medium text-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:underline focus-visible:text-primary">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New to Juno?{" "}
            <Link href={`/sign-up?callbackUrl=${encodeURIComponent(callbackUrl)}`} className="rounded-xs font-medium text-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:underline focus-visible:text-primary">
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
