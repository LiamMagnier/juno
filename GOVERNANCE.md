# Juno Governance and Maintainership

This document outlines the governance and maintenance structure for the Juno project.

## Project Roles

### Benevolent Dictator / Primary Maintainer
- **Current Maintainer:** Liam Magnier ([@LiamMagnier](https://github.com/LiamMagnier))
- **Responsibilities:**
  - Overall architectural direction and roadmap decisions.
  - Reviewing and merging pull requests.
  - Cutting version tags and managing official production releases.
  - Security incident response and vulnerability disclosures.
  - Administrative control over repositories, domains (`liams.dev`, `chat.liams.dev`), and deployment secrets.

### Contributors
- Anyone who submits issues, pull requests, documentation improvements, or translations.
- Contributors agree to adhere to the [Code of Conduct](CODE_OF_CONDUCT.md) and licensing terms under [Apache-2.0](LICENSE).

## Decision-Making Process

1. **Bug fixes and minor improvements:** Can be approved and merged by any authorized maintainer once automated CI passes.
2. **Architectural, security, or breaking schema changes:**
   - Must be discussed in an issue or PR prior to implementation.
   - Requires explicit approval from the primary maintainer.
   - Must preserve or migrate backward compatibility with existing databases and native clients (`contracts/`).

## Communications and Support Policy

- **General discussions & questions:** Open an issue on GitHub with the `question` or `discussion` tag, or participate in GitHub Discussions when enabled.
- **Bug reports:** Use the [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.yml).
- **Feature ideas:** Use the [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.yml).
- **Security vulnerabilities:** Follow instructions in [SECURITY.md](SECURITY.md) (`security@liams.dev`). Do NOT report vulnerabilities via public issues.
