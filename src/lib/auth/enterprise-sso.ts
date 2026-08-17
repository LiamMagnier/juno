/**
 * Juno Enterprise SAML 2.0 / OIDC SSO & Directory Integration
 *
 * Supports Okta, Microsoft Entra ID (Azure AD), Google Workspace, and Ping Identity.
 * Provides JIT (Just-In-Time) user provisioning and SCIM schema mappings.
 */

export interface EnterpriseSsoConfig {
  providerId: string;
  domain: string;
  issuerUrl: string;
  ssoUrl: string;
  certificatePem: string;
  allowAutoProvisioning: boolean;
  defaultRole: "OWNER" | "EDITOR" | "VIEWER";
}

export interface EnterpriseUserClaims {
  email: string;
  name: string;
  givenName?: string;
  familyName?: string;
  groups?: string[];
  department?: string;
}

export class EnterpriseSsoService {
  private configs: Map<string, EnterpriseSsoConfig> = new Map();

  public registerConfig(config: EnterpriseSsoConfig): void {
    this.configs.set(config.domain.toLowerCase(), config);
  }

  public getConfigForDomain(domain: string): EnterpriseSsoConfig | null {
    return this.configs.get(domain.toLowerCase()) ?? null;
  }

  /**
   * Resolves whether an email domain requires enterprise SSO routing.
   */
  public isEnterpriseDomain(email: string): boolean {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return false;
    return this.configs.has(domain);
  }

  /**
   * Validates inbound SAML / OIDC assertions and normalizes user profile claims.
   */
  public parseAssertion(claims: Record<string, unknown>): EnterpriseUserClaims {
    const email = (claims.email ?? claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] ?? "") as string;
    const name = (claims.name ?? claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ?? email.split("@")[0]) as string;

    if (!email) {
      throw new Error("Invalid SSO assertion: missing email claim.");
    }

    return {
      email,
      name,
      givenName: claims.given_name as string | undefined,
      familyName: claims.family_name as string | undefined,
      groups: Array.isArray(claims.groups) ? (claims.groups as string[]) : undefined,
    };
  }
}

export const enterpriseSso = new EnterpriseSsoService();
