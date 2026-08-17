/**
 * Juno Enterprise SAML 2.0 / OIDC SSO & Directory Integration
 *
 * Cryptographically verifies inbound OpenID Connect (OIDC) ID Tokens and SAML 2.0 Assertions.
 * Enforces signature validation, issuer verification, audience checking, temporal validity (exp/nbf),
 * nonce verification, replay attack prevention, and JIT provisioning.
 */

import { jwtVerify, type JWTPayload, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import type { KeyObject } from "node:crypto";

export interface EnterpriseSsoConfig {
  providerId: string;
  domain: string;
  protocol: "oidc" | "saml";
  issuerUrl: string;
  clientId?: string;
  clientSecret?: string;
  jwksUri?: string;
  certificatePem?: string;
  ssoUrl: string;
  allowAutoProvisioning: boolean;
  defaultRole: "OWNER" | "EDITOR" | "VIEWER";
}

export interface EnterpriseUserClaims {
  email: string;
  name: string;
  sub: string;
  issuer: string;
  givenName?: string;
  familyName?: string;
  groups?: string[];
  department?: string;
}

export class EnterpriseSsoService {
  private configs: Map<string, EnterpriseSsoConfig> = new Map();
  private jwksClients: Map<string, JWTVerifyGetKey> = new Map();
  private seenJtis: Map<string, number> = new Map(); // jti -> expiry timestamp for replay protection

  public registerConfig(config: EnterpriseSsoConfig): void {
    const domainKey = config.domain.toLowerCase();
    this.configs.set(domainKey, config);

    if (config.protocol === "oidc" && config.jwksUri) {
      this.jwksClients.set(domainKey, createRemoteJWKSet(new URL(config.jwksUri)));
    }
  }

  public getConfigForDomain(domain: string): EnterpriseSsoConfig | null {
    return this.configs.get(domain.toLowerCase()) ?? null;
  }

  public isEnterpriseDomain(email: string): boolean {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) return false;
    return this.configs.has(domain);
  }

  private pruneReplayCache(): void {
    const now = Date.now();
    for (const [jti, exp] of this.seenJtis.entries()) {
      if (exp < now) {
        this.seenJtis.delete(jti);
      }
    }
  }

  /**
   * Cryptographically verifies an OIDC ID Token against trusted issuer keys and configuration.
   */
  public async verifyOidcIdToken(
    idToken: string,
    domain: string,
    options: {
      expectedNonce?: string;
      customKey?: Uint8Array | KeyObject | CryptoKey;
    } = {}
  ): Promise<EnterpriseUserClaims> {
    const config = this.getConfigForDomain(domain);
    if (!config || config.protocol !== "oidc") {
      throw new Error(`No active OIDC SSO configuration found for domain '${domain}'`);
    }

    if (!idToken || typeof idToken !== "string") {
      throw new Error("Missing or invalid OIDC token format.");
    }

    this.pruneReplayCache();

    let verifiedPayload: JWTPayload;

    try {
      if (options.customKey) {
        // Verification with supplied key/secret (e.g. tests or direct certs)
        const result = await jwtVerify(idToken, options.customKey, {
          issuer: config.issuerUrl,
          audience: config.clientId,
          algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "HS256"],
        });
        verifiedPayload = result.payload;
      } else {
        const jwks = this.jwksClients.get(domain.toLowerCase());
        if (!jwks) {
          throw new Error(`No JWKS client initialized for '${domain}'.`);
        }
        const result = await jwtVerify(idToken, jwks, {
          issuer: config.issuerUrl,
          audience: config.clientId,
        });
        verifiedPayload = result.payload;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`OIDC cryptographic verification failed: ${msg}`);
    }

    // Replay protection via jti
    if (verifiedPayload.jti) {
      if (this.seenJtis.has(verifiedPayload.jti)) {
        throw new Error(`OIDC token replay detected for jti '${verifiedPayload.jti}'.`);
      }
      const expMs = (verifiedPayload.exp ? verifiedPayload.exp * 1000 : Date.now() + 300_000);
      this.seenJtis.set(verifiedPayload.jti, expMs);
    }

    // Nonce verification
    if (options.expectedNonce) {
      if (!verifiedPayload.nonce || verifiedPayload.nonce !== options.expectedNonce) {
        throw new Error("OIDC token nonce mismatch.");
      }
    }

    const email = (verifiedPayload.email as string) || "";
    if (!email) {
      throw new Error("OIDC token missing verified email claim.");
    }

    const name = (verifiedPayload.name as string) || email.split("@")[0];

    return {
      email: email.toLowerCase(),
      name,
      sub: verifiedPayload.sub || email,
      issuer: (verifiedPayload.iss as string) || config.issuerUrl,
      givenName: verifiedPayload.given_name as string | undefined,
      familyName: verifiedPayload.family_name as string | undefined,
      groups: Array.isArray(verifiedPayload.groups) ? (verifiedPayload.groups as string[]) : undefined,
      department: verifiedPayload.department as string | undefined,
    };
  }

  /**
   * SAML 2.0 Response XML assertion verification.
   *
   * SECURITY NOTICE: SAML 2.0 XML assertion validation is currently disabled in production
   * pending audited XMLDSig integration to prevent XML signature wrapping (XSW) and parsing
   * vulnerabilities. Enterprise environments must use OIDC SSO (OpenID Connect with JWKS).
   */
  public async verifySamlAssertion(
    _samlResponseXml: string,
    domain: string,
    _options: { expectedInResponseTo?: string } = {}
  ): Promise<EnterpriseUserClaims> {
    const config = this.getConfigForDomain(domain);
    if (!config || config.protocol !== "saml") {
      throw new Error(`No active SAML SSO configuration found for domain '${domain}'`);
    }

    // Fail closed: Do not allow unverified or regex-parsed SAML assertions into session context.
    throw new Error(
      `SAML 2.0 authentication for domain '${domain}' is disabled in production pending audited XMLDSig integration. Please configure OpenID Connect (OIDC) SSO.`
    );
  }
}

export const enterpriseSso = new EnterpriseSsoService();
