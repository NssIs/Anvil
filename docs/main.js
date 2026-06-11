// Populate the download buttons from the latest GitHub Release.
const REPO = "NssIs/Anvil";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const byId = (id) => document.getElementById(id);

const endsWithAny = (name, exts) => {
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
};

const pickAsset = (assets, exts) => assets.find((asset) => endsWithAny(asset.name, exts));

function detectOs() {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();

  if (/mac|iphone|ipad|ipod/.test(ua) || platform.startsWith("mac")) {
    return "mac";
  }

  if (/win/.test(ua) || platform.startsWith("win")) {
    return "windows";
  }

  if (/linux|x11|cros/.test(ua)) {
    return "linux";
  }

  return null;
}

function wireButton(button, meta, asset, fallbackMeta) {
  if (button) {
    button.href = asset ? asset.browser_download_url : RELEASES_PAGE;
    button.textContent = asset ? "Download" : "Releases";
  }

  if (meta) {
    meta.textContent = asset ? asset.name : fallbackMeta;
  }

  return asset;
}

function setNoRelease() {
  const line = byId("version-line");

  if (line) {
    line.innerHTML = `No release published yet — builds appear on the <a href="${RELEASES_PAGE}" target="_blank" rel="noopener">Releases page</a> once a version tag is pushed.`;
  }
}

async function loadReleases() {
  let data;

  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!response.ok) {
      setNoRelease();
      return;
    }

    data = await response.json();
  } catch (error) {
    console.warn("Could not load releases.", error);
    setNoRelease();
    return;
  }

  const assets = Array.isArray(data.assets) ? data.assets : [];

  const mac = wireButton(byId("mac-btn"), byId("mac-meta"), pickAsset(assets, [".dmg"]), "Universal · .dmg");
  const win = wireButton(
    byId("win-btn"),
    byId("win-meta"),
    pickAsset(assets, ["-setup.exe", ".exe"]) || pickAsset(assets, [".msi"]),
    "64-bit · .exe installer",
  );
  const linux = wireButton(
    byId("linux-btn"),
    byId("linux-meta"),
    pickAsset(assets, [".appimage"]) || pickAsset(assets, [".deb"]),
    ".appimage / .deb",
  );

  const line = byId("version-line");

  if (line) {
    const tag = data.tag_name || data.name || "latest";
    line.innerHTML = `Latest release: <strong>${tag}</strong> · <a href="${data.html_url || RELEASES_PAGE}" target="_blank" rel="noopener">release notes</a>`;
  }

  // Point the hero's primary button at the visitor's platform.
  const os = detectOs();
  const primary = byId("primary-download");
  const primaryLabel = byId("primary-label");
  const choice = os === "mac" ? mac : os === "windows" ? win : os === "linux" ? linux : null;
  const labels = { mac: "Download for macOS", windows: "Download for Windows", linux: "Download for Linux" };

  if (primary && choice) {
    primary.href = choice.browser_download_url;
  }

  if (primaryLabel && os) {
    primaryLabel.textContent = labels[os];
  }

  // Highlight the matching platform card.
  if (os) {
    document.querySelector(`.card[data-os="${os}"]`)?.classList.add("card--match");
  }
}

loadReleases();
