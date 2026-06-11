# Anvil Security Policy

**Applies to:** Anvil v0.1.2 · **Last updated:** 2026-06-11

## Supported versions

Anvil is pre-1.0. Only the **latest release** receives security fixes.

| Version | Supported |
| --- | --- |
| Latest release (currently 0.1.2) | ✅ |
| Older releases | ❌ — please update |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

1. **Preferred:** use GitHub's private vulnerability reporting on the
   repository — <https://github.com/NssIs/Anvil/security/advisories/new>.
2. Alternatively, contact the maintainer privately via the details on
   their GitHub profile (<https://github.com/NssIs>).

Include what you can: affected version, platform, reproduction steps, and
impact. You can expect an acknowledgement within **7 days** and a status
update within **30 days**. Please allow up to **90 days** for a fix before
public disclosure; we will credit reporters in the release notes unless you
prefer otherwise. This is a volunteer-maintained project — there is no bug
bounty, but good-faith research on your own installation is welcome and
will never be met with legal threats.

### In scope

- The Anvil desktop app (TypeScript front-end and Rust/Tauri backend)
- The update mechanism and release artifacts
- The build/release pipeline in this repository
- The landing page code in `docs/`

### Out of scope

- Vulnerabilities in third-party services Anvil talks to (GitHub, Mojang,
  OpenRouter, Google) — report those to the respective vendor
- Issues requiring an already-compromised machine (e.g. reading Anvil's
  local files with local user privileges — see "Known limitations")
- Denial of service against your own installation

## How Anvil is secured today

- **Signed updates.** Updater artifacts are signed with a minisign key and
  the app verifies signatures before installing; update metadata is fetched
  over HTTPS from GitHub Releases only.
- **No servers.** Anvil has no backend; there is no account system,
  no stored user data, and no attack surface beyond the app itself.
- **Narrow native surface.** Tauri capabilities are limited to window
  controls, the updater, and process restart; the asset protocol is scoped
  to the app's own data directory.
- **Mojang downloads** come exclusively from official Mojang endpoints over
  HTTPS.

## Known limitations (current version)

Reported here for transparency; hardening these is on the roadmap:

- **Installers are not yet code-signed or notarized** (Windows SmartScreen
  and macOS Gatekeeper will warn). Verify downloads come from
  `github.com/NssIs/Anvil/releases` only. The in-app updater independently
  verifies the minisign signature even though OS-level signing is absent.
- **AI API keys are stored unencrypted** in the webview's local storage.
  Anyone with access to your OS user account can read them. Use scoped,
  revocable keys with spending limits, or the local Ollama provider.
- **No Content-Security-Policy is set** on the app webview yet. The app
  renders only local, bundled UI, but a CSP is planned as defense in depth.

## Dependency and supply-chain policy

- Dependencies are kept minimal (Tauri plus a handful of plugins; no
  runtime npm framework) and are updated with releases.
- Releases are built from tagged commits via the repository's GitHub
  Actions workflow; artifacts attached to a release correspond to that tag.
- `Cargo.lock` and `package-lock.json` are committed and authoritative.
