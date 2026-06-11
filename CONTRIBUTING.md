# Contributing to Anvil

Thanks for your interest in Anvil! This document covers how to contribute
and the project rules that keep releases sane. Anvil is MIT-licensed, and
contributors are welcome from anywhere.

## Ground rules

- **Licensing (inbound = outbound).** By submitting a contribution you
  agree it is your own work (or you have the right to submit it) and that
  it is licensed under the project's [MIT License](./LICENSE). No CLA, no
  copyright assignment — you keep your copyright.
- **Never commit Minecraft assets.** No vanilla textures, models, sounds,
  jars, or any Mojang-copyrighted content may enter this repository or its
  releases — not even in tests or fixtures. Anvil downloads such assets at
  runtime onto the user's machine only. See [ASSET_POLICY.md](./ASSET_POLICY.md).
- **No secrets.** Never commit API keys, tokens, or signing keys. The
  updater's *private* signing key in particular must never touch the repo.
- **AI-assisted contributions** are fine, but you are responsible for the
  result: review it, test it, and make sure it doesn't reproduce someone
  else's code or assets verbatim.
- Be respectful — the [Code of Conduct](./CODE_OF_CONDUCT.md) applies to
  all project spaces.

## Getting started

```bash
npm install
npm run dev        # browser preview (Vite, http://localhost:1420)
npm run tauri dev  # full desktop app (Rust backend + webview)
npm run build      # type-check + production build
```

The Rust backend lives in `src-tauri/`, the TypeScript front-end in `src/`,
the landing page in `docs/`, and the bundled shader pack in
`src-tauri/shaderpack/`.

## Pull requests

1. Open an issue first for anything non-trivial, so the approach can be
   agreed before you invest time.
2. Branch from `main`; keep PRs focused on one change.
3. `npm run build` must pass (TypeScript check + bundle), and
   `cargo test` in `src-tauri/` must pass.
4. Match the existing code style of the file you're editing; this project
   uses plain TypeScript and plain Rust — no new frameworks or heavy
   dependencies without prior discussion.
5. Update `changelog.md` under the unreleased section using the existing
   *Added / Changed / Fixed* format.

## Versioning and releases (maintainers)

- Versions follow `MAJOR.MINOR.PATCH`; pre-1.0, minor bumps may include
  breaking changes.
- A version bump must be kept in sync across **`package.json`,
  `package-lock.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json`** (and the version noted in `AGENTS.md`).
- Nothing is pushed or tagged until explicitly approved by the maintainer.
- A release is only "shipped" once installers for all platforms (macOS
  `.dmg`; Windows `.exe`/`.msi`; Linux `.AppImage`, `.deb`, `.rpm`) plus
  updater artifacts and signatures are built from the tagged commit,
  attached to the GitHub Release, and verified.
- Every release includes a changelog entry in the established format.

## Reporting bugs and requesting features

Use [GitHub Issues](https://github.com/NssIs/Anvil/issues). For security
vulnerabilities, **do not open a public issue** — follow
[SECURITY.md](./SECURITY.md) instead.
