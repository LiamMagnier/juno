## Summary

<!-- Briefly explain what changed and why. Reference any related issues (e.g. Closes #123). -->

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Security fix
- [ ] Documentation update
- [ ] Refactoring / Chore

## Verification & Testing

<!-- Explain what checks were run locally and include their output where relevant. -->

- [ ] `npm run typecheck` (Node heap enlarged)
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] Native Swift checks if touching `native/` or `contracts/` (`npm run native:contract:check`)
- [ ] Manual test in browser or client (describe steps below)

### Verification Details:
```text
<!-- Paste relevant test output or notes here -->
```

## Security Considerations

- [ ] Does this change affect authorization, authentication, or user scoping (`userId`)?
- [ ] Does it touch `src/lib/message-crypto.ts`, `src/lib/crypto.ts`, or token storage?
- [ ] Are sensitive tokens/secrets protected from accidental logging?
