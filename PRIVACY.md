# Anvil Privacy Policy

**Applies to:** Anvil v0.1.2 (desktop app) and the Anvil website at
<https://nssis.github.io/Anvil/>
**Last updated:** 2026-06-11
**Maintainer:** NssIs (<https://github.com/NssIs>).
Anvil is free, open-source software distributed worldwide.

## The short version

**Anvil has no servers, no accounts, no telemetry, no analytics, and no ads.
The maintainer never receives your personal data.** Everything you create
stays on your machine. The app only talks to the internet when *you* trigger
a feature that needs it, and each of those connections goes directly from
your computer to the third party listed below — never through us.

Because the source code is public, every claim in this policy can be
verified in the repository: <https://github.com/NssIs/Anvil>.

## Data stored on your machine (and only there)

Anvil stores its working data locally:

- **Projects, textures, and exports** — in the operating system's
  per-app data directory (e.g. `~/.local/share/com.anvil.app` on Linux,
  `%APPDATA%` on Windows, `~/Library/Application Support` on macOS) and in
  any export location you choose.
- **App state** (project list, shader files, editor settings) — in the
  embedded webview's local storage.
- **AI provider settings, including your API key** — in the embedded
  webview's local storage, **in plain text**. The key never leaves your
  machine except in requests to the AI provider you configured. If you stop
  using the AI assistant, you can clear it in the app's AI settings.
  Treat your Anvil data directory like any other folder containing secrets.

Uninstalling Anvil and deleting the app data directory removes all of this.
None of it is ever synced or uploaded by Anvil.

## Network connections the app makes

Each connection below is initiated from your computer and necessarily
exposes your **IP address** (and standard HTTP metadata) to the named
service. Anvil sends no identifiers, tracking IDs, or usage statistics with
any of these requests.

### 1. Update check — GitHub (automatic)

The built-in updater fetches release metadata and installers from
`github.com` (GitHub Releases of `NssIs/Anvil`). Updates are
cryptographically signed (minisign) and verified before installation.
GitHub's logging is governed by the
[GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement).

### 2. Vanilla texture download — Mojang (user-initiated)

When you pull vanilla textures for a Minecraft version, Anvil downloads the
version manifest and the official client jar from Mojang's servers
(`piston-meta.mojang.com` and related Mojang endpoints) — the same files the
official launcher fetches. Governed by the
[Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).

### 3. Contributors list — GitHub API (user-initiated)

The in-app credits view queries `api.github.com` for the public contributor
list of the Anvil repository.

### 4. AI assistant — your chosen provider (opt-in, off by default)

The AI assistant does nothing until you configure a provider and trigger a
request. When you do, Anvil sends **your prompt, relevant project context
(project and asset names), and — when you attach them or the feature requires
it — texture images** directly to the provider you selected:

| Provider | Endpoint | Who processes the data |
| --- | --- | --- |
| Ollama (local) | `http://127.0.0.1` (your machine) | Nobody — fully local |
| OpenRouter | `openrouter.ai` | [OpenRouter privacy policy](https://openrouter.ai/privacy) |
| Google AI Studio (Gemini) | `generativelanguage.googleapis.com` | [Google privacy policy](https://policies.google.com/privacy) |

You bring your own API key and your own provider agreement; the maintainer
has no relationship with, and receives nothing from, these requests. **Do
not send content to a cloud provider that you are not comfortable sharing
with that provider.** For fully private use, choose the local Ollama option.

### 5. The Anvil website

The landing page is hosted on **GitHub Pages**, which logs visitor IP
addresses for security purposes per the GitHub Privacy Statement. The page's
own script calls `api.github.com` once to display the latest release; the
site itself sets no cookies and runs no analytics.

## What Anvil never does

- No telemetry, crash reporting, analytics, or usage tracking
- No accounts, sign-ins, or device identifiers
- No selling, sharing, or monetization of data — there is no data to sell
- No bundled third-party SDKs that phone home

## GDPR notes (EU users)

Anvil processes your data **locally on your device**, under your control;
for that processing the maintainer is not a controller and the GDPR's
household/personal-use considerations generally apply. Where the app
connects to third parties at your request (GitHub, Mojang/Microsoft,
OpenRouter, Google), those parties act as independent controllers under
their own policies linked above. The maintainer collects and stores **no
personal data whatsoever**, so there is nothing for us to access, rectify,
delete, or port — your data is already in your hands, in plain files on
your disk.

Questions or concerns: open an issue at
<https://github.com/NssIs/Anvil/issues> or contact the maintainer via their
GitHub profile.

## Changes to this policy

This policy is versioned with the source code. Material changes (for
example, a new network feature) will be reflected here and noted in the
changelog before they ship in a release.
