/**
 * Process-wide hardening: URL policy, external-open policy, webPreferences, CSP.
 *
 * These four are the controls that stand between agent-authored output and the
 * operating system. They are also the controls most likely to be quietly
 * loosened by a well-meaning change ("just let it open the docs link"), which is
 * why the assertions here are exact rather than "contains".
 *
 * `electron` is mocked. `src/main/security.ts` imports `app`, `session` and
 * `shell` at module scope, and the real module cannot be loaded outside an
 * Electron process. The mock is also what makes the central `openExternal`
 * assertion possible: proving a URL was *refused* means proving that
 * `shell.openExternal` was never reached, which requires a spy on it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Hoisted so the `vi.mock` factory below — which is lifted above the imports —
 * can close over the same objects the tests reach for.
 */
const electron = vi.hoisted(() => ({
  /* Packaged by default: the dev-server exemption in `isInternalUrl` must be
     opt-in for the one test that exercises it, not ambient for all of them. */
  app: { isPackaged: true },
  shell: { openExternal: vi.fn(async (_url: string): Promise<void> => undefined) },
  session: { defaultSession: {} },
}));

vi.mock('electron', () => electron);

import {
  CONTENT_SECURITY_POLICY,
  EXTERNAL_HOST_ALLOWLIST,
  SECURE_WEB_PREFERENCES,
  isInternalUrl,
  openExternal,
  redactUrl,
} from '../../src/main/security';

