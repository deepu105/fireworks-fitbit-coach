# Verification

Checked November 2, 2026 with Node.js 25.9.0 and npm 11.12.1 on macOS.

| Check | Result |
| --- | --- |
| Clean dependency installation | Passed with npm ci |
| Type checking | Passed |
| Backend tests | 39 passed |
| Production build | Passed |
| Fresh Chrome browser checks | 11 passed |
| Setup payload generation | New and existing My Account API cases passed, including scope preservation and private file permissions |

The browser checks cover authentication, connection states, data display, explicit sharing, streamed suggestions, retry, disconnect cleanup, mobile layout, and Markdown rendering without raw HTML or remote images. A separate regression verifies the consent redirect chain. Backend checks cover report parsing/calculations, partial scopes, pagination, user-token isolation, SDK HTTP exchanges, and model tool streaming.

## Provider checks

Real Google Health authorization and Auth0 Token Vault retrieval succeeded with an account that had no recent readings. This verifies the authorization path; it does not verify populated real health measurements.

The complete report and inference flow passed with generated test readings, real Auth0, and real Fireworks using accounts/fireworks/models/kimi-k3 with thinking disabled. We checked displayed measurements, upstream token refresh, the forced summary tool call, a complete streamed answer, and sharing reset. The dashboard and suggestions screenshots show test readings and an actual Fireworks response. Other UI screenshots use intercepted test responses.

## Remaining checks

Compare populated Google Health measurements with their source account, repeat live isolation checks with two separate Auth0 users, and verify real provider revocation and reconnection. Automated fixtures cover narrower cases.

Node.js 22.12 is the declared minimum. This run does not establish compatibility with every supported Node.js version. Before serving other users, add API/inference quotas, complete applicable Google OAuth review, and review provider handling of health data.
