# Anvil Asset, Content & Trademark Policy

**Applies to:** Anvil v0.1.2 · **Last updated:** 2026-06-11

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH
> MOJANG OR MICROSOFT.**

This document explains what Anvil's MIT license does and does not cover,
how Anvil handles Mojang's copyrighted assets, and what you — the user —
are responsible for. It applies to all users worldwide. It is an honest
statement of the project's position, not legal advice.

## 1. What the MIT license covers

The [MIT License](./LICENSE) covers **Anvil's own code and original
content**: the application source, the landing page, and the bundled
Anvil shader pack in `src-tauri/shaderpack/` (original GLSL written for
this project, targeting Iris). You may use, modify, and redistribute all
of it freely.

It grants **no rights whatsoever** to Minecraft, its assets, or its
trademarks.

## 2. Minecraft assets

- **Anvil ships none of Mojang's assets.** Neither this repository nor any
  release artifact contains vanilla textures, models, sounds, or game
  code. Contributions that add such files will be rejected
  (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
- **Runtime downloads go to your machine only.** When you pull vanilla
  textures, Anvil downloads Mojang's official client jar from Mojang's own
  servers — exactly the files the official launcher fetches — and extracts
  textures locally for your editing reference. Anvil is intended for
  players who **own Minecraft**.
- **Mojang's textures remain Mojang's copyright.** Per Mojang's
  [Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines),
  default game assets are not redistributable. To keep your exports clean,
  **Anvil's export includes only the textures you actually edited** —
  unmodified vanilla files are deliberately excluded from every pack Anvil
  produces.

## 3. Your content and your responsibility

- **You own what you make.** Textures you paint, packs you export, and
  shader configurations you build with Anvil are yours. Anvil claims no
  rights over them and never sees them (see [PRIVACY.md](./PRIVACY.md)).
- **You are responsible for what you share.** When you distribute a pack
  made with Anvil, you must comply with the
  [Minecraft EULA](https://www.minecraft.net/en-us/eula) and Usage
  Guidelines (for example: no selling packs consisting of Mojang's assets,
  no implying official status) plus the laws that apply to you and the
  rights of any third-party material you incorporated.
- **AI-assisted content.** If you use Anvil's optional AI assistant, the
  output's status depends on your AI provider's terms and your
  jurisdiction's law. Review generated content before distributing it; you
  are the publisher of anything you share.
- Derivative edits of Mojang textures (painting over a vanilla texture)
  are common, community-accepted resource-pack practice under Mojang's
  guidelines — but the underlying vanilla art remains Mojang's, and Mojang's
  rules govern its use.

## 4. Trademarks

- **"Minecraft"** is a trademark of Mojang Synergies AB / Microsoft. Anvil
  is an independent, fan-made tool and is not affiliated with, endorsed
  by, or sponsored by Mojang or Microsoft. Anvil uses the word "Minecraft"
  only to truthfully describe compatibility.
- **"Anvil"** names this project. If you fork it, you're welcome to keep
  the code (MIT), but please rename your distribution if it diverges, so
  users aren't confused about what they're installing — and do not present
  a fork as an official Mojang/Microsoft product.

## 5. Takedown requests

If you are a rights holder and believe something in this repository or its
releases infringes your rights, contact the maintainer via
<https://github.com/NssIs> or open an issue, and it will be addressed
promptly. GitHub's own
[DMCA process](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy)
is also available.