beforeEach(() => {
  electron.app.isPackaged = true;
  electron.shell.openExternal.mockClear();
  /* The module warns on every refusal by design. Silenced so a passing run is
     readable, and restored afterwards so a warn in another file is not lost. */
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* isInternalUrl                                                               */
/* -------------------------------------------------------------------------- */

describe('isInternalUrl', () => {
  test.each([
    'juno://app',
    'juno://app/',
    'juno://app/index.html',
    'juno://app/settings/appearance',
    'juno://app/index.html?tab=code#top',
  ])('accepts the application origin: %s', (url) => {
    expect(isInternalUrl(url)).toBe(true);
  });

  test.each([
    /* The bypass this function exists to stop: a prefix check on
       "juno://app" matches every one of these. */
    ['a lookalike subdomain', 'juno://app.evil.example'],
    ['a lookalike subdomain with a path', 'juno://app.evil.example/index.html'],
    ['a different host on the app scheme', 'juno://evil'],
    ['a host that merely starts with app', 'juno://appx'],
    ['userinfo pointing elsewhere', 'juno://app@evil.example/'],
    /* Different scheme, right-looking host. */
    ['plain https', 'https://evil.example'],
    ['https on the app host', 'https://app/'],
    /* Schemes that are dangerous wherever they appear. */
    ['javascript', 'javascript:alert(document.cookie)'],
    ['javascript with whitespace padding', '  javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
    ['file on the app host', 'file://app/index.html'],
    /* Not URLs at all. */
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a bare path', '/index.html'],
    ['a protocol-relative URL', '//evil.example/'],
    ['a sentence', 'not a url at all'],
    ['a scheme with no host', 'juno:app'],
  ])('rejects %s: %s', (_label, url) => {
    expect(isInternalUrl(url)).toBe(false);
  });

  test('rejects a non-string without throwing', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(() => isInternalUrl(value as unknown as string)).not.toThrow();
      expect(isInternalUrl(value as unknown as string)).toBe(false);
    }
  });

  test('accepts the dev server only on an unpackaged build', () => {
    electron.app.isPackaged = false;
    expect(isInternalUrl('http://localhost:5173/')).toBe(true);
    expect(isInternalUrl('http://127.0.0.1:5173/index.html')).toBe(true);
    /* Even unpackaged, the exemption is for the loopback host only. */
    expect(isInternalUrl('http://evil.example/')).toBe(false);
    expect(isInternalUrl('https://localhost.evil.example/')).toBe(false);

    electron.app.isPackaged = true;
    expect(isInternalUrl('http://localhost:5173/')).toBe(false);
    expect(isInternalUrl('http://127.0.0.1:5173/')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* openExternal                                                                */
/* -------------------------------------------------------------------------- */

describe('openExternal', () => {
  test.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['file with a host', 'file://localhost/etc/passwd'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    /* Custom schemes are the reason the scheme check comes first: on macOS
       these are registered by whatever software the user has installed, and
       `shell.openExternal` will hand them straight to it. */
    ['the app scheme itself', 'juno://app/index.html'],
    ['a third-party app scheme', 'slack://channel?team=T1&id=C1'],
    ['a scheme that launches a terminal', 'x-man-page://1/sh'],
    ['smb', 'smb://192.168.1.10/share'],
    ['vscode', 'vscode://file/etc/passwd'],
    /* Plain http on an otherwise-allowlisted host: downgrade is still refused. */
    ['http on an allowlisted host', 'http://github.com/juno/juno'],
    ['ftp', 'ftp://github.com/'],
  ])('refuses a non-https URL (%s) and never reaches the shell', async (_label, url) => {
    await expect(openExternal(url)).resolves.toBe(false);
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  test.each([
    ['an unrelated host', 'https://evil.example/'],
    ['a suffix-confusion host', 'https://github.com.evil.example/juno'],
    ['a prefix-confusion host', 'https://evilgithub.com/'],
    ['a subdomain of an allowlisted host', 'https://gist.github.com/x'],
    /* The classic: everything before `@` is userinfo, so the real host is
       evil.example. A `startsWith`/`includes` host check passes this. */
    ['userinfo impersonating an allowlisted host', 'https://github.com@evil.example/'],
    ['userinfo with a password', 'https://github.com:x@evil.example/'],
    /* Cyrillic U+0456 in place of the Latin "i", written as an escape so the
       case cannot be quietly "fixed" by an editor normalising the character.
       URL parsing punycodes it to xn--gthub-a1d.com, which is not the
       allowlisted host — but only because the check reads `url.hostname`. */
    ['a unicode homoglyph host', 'https://g\u0456thub.com/'],
  ])('refuses a non-allowlisted host (%s) and never reaches the shell', async (_label, url) => {
    await expect(openExternal(url)).resolves.toBe(false);
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  test.each([['not a url'], [''], ['https://'], ['   ']])(
    'refuses malformed input (%j) and never reaches the shell',
    async (url) => {
      await expect(openExternal(url)).resolves.toBe(false);
      expect(electron.shell.openExternal).not.toHaveBeenCalled();
    },
  );

  test('opens an allowlisted https URL, exactly once, with the parsed URL', async () => {
    await expect(openExternal('https://github.com/juno/juno/issues/1')).resolves.toBe(true);

    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://github.com/juno/juno/issues/1');
  });

  test('opens every host on the allowlist', async () => {
    for (const host of EXTERNAL_HOST_ALLOWLIST) {
      electron.shell.openExternal.mockClear();
      await expect(openExternal(`https://${host}/x`)).resolves.toBe(true);
      expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
    }
  });

  test('the allowlist is small and contains no wildcards', () => {
    /* A wildcard entry would silently re-admit every subdomain-confusion case
       asserted above, and a long list is a list nobody reviews. */
    for (const host of EXTERNAL_HOST_ALLOWLIST) {
      expect(host).not.toMatch(/[*\s/:]/);
      expect(host).toBe(host.toLowerCase());
    }
    expect(EXTERNAL_HOST_ALLOWLIST.size).toBeLessThanOrEqual(10);
  });

  test('host matching is case-insensitive because URL parsing lowercases the host', async () => {
    await expect(openExternal('https://GitHub.COM/juno')).resolves.toBe(true);
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* redactUrl                                                                   */
/* -------------------------------------------------------------------------- */

describe('redactUrl', () => {
  test('strips the query, where OAuth codes and API tokens live', () => {
    const raw =
      'https://chat.liams.dev/auth/callback?code=SUPERSECRETCODE&state=abc&access_token=TOKENVALUE';

    const redacted = redactUrl(raw);

    expect(redacted).toBe('https://chat.liams.dev/auth/callback');
    expect(redacted).not.toContain('SUPERSECRETCODE');
    expect(redacted).not.toContain('TOKENVALUE');
    expect(redacted).not.toContain('?');
  });

  test('strips the fragment, where implicit-flow tokens live', () => {
    const redacted = redactUrl('https://chat.liams.dev/cb#access_token=TOKENVALUE&id_token=IDVALUE');

    expect(redacted).toBe('https://chat.liams.dev/cb');
    expect(redacted).not.toContain('TOKENVALUE');
    expect(redacted).not.toContain('IDVALUE');
    expect(redacted).not.toContain('#');
  });

  test('keeps enough to be useful in a log line', () => {
    /* Redaction that produced "<redacted>" would make every navigation-blocked
       warning identical and therefore useless. Scheme, host and path stay. */
    expect(redactUrl('https://github.com/juno/juno/pull/12?utm=x')).toBe(
      'https://github.com/juno/juno/pull/12',
    );
    expect(redactUrl('juno://app/settings?tab=code')).toBe('juno://app/settings');
  });

  test('keeps a non-default port, which distinguishes the dev server from production', () => {
    expect(redactUrl('http://localhost:5173/index.html?x=1')).toBe('http://localhost:5173/index.html');
  });

  test('does not throw on unparseable input', () => {
    for (const value of ['', 'not a url', '//x', null, undefined, 42]) {
      expect(() => redactUrl(value as unknown as string)).not.toThrow();
      expect(redactUrl(value as unknown as string)).toBe('<unparseable-url>');
    }
  });

  test('leaves nothing token-shaped behind for a URL that is all query', () => {
    const redacted = redactUrl('https://evil.example/?a=SECRET1&b=SECRET2#c=SECRET3');
    expect(redacted).toBe('https://evil.example/');
    for (const secret of ['SECRET1', 'SECRET2', 'SECRET3']) {
      expect(redacted).not.toContain(secret);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* webPreferences                                                              */
/* -------------------------------------------------------------------------- */

describe('SECURE_WEB_PREFERENCES', () => {
  test('isolates the renderer from Node', () => {
    expect(SECURE_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true);
    expect(SECURE_WEB_PREFERENCES.webviewTag).toBe(false);
  });

  test('closes the adjacent doors that inherit from nodeIntegration', () => {
    /* `nodeIntegration: false` does not imply these. A worker or a subframe can
       be granted Node independently, and each is reachable from a renderer that
       has already been compromised. */
    expect(SECURE_WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false);
    expect(SECURE_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false);
    expect(SECURE_WEB_PREFERENCES.webSecurity).toBe(true);
    expect(SECURE_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
    expect(SECURE_WEB_PREFERENCES.experimentalFeatures).toBe(false);
  });

  test('is frozen, so a window cannot be created with a mutated variant', () => {
    expect(Object.isFrozen(SECURE_WEB_PREFERENCES)).toBe(true);

    const mutable = SECURE_WEB_PREFERENCES as unknown as Record<string, unknown>;
    expect(() => {
      mutable['nodeIntegration'] = true;
    }).toThrow(TypeError);
    expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false);
  });

  test('every declared preference is a boolean, so none is accidentally a string', () => {
    /* `sandbox: 'true'` is truthy in JS and would read as enabled in review
       while Electron treats the object as malformed. */
    for (const [key, value] of Object.entries(SECURE_WEB_PREFERENCES)) {
      expect(typeof value, `${key} should be a boolean`).toBe('boolean');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Content-Security-Policy                                                     */
/* -------------------------------------------------------------------------- */

describe('CONTENT_SECURITY_POLICY', () => {
  const directives = new Map(
    CONTENT_SECURITY_POLICY.split(';').map((directive) => {
      const [name = '', ...rest] = directive.trim().split(/\s+/);
      return [name, rest.join(' ')] as const;
    }),
  );

  test('script-src allows nothing but the bundle', () => {
    expect(directives.get('script-src')).toBe("'self'");
  });

  test("script-src contains no 'unsafe-eval'", () => {
    expect(directives.get('script-src') ?? '').not.toContain("'unsafe-eval'");
  });

  test("script-src contains no 'unsafe-inline'", () => {
    /* The renderer runs React and a motion library; neither needs inline
       script, and permitting it would turn any injected string into code. */
    expect(directives.get('script-src') ?? '').not.toContain("'unsafe-inline'");
  });

  test("no directive anywhere permits 'unsafe-eval'", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });

  test('the only inline allowance is style-src, which is the documented exception', () => {
    const withUnsafeInline = [...directives.entries()]
      .filter(([, value]) => value.includes("'unsafe-inline'"))
      .map(([name]) => name);

    expect(withUnsafeInline).toEqual(['style-src']);
  });

  test('the dangerous sinks are closed', () => {
    expect(directives.get('default-src')).toBe("'none'");
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(directives.get('form-action')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
  });

  test('the renderer cannot originate network traffic', () => {
    /* This is what keeps bearer tokens out of the renderer: every backend call
       has to go through main over IPC, so a compromised renderer has no
       exfiltration channel of its own. */
    expect(directives.get('connect-src')).toBe("'self'");
  });

  test('no directive names a remote origin', () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:\/\//);
    expect(CONTENT_SECURITY_POLICY).not.toContain('*');
  });

  test('every directive is well formed', () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/;;/);
    for (const [name, value] of directives) {
      expect(name.length).toBeGreaterThan(0);
      expect(value.length, `${name} has no value`).toBeGreaterThan(0);
    }
  });
});
