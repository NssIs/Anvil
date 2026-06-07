# Anvil

Anvil is a desktop toolkit for Minecraft creators, built with [Tauri](https://tauri.app/)
(Rust) and a vanilla TypeScript front-end. Its first available workspace is a
fast texture-pack editor: create a pack, pull the vanilla textures for a chosen
Minecraft version, paint over the ones you want to change with a layered pixel
editor, and export a ready-to-use resource pack — only the textures you actually
edited are included in the export. Mod, shader, and plugin tooling are planned
next steps.

## Download

**[➜ Download from the Anvil site](https://nssis.github.io/Anvil/)** or grab an
installer straight from the [latest release](https://github.com/NssIs/Anvil/releases/latest):

| Platform | File |
| --- | --- |
| macOS | `.dmg` (universal) |
| Windows | `.exe` installer |
| Linux | `.AppImage` or `.deb` |

### Install

- **macOS** — open the `.dmg` and drag Anvil to Applications. The build isn't
  notarized yet, so the first launch needs right-click → Open.
- **Windows** — run the `.exe` installer (SmartScreen may warn on an unsigned
  build: More info → Run anyway).
- **Linux (AppImage)** — `chmod +x Anvil_*.AppImage && ./Anvil_*.AppImage`
- **Linux (Debian/Ubuntu)** — `sudo apt install ./Anvil_*.deb`

## Development

```bash
npm install
npm run dev        # browser preview (Vite, http://localhost:1420)
npm run tauri dev  # full desktop app (Rust backend + webview)
npm run build      # type-check + production build
```

Recommended IDE setup: [VS Code](https://code.visualstudio.com/) +
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) +
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).

## License

Anvil's source code is released under the [MIT License](./LICENSE) —
Copyright (c) 2026 NssIs. You are free to use, modify, and distribute the
**code**.

## Minecraft assets & trademark

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH
> MOJANG OR MICROSOFT.**

Minecraft is a trademark of Mojang Studios / Microsoft. Anvil is an
independent, fan-made tool and is not affiliated with, endorsed by, or
sponsored by Mojang or Microsoft.

The MIT license above applies to Anvil's own code **only**. It does not grant
any rights to Minecraft or its assets:

- **You need to own Minecraft.** Anvil downloads vanilla textures from Mojang's
  official client jar (the same files the launcher uses) for your own local use;
  it's intended for players who own the game.
- **Anvil ships no Minecraft assets.** Vanilla textures are downloaded from
  Mojang's official client jar to the user's own machine at runtime and are
  never bundled with this repository or its releases.
- **Mojang's default textures remain Mojang's copyright.** Per Mojang's
  [Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines), the
  default game assets are not redistributable. Anvil's export only writes the
  textures you have edited, and you are responsible for the content of any pack
  you create or share.
- Use of Anvil and any packs made with it must comply with the
  [Minecraft EULA](https://www.minecraft.net/en-us/eula) and
  [Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)
  (e.g. no selling packs of Mojang's assets).
