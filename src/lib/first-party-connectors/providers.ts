import type { ConnectorDef } from "@/lib/connectors";

export const FIRST_PARTY_IDS = ["gmail", "google-calendar", "google-drive", "outlook", "microsoft-365", "slack"] as const;
export type FirstPartyId = (typeof FIRST_PARTY_IDS)[number];
export function isFirstPartyId(id: string): id is FirstPartyId {
  return FIRST_PARTY_IDS.includes(id as FirstPartyId);
}

/** Separate from sign-in OAuth: linking mail must never change login scopes. */
export function firstPartyDefinitions(appUrl: string, vars: Readonly<Record<string, string | undefined>>): ConnectorDef[] {
  const google = { clientId: vars.CONNECTOR_GOOGLE_CLIENT_ID, clientSecret: vars.CONNECTOR_GOOGLE_CLIENT_SECRET };
  const microsoft = { clientId: vars.CONNECTOR_MICROSOFT_CLIENT_ID, clientSecret: vars.CONNECTOR_MICROSOFT_CLIENT_SECRET };
  const specs: Array<{ id: FirstPartyId; label: string; description: string; scope: string }> = [
    { id: "gmail", label: "Gmail", description: "Search and read mail, create drafts, and send with your approval.", scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose" },
    { id: "google-calendar", label: "Google Calendar", description: "Read your calendars and manage events with your permission.", scope: "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events" },
    { id: "google-drive", label: "Google Drive", description: "Search and read files in Google Drive.", scope: "https://www.googleapis.com/auth/drive.readonly" },
    { id: "outlook", label: "Outlook", description: "Search mail, create drafts, and send with your approval. Manage your calendar.", scope: "offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite" },
    { id: "microsoft-365", label: "Microsoft 365", description: "Search and read files in OneDrive and SharePoint.", scope: "offline_access User.Read Files.Read.All Sites.Read.All" },
    { id: "slack", label: "Slack", description: "Search conversations, read channels, and post with your approval.", scope: "search:read,channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,chat:write" },
  ];
  return specs.map((spec): ConnectorDef => {
    const ms = spec.id === "outlook" || spec.id === "microsoft-365";
    const slack = spec.id === "slack";
    const tokenUrl = slack ? "https://slack.com/api/oauth.v2.access" : ms ? "https://login.microsoftonline.com/common/oauth2/v2.0/token" : "https://oauth2.googleapis.com/token";
    return {
      ...spec, kind: "oauth_app", firstParty: true, capability: spec.description,
      authorizeUrl: slack ? "https://slack.com/oauth/v2/authorize" : ms ? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" : "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl, refreshUrl: tokenUrl, authStyle: "body",
      // Slack uses a confidential server-side app. Its PKCE mode changes the
      // client type irreversibly; do not silently require that owner setting.
      pkce: !slack,
      authorizeParams: slack ? { user_scope: spec.scope } : ms ? {} : { access_type: "offline", prompt: "consent" },
      cfg: { ...(slack ? { clientId: vars.CONNECTOR_SLACK_CLIENT_ID, clientSecret: vars.CONNECTOR_SLACK_CLIENT_SECRET } : ms ? microsoft : google), mcpUrl: `${appUrl.replace(/\/$/, "")}/api/mcp/first-party/${spec.id}` },
      async fetchAccountLabel(accessToken) {
        const url = slack ? "https://slack.com/api/auth.test" : ms ? "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName" : spec.id === "gmail" ? "https://gmail.googleapis.com/gmail/v1/users/me/profile" : "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)";
        // Calendar-only scopes cannot call Drive's about endpoint.
        if (spec.id === "google-calendar") return null;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000), redirect: "error" });
        if (!res.ok) return null;
        const body = await res.json();
        return body.emailAddress ?? body.user?.emailAddress ?? body.mail ?? body.userPrincipalName ?? (body.ok ? `${body.team ?? "Slack"} · ${body.user ?? ""}` : null);
      },
    };
  });
}
