import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type AssetKind = "block" | "item" | "entity" | "other";
type Tool = "pencil" | "erase" | "picker" | "recolor" | "move";

type FloatingPixel = { relX: number; relY: number; color: string };
type MovePhase = "selecting" | "placed" | "moving";
type MoveState = {
  phase: MovePhase;
  rect: { x: number; y: number; w: number; h: number };
  floatingPixels: FloatingPixel[];
  offset: { x: number; y: number };
  dragStartPixel: { x: number; y: number };
  dragStartOffset: { x: number; y: number };
};

type Layer = {
  id: string;
  name: string;
  visible: boolean;
  pixels: Array<string | null>;
};

type EditorSnapshot = {
  layers: Layer[];
  activeLayerId: string;
};

type WorkspaceAsset = {
  id: string;
  name: string;
  kind: AssetKind;
  texturePath: string;
  previewPath?: string;
  previewUrl?: string;
  edited?: boolean;
  displayName?: string;
  display_name?: string;
  texture_path?: string;
  preview_path?: string;
  saved?: boolean;
};

type ExportResult =
  | string
  | {
      path: string;
      texture_count?: number;
      pack_format?: number;
    };

type SaveTextureResult =
  | string
  | {
      path?: string;
    };

type LoadTextureResult =
  | string
  | {
      png_base64?: string;
      pngBase64?: string;
    };

type TextureCacheProgress = {
  progress: number;
  stage: string;
  message: string;
  current?: number;
  total?: number;
};

type WorkspaceProject = {
  id?: string;
  name: string;
  version?: string;
  minecraftVersion?: string;
  packVersion?: string;
  author?: string;
  description?: string;
  iconDataUrl?: string;
};

type WorkspaceState = {
  assets: WorkspaceAsset[];
  activeFilter: "all" | AssetKind | "edited";
  query: string;
  project: WorkspaceProject;
  selectedAsset: WorkspaceAsset | null;
  editor: {
    tool: Tool;
    color: string;
    gridSize: number;
    brushSize: number;
    layers: Layer[];
    activeLayerId: string;
    history: EditorSnapshot[];
    dirty: boolean;
    drawing: boolean;
  };
};

const mockAssets: WorkspaceAsset[] = [
  { id: "block/stone", name: "Stone", kind: "block", texturePath: "block/stone.png" },
  { id: "block/grass_block_top", name: "Grass Block Top", kind: "block", texturePath: "block/grass_block_top.png" },
  { id: "block/diamond_block", name: "Diamond Block", kind: "block", texturePath: "block/diamond_block.png" },
  { id: "block/dirt", name: "Dirt", kind: "block", texturePath: "block/dirt.png" },
  { id: "block/oak_planks", name: "Oak Planks", kind: "block", texturePath: "block/oak_planks.png" },
  { id: "block/cobblestone", name: "Cobblestone", kind: "block", texturePath: "block/cobblestone.png" },
  { id: "block/glass", name: "Glass", kind: "block", texturePath: "block/glass.png" },
  { id: "block/diamond_ore", name: "Diamond Ore", kind: "block", texturePath: "block/diamond_ore.png" },
  { id: "block/deepslate", name: "Deepslate", kind: "block", texturePath: "block/deepslate.png" },
  { id: "item/diamond_sword", name: "Diamond Sword", kind: "item", texturePath: "item/diamond_sword.png" },
  { id: "item/iron_pickaxe", name: "Iron Pickaxe", kind: "item", texturePath: "item/iron_pickaxe.png" },
  { id: "item/apple", name: "Apple", kind: "item", texturePath: "item/apple.png" },
  { id: "item/bow", name: "Bow", kind: "item", texturePath: "item/bow.png" },
  { id: "item/ender_pearl", name: "Ender Pearl", kind: "item", texturePath: "item/ender_pearl.png" },
  { id: "item/golden_carrot", name: "Golden Carrot", kind: "item", texturePath: "item/golden_carrot.png" },
  { id: "item/totem_of_undying", name: "Totem of Undying", kind: "item", texturePath: "item/totem_of_undying.png" },
  { id: "item/redstone", name: "Redstone Dust", kind: "item", texturePath: "item/redstone.png" },
  { id: "entity/creeper/creeper", name: "Creeper", kind: "entity", texturePath: "entity/creeper/creeper.png" },
  { id: "entity/zombie/zombie", name: "Zombie", kind: "entity", texturePath: "entity/zombie/zombie.png" },
  { id: "entity/skeleton/skeleton", name: "Skeleton", kind: "entity", texturePath: "entity/skeleton/skeleton.png" },
  { id: "other/gui/widgets", name: "Widgets", kind: "other", texturePath: "gui/widgets.png" },
  { id: "other/gui/hotbar", name: "Hotbar", kind: "other", texturePath: "gui/hotbar.png" },
  { id: "other/gui/title/minecraft", name: "Title Logo", kind: "other", texturePath: "gui/title/minecraft.png" },
  { id: "other/painting/kebab", name: "Painting Kebab", kind: "other", texturePath: "painting/kebab.png" },
  { id: "other/misc/pumpkinblur", name: "Pumpkin Blur", kind: "other", texturePath: "misc/pumpkinblur.png" },
];

function normalizeAsset(raw: WorkspaceAsset): WorkspaceAsset {
  const displayName = raw.displayName ?? raw.display_name ?? raw.name;
  let texturePath = raw.texturePath ?? raw.texture_path ?? `${raw.kind}/${raw.name}.png`;

  // "other" is an internal bucket — Minecraft has no `other/` folder, so show
  // the real in-pack path (e.g. `gui/widgets.png`) instead of `other/gui/...`.
  if (raw.kind === "other" && texturePath.startsWith("other/")) {
    texturePath = texturePath.slice("other/".length);
  }

  const previewPath = raw.previewPath ?? raw.preview_path;

  return {
    id: raw.id,
    name: displayName,
    kind: raw.kind,
    texturePath,
    previewPath,
    previewUrl: pathToPreviewUrl(previewPath),
    edited: Boolean(raw.edited ?? raw.saved),
  };
}

function formatExportResult(result: ExportResult) {
  if (typeof result === "string") {
    return result;
  }

  const details = [
    result.texture_count !== undefined ? `${result.texture_count} textures` : "",
    result.pack_format !== undefined ? `format ${result.pack_format}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return details ? `${result.path} (${details})` : result.path;
}

function createPixels(size: number) {
  return Array.from<string | null>({ length: size * size }).fill(null);
}

let layerIdCounter = 0;

function createLayer(name: string, size: number): Layer {
  layerIdCounter += 1;
  return {
    id: `layer-${layerIdCounter}`,
    name,
    visible: true,
    pixels: createPixels(size),
  };
}

function cloneLayer(layer: Layer): Layer {
  return {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    pixels: [...layer.pixels],
  };
}

function compositeLayers(layers: Layer[], size: number) {
  const result = createPixels(size);

  // layers[0] is the top of the stack, so paint from the bottom up.
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];

    if (!layer.visible) {
      continue;
    }

    layer.pixels.forEach((color, pixelIndex) => {
      if (color) {
        result[pixelIndex] = color;
      }
    });
  }

  return result;
}

type Hsv = { h: number; s: number; v: number };

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b]
    .map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === red) {
      h = ((green - blue) / delta) % 6;
    } else if (max === green) {
      h = (blue - red) / delta + 2;
    } else {
      h = (red - green) / delta + 4;
    }

    h *= 60;

    if (h < 0) {
      h += 360;
    }
  }

  const s = max === 0 ? 0 : delta / max;
  return { h, s, v: max };
}

function hsvToRgb({ h, s, v }: Hsv) {
  const chroma = v * s;
  const hue = ((h % 360) + 360) % 360;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hue < 60) {
    [red, green, blue] = [chroma, x, 0];
  } else if (hue < 120) {
    [red, green, blue] = [x, chroma, 0];
  } else if (hue < 180) {
    [red, green, blue] = [0, chroma, x];
  } else if (hue < 240) {
    [red, green, blue] = [0, x, chroma];
  } else if (hue < 300) {
    [red, green, blue] = [x, 0, chroma];
  } else {
    [red, green, blue] = [chroma, 0, x];
  }

  return {
    r: (red + m) * 255,
    g: (green + m) * 255,
    b: (blue + m) * 255,
  };
}

function hsvToHex(hsv: Hsv) {
  const { r, g, b } = hsvToRgb(hsv);
  return rgbToHex(r, g, b);
}

type Hsl = { h: number; s: number; l: number };

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    if (max === red) {
      h = ((green - blue) / delta) % 6;
    } else if (max === green) {
      h = (blue - red) / delta + 2;
    } else {
      h = (red - green) / delta + 4;
    }

    h *= 60;

    if (h < 0) {
      h += 360;
    }
  }

  return { h, s, l };
}

function hslToHex({ h, s, l }: Hsl) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hue = ((h % 360) + 360) % 360;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hue < 60) {
    [red, green, blue] = [chroma, x, 0];
  } else if (hue < 120) {
    [red, green, blue] = [x, chroma, 0];
  } else if (hue < 180) {
    [red, green, blue] = [0, chroma, x];
  } else if (hue < 240) {
    [red, green, blue] = [0, x, chroma];
  } else if (hue < 300) {
    [red, green, blue] = [x, 0, chroma];
  } else {
    [red, green, blue] = [chroma, 0, x];
  }

  return rgbToHex((red + m) * 255, (green + m) * 255, (blue + m) * 255);
}

// Recolor a pixel to the target hue/saturation while keeping the original
// pixel's lightness — light pixels become a light tint of the target, dark
// pixels a dark shade, so the texture's shading is preserved.
function shadeRecolor(originalHex: string, targetHex: string) {
  const original = hexToRgb(originalHex);
  const target = hexToRgb(targetHex);
  const targetHsl = rgbToHsl(target.r, target.g, target.b);
  const originalHsl = rgbToHsl(original.r, original.g, original.b);

  return hslToHex({ h: targetHsl.h, s: targetHsl.s, l: originalHsl.l });
}

function pathToPreviewUrl(path?: string) {
  if (!path) {
    return "";
  }

  try {
    return convertFileSrc(path);
  } catch {
    return path.startsWith("/") ? `file://${path}` : path;
  }
}

function stripHtml(value = "") {
  const element = document.createElement("div");
  element.innerHTML = value;
  return element.textContent ?? "";
}

function ellipsize(value: string, max = 62) {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 3).trimEnd()}...` : trimmed;
}

async function callBackend<T>(command: string, args: Record<string, unknown>, fallback: () => T) {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    console.warn(`${command} fallback`, error);
    return fallback();
  }
}

export function initWorkspace() {
  const homeScreen = document.getElementById("home-screen");
  const workspaceScreen = document.getElementById("project-workspace");
  const shaderWorkspace = document.getElementById("shader-workspace");
  const assetGrid = document.getElementById("asset-grid");
  const assetSearch = document.getElementById("asset-search") as HTMLInputElement | null;
  const assetCount = document.getElementById("asset-count");
  const editedCount = document.getElementById("edited-count");
  const projectName = document.getElementById("workspace-project-name");
  const projectIcon = document.getElementById("workspace-project-icon");
  const workspaceStatus = document.getElementById("workspace-status");
  const textureLoading = document.getElementById("texture-loading");
  const textureLoadingStage = document.getElementById("texture-loading-stage");
  const textureLoadingPercent = document.getElementById("texture-loading-percent");
  const textureLoadingMessage = document.getElementById("texture-loading-message");
  const textureLoadingEta = document.getElementById("texture-loading-eta");
  const textureProgressBar = document.getElementById("texture-progress-bar");
  const exportModal = document.getElementById("export-modal");
  const exportVersion = document.getElementById("export-version") as HTMLInputElement | null;
  const exportPackName = document.getElementById("export-pack-name");
  const exportPackIcon = document.getElementById("export-pack-icon");
  const exportPackDescription = document.getElementById("export-pack-description");
  const exportPackMeta = document.getElementById("export-pack-meta");
  const editorDrawer = document.getElementById("editor-drawer");
  const editorTitle = document.getElementById("editor-title");
  const pixelCanvas = document.getElementById("pixel-canvas") as HTMLCanvasElement | null;
  const pixelCursor = document.getElementById("pixel-cursor");
  const drawColor = document.getElementById("draw-color") as HTMLInputElement | null;
  const colorPreview = document.getElementById("color-preview") as HTMLButtonElement | null;
  const colorPopover = document.getElementById("color-popover");
  const colorArea = document.getElementById("color-area");
  const colorAreaHandle = document.getElementById("color-area-handle");
  const colorHue = document.getElementById("color-hue");
  const colorHueHandle = document.getElementById("color-hue-handle");
  const gridSize = document.getElementById("grid-size") as HTMLInputElement | null;
  const brushSize = document.getElementById("brush-size") as HTMLInputElement | null;
  const layerList = document.getElementById("layer-list");
  const selectionOverlay = document.getElementById("selection-overlay");
  const toolTooltip = document.getElementById("tool-tooltip");
  const toolTooltipName = toolTooltip?.querySelector<HTMLElement>(".tool-tooltip-name") ?? null;
  const toolTooltipShortcut = toolTooltip?.querySelector<HTMLElement>(".tool-tooltip-shortcut") ?? null;
  const importFile = document.getElementById("import-file") as HTMLInputElement | null;
  const newTextureModal = document.getElementById("new-texture-modal");
  const newTextureName = document.getElementById("new-texture-name") as HTMLInputElement | null;
  const newTextureKind = document.getElementById("new-texture-kind");
  const newTextureKindTrigger = document.getElementById("new-texture-kind-trigger");
  const newTextureKindLabel = document.getElementById("new-texture-kind-label");
  const newTextureKindMenu = document.getElementById("new-texture-kind-menu");
  const newTexturePathValue = document.getElementById("new-texture-path-value");
  const newTextureStatus = document.getElementById("new-texture-status");
  let newTextureFolder = "block";
  let loadingStartedAt = 0;
  let editorColorHsv: Hsv = { h: 134, s: 0.66, v: 0.91 };

  const state: WorkspaceState = {
    assets: [],
    activeFilter: "all",
    query: "",
    project: {
      id: "preview",
      name: "Untitled Pack",
      minecraftVersion: "",
      packVersion: "1.0",
      author: "Me!",
      description: "",
    },
    selectedAsset: null,
    editor: {
      tool: "pencil",
      color: "#7ee787",
      gridSize: 16,
      brushSize: 1,
      layers: [],
      activeLayerId: "",
      history: [],
      dirty: false,
      drawing: false,
    },
  };

  const baseLayer = createLayer("Base", state.editor.gridSize);
  state.editor.layers = [baseLayer];
  state.editor.activeLayerId = baseLayer.id;

  const setStatus = (message: string) => {
    if (workspaceStatus) {
      workspaceStatus.textContent = message;
    }
  };

  const normalizeHexColor = (value: string) => {
    const trimmed = value.trim();
    const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;

    return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : "";
  };

  const positionColorHandles = (hex: string) => {
    if (colorArea) {
      colorArea.style.setProperty("--hue-color", hsvToHex({ h: editorColorHsv.h, s: 1, v: 1 }));
    }

    if (colorAreaHandle) {
      colorAreaHandle.style.left = `${clamp01(editorColorHsv.s) * 100}%`;
      colorAreaHandle.style.top = `${(1 - clamp01(editorColorHsv.v)) * 100}%`;
      colorAreaHandle.style.background = hex;
    }

    if (colorHueHandle) {
      colorHueHandle.style.left = `${(((editorColorHsv.h % 360) + 360) % 360) / 360 * 100}%`;
    }
  };

  const applyEditorColor = () => {
    const hex = hsvToHex(editorColorHsv);
    state.editor.color = hex;

    if (drawColor) {
      drawColor.value = hex;
      drawColor.classList.remove("input-invalid");
    }

    if (colorPreview) {
      colorPreview.style.setProperty("--active-color", hex);
    }

    positionColorHandles(hex);
  };

  const setEditorColor = (value: string) => {
    const color = normalizeHexColor(value);

    if (!color) {
      drawColor?.classList.add("input-invalid");
      return;
    }

    const { r, g, b } = hexToRgb(color);
    editorColorHsv = rgbToHsv(r, g, b);
    applyEditorColor();
  };

  const setColorPopoverOpen = (isOpen: boolean) => {
    colorPopover?.setAttribute("aria-hidden", String(!isOpen));
    colorPreview?.setAttribute("aria-expanded", String(isOpen));
  };

  const normalizeGridSize = () => {
    const raw = Number(gridSize?.value || 16);
    const clamped = Math.max(8, Math.min(128, Number.isFinite(raw) ? raw : 16));
    const snapped = Math.round(clamped / 8) * 8;

    if (gridSize) {
      gridSize.value = String(snapped);
    }

    return snapped;
  };

  const formatEta = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "Estimating time...";
    }

    if (seconds < 60) {
      return `About ${Math.ceil(seconds)}s left`;
    }

    return `About ${Math.ceil(seconds / 60)}m left`;
  };

  const setLoadingProgress = (payload: TextureCacheProgress) => {
    const progress = Math.max(0, Math.min(1, Number(payload.progress) || 0));
    const percent = Math.round(progress * 100);
    const elapsed = loadingStartedAt ? (performance.now() - loadingStartedAt) / 1000 : 0;
    const remaining = progress > 0.04 ? (elapsed / progress) * (1 - progress) : 0;

    textureLoading?.setAttribute("aria-hidden", "false");

    if (textureLoadingStage) {
      textureLoadingStage.textContent = payload.stage || "Pulling textures";
    }

    if (textureLoadingPercent) {
      textureLoadingPercent.textContent = `${percent}%`;
    }

    if (textureLoadingMessage) {
      textureLoadingMessage.textContent = payload.message || "Preparing Minecraft assets.";
    }

    if (textureLoadingEta) {
      textureLoadingEta.textContent = progress >= 1 ? "Done." : formatEta(remaining);
    }

    if (textureProgressBar) {
      textureProgressBar.style.width = `${percent}%`;
    }
  };

  const beginTextureLoading = (message: string) => {
    loadingStartedAt = performance.now();
    setLoadingProgress({
      progress: 0.01,
      stage: "Pulling textures",
      message,
    });
  };

  const endTextureLoading = () => {
    setLoadingProgress({
      progress: 1,
      stage: "Textures ready",
      message: "Minecraft textures are ready.",
    });

    window.setTimeout(() => {
      textureLoading?.setAttribute("aria-hidden", "true");
    }, 280);
  };

  const filteredAssets = () => {
    const query = state.query.toLowerCase().trim();

    return state.assets.filter((asset) => {
      const matchesQuery =
        !query ||
        asset.name.toLowerCase().includes(query) ||
        asset.id.toLowerCase().includes(query);
      const matchesFilter =
        state.activeFilter === "all" ||
        asset.kind === state.activeFilter ||
        (state.activeFilter === "edited" && asset.edited);

      return matchesQuery && matchesFilter;
    });
  };

  const renderStats = () => {
    if (assetCount) {
      assetCount.textContent = String(state.assets.length);
    }

    if (editedCount) {
      editedCount.textContent = String(state.assets.filter((asset) => asset.edited).length);
    }
  };

  const loadTextureDataUrl = async (asset: WorkspaceAsset) => {
    if (!state.project.minecraftVersion && !state.project.version) {
      return "";
    }

    const loaded = await callBackend<LoadTextureResult>(
      "load_texture",
      {
        projectId: state.project.id || "preview",
        assetId: asset.id,
        version: state.project.minecraftVersion || state.project.version || "1.21.6",
      },
      () => "",
    );

    const pngBase64 =
      typeof loaded === "string" ? loaded : loaded.png_base64 ?? loaded.pngBase64 ?? "";

    return pngBase64 ? `data:image/png;base64,${pngBase64}` : "";
  };

  const renderAssetGrid = () => {
    if (!assetGrid) {
      return;
    }

    const assets = filteredAssets();
    assetGrid.classList.remove("asset-grid--fade");
    void assetGrid.offsetWidth;
    assetGrid.classList.add("asset-grid--fade");
    assetGrid.textContent = "";

    if (!assets.length) {
      const empty = document.createElement("p");
      empty.className = "asset-empty";
      empty.textContent = "No assets match that search.";
      assetGrid.append(empty);
      return;
    }

    assets.forEach((asset) => {
      const tile = document.createElement("button");
      tile.className = asset.edited ? "asset-tile asset-tile--edited" : "asset-tile";
      tile.type = "button";
      tile.dataset.assetId = asset.id;
      const preview = document.createElement("span");
      preview.className = asset.previewUrl ? "asset-preview" : "asset-preview asset-preview--missing";

      if (asset.previewUrl) {
        const image = document.createElement("img");
        image.src = asset.previewUrl;
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => {
          if (image.dataset.fallback === "1") {
            image.remove();
            preview.classList.add("asset-preview--missing");
            return;
          }

          image.dataset.fallback = "1";
          void loadTextureDataUrl(asset).then((fallbackUrl) => {
            if (fallbackUrl) {
              image.src = fallbackUrl;
            } else {
              image.remove();
              preview.classList.add("asset-preview--missing");
            }
          });
        });
        preview.append(image);
      }

      const name = document.createElement("span");
      name.className = "asset-name";
      name.textContent = asset.name;

      const path = document.createElement("small");
      path.textContent = asset.texturePath;

      tile.append(preview, name, path);
      tile.addEventListener("click", () => selectAsset(asset));
      tile.addEventListener("dblclick", () => {
        void openEditor(asset);
      });
      assetGrid.append(tile);
    });
  };

  const renderWorkspace = () => {
    if (projectName) {
      projectName.textContent = state.project.name;
    }

    if (projectIcon) {
      projectIcon.textContent = state.project.iconDataUrl ? "" : "TP";
      projectIcon.style.backgroundImage = state.project.iconDataUrl
        ? `url("${state.project.iconDataUrl}")`
        : "";
    }

    renderStats();
    renderAssetGrid();
  };

  const loadAssets = async () => {
    const minecraftVersion = state.project.minecraftVersion || state.project.version || "";
    beginTextureLoading(`Pulling Minecraft ${minecraftVersion || "project"} textures.`);

    try {
      const projectId = state.project.id || "preview";
      const assets = minecraftVersion
        ? await callBackend<WorkspaceAsset[]>(
            "cache_vanilla_textures",
            { projectId, version: minecraftVersion },
            () => mockAssets,
          )
        : await callBackend<WorkspaceAsset[]>("list_assets", { projectId }, () => mockAssets);
      state.assets = assets.map(normalizeAsset);
      renderWorkspace();
      setStatus(`${state.assets.length} assets ready. Double-click an asset to edit.`);
    } finally {
      endTextureLoading();
    }
  };

  const selectAsset = (asset: WorkspaceAsset) => {
    state.selectedAsset = asset;
    setStatus("Double-click to edit.");
  };

  const layerThumbs = new Map<string, HTMLCanvasElement>();

  const activeLayer = () =>
    state.editor.layers.find((layer) => layer.id === state.editor.activeLayerId) ??
    state.editor.layers[0];

  const drawPixelsToContext = (
    context: CanvasRenderingContext2D,
    pixels: Array<string | null>,
    size: number,
  ) => {
    context.clearRect(0, 0, size, size);
    pixels.forEach((color, index) => {
      if (!color) {
        return;
      }

      context.fillStyle = color;
      context.fillRect(index % size, Math.floor(index / size), 1, 1);
    });
  };

  const refreshLayerThumbs = () => {
    const size = state.editor.gridSize;

    state.editor.layers.forEach((layer) => {
      const canvas = layerThumbs.get(layer.id);

      if (!canvas) {
        return;
      }

      if (canvas.width !== size) {
        canvas.width = size;
        canvas.height = size;
      }

      const context = canvas.getContext("2d");

      if (context) {
        drawPixelsToContext(context, layer.pixels, size);
      }
    });
  };

  let dragLayerId: string | null = null;
  let dragOrderBefore: string[] = [];
  let moveState: MoveState | null = null;

  const updateSelectionOverlay = () => {
    if (!selectionOverlay || !pixelCanvas) {
      return;
    }

    if (!moveState) {
      selectionOverlay.style.opacity = "0";
      return;
    }

    const canvasRect = pixelCanvas.getBoundingClientRect();
    const cell = canvasRect.width / state.editor.gridSize;
    let { x, y, w, h } = moveState.rect;

    if (moveState.phase !== "selecting") {
      x += moveState.offset.x;
      y += moveState.offset.y;
    }

    selectionOverlay.style.left = `${pixelCanvas.offsetLeft + x * cell}px`;
    selectionOverlay.style.top = `${pixelCanvas.offsetTop + y * cell}px`;
    selectionOverlay.style.width = `${w * cell}px`;
    selectionOverlay.style.height = `${h * cell}px`;
    selectionOverlay.style.opacity = "1";
  };

  const commitMoveState = () => {
    if (!moveState) {
      return;
    }

    const layer = activeLayer();
    const size = state.editor.gridSize;

    moveState.floatingPixels.forEach((fp) => {
      const fx = moveState!.rect.x + fp.relX + moveState!.offset.x;
      const fy = moveState!.rect.y + fp.relY + moveState!.offset.y;

      if (fx >= 0 && fy >= 0 && fx < size && fy < size) {
        layer.pixels[fy * size + fx] = fp.color;
      }
    });

    state.editor.dirty = true;
    moveState = null;
    updateSelectionOverlay();
  };

  const onLayerDragMove = (event: PointerEvent) => {
    if (!dragLayerId) {
      return;
    }

    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-layer-id]");
    const overId = target?.dataset.layerId;

    if (!overId || overId === dragLayerId) {
      return;
    }

    const from = state.editor.layers.findIndex((layer) => layer.id === dragLayerId);
    const to = state.editor.layers.findIndex((layer) => layer.id === overId);

    if (from < 0 || to < 0) {
      return;
    }

    const [moved] = state.editor.layers.splice(from, 1);
    state.editor.layers.splice(to, 0, moved);
    renderLayers();
    renderPixels();
  };

  const onLayerDragEnd = () => {
    document.removeEventListener("pointermove", onLayerDragMove);

    if (dragLayerId) {
      const orderAfter = state.editor.layers.map((layer) => layer.id);
      const changed = orderAfter.some((id, index) => id !== dragOrderBefore[index]);

      if (changed) {
        // Record the pre-drag order so the reorder is undoable.
        const restored = dragOrderBefore
          .map((id) => state.editor.layers.find((layer) => layer.id === id))
          .filter((layer): layer is Layer => Boolean(layer));
        const snapshot: EditorSnapshot = {
          layers: restored.map(cloneLayer),
          activeLayerId: state.editor.activeLayerId,
        };
        state.editor.history = [...state.editor.history.slice(-24), snapshot];
        state.editor.dirty = true;
      }
    }

    dragLayerId = null;
    document
      .querySelectorAll<HTMLElement>(".layer-row.is-dragging")
      .forEach((row) => row.classList.remove("is-dragging"));
  };

  const renderLayers = () => {
    if (!layerList) {
      return;
    }

    layerThumbs.clear();
    layerList.textContent = "";

    state.editor.layers.forEach((layer) => {
      const row = document.createElement("div");
      row.className = "layer-row";

      if (layer.id === state.editor.activeLayerId) {
        row.classList.add("is-active");
      }

      if (layer.id === dragLayerId) {
        row.classList.add("is-dragging");
      }

      row.dataset.layerId = layer.id;
      row.setAttribute("role", "listitem");

      const thumb = document.createElement("canvas");
      thumb.className = "layer-thumb";
      thumb.dataset.thumbId = layer.id;
      layerThumbs.set(layer.id, thumb);

      const name = document.createElement("span");
      name.className = "layer-name";
      name.textContent = layer.name;
      name.title = "Double-click to rename";

      const visibility = document.createElement("button");
      visibility.type = "button";
      visibility.className = layer.visible
        ? "layer-icon-button"
        : "layer-icon-button is-hidden";
      visibility.textContent = layer.visible ? "👁" : "🚫";
      visibility.title = layer.visible ? "Hide layer" : "Show layer";
      visibility.setAttribute("aria-label", visibility.title);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "layer-icon-button layer-icon-button--delete";
      remove.textContent = "🗑";
      remove.title = "Delete layer";
      remove.setAttribute("aria-label", "Delete layer");
      remove.disabled = state.editor.layers.length <= 1;

      visibility.addEventListener("pointerdown", (event) => event.stopPropagation());
      visibility.addEventListener("click", (event) => {
        event.stopPropagation();
        layer.visible = !layer.visible;
        state.editor.dirty = true;
        renderLayers();
        renderPixels();
      });

      remove.addEventListener("pointerdown", (event) => event.stopPropagation());
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteLayer(layer.id);
      });

      name.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        const next = window.prompt("Rename layer", layer.name);

        if (next && next.trim()) {
          layer.name = next.trim().slice(0, 24);
          renderLayers();
          renderPixels();
        }
      });

      row.addEventListener("pointerdown", (event) => {
        if ((event.target as HTMLElement).closest("button")) {
          return;
        }

        state.editor.activeLayerId = layer.id;
        dragLayerId = layer.id;
        dragOrderBefore = state.editor.layers.map((entry) => entry.id);
        document.addEventListener("pointermove", onLayerDragMove);
        document.addEventListener("pointerup", onLayerDragEnd, { once: true });
        renderLayers();
      });

      row.append(thumb, name, visibility, remove);
      layerList.append(row);
    });

    refreshLayerThumbs();
  };

  const renderPixels = () => {
    if (!pixelCanvas) {
      return;
    }

    const context = pixelCanvas.getContext("2d");

    if (!context) {
      return;
    }

    const size = state.editor.gridSize;
    pixelCanvas.width = size;
    pixelCanvas.height = size;
    drawPixelsToContext(context, compositeLayers(state.editor.layers, size), size);

    if (moveState && moveState.floatingPixels.length > 0) {
      moveState.floatingPixels.forEach((fp) => {
        const fx = moveState!.rect.x + fp.relX + moveState!.offset.x;
        const fy = moveState!.rect.y + fp.relY + moveState!.offset.y;

        if (fx >= 0 && fy >= 0 && fx < size && fy < size) {
          context.fillStyle = fp.color;
          context.fillRect(fx, fy, 1, 1);
        }
      });
    }

    refreshLayerThumbs();
  };

  const addLayer = () => {
    pushHistory();
    const layer = createLayer(`Layer ${state.editor.layers.length + 1}`, state.editor.gridSize);
    state.editor.layers.unshift(layer);
    state.editor.activeLayerId = layer.id;
    state.editor.dirty = true;
    renderLayers();
    renderPixels();
  };

  const deleteLayer = (id: string) => {
    if (state.editor.layers.length <= 1) {
      return;
    }

    pushHistory();
    const index = state.editor.layers.findIndex((layer) => layer.id === id);
    state.editor.layers = state.editor.layers.filter((layer) => layer.id !== id);

    if (state.editor.activeLayerId === id) {
      const fallback = state.editor.layers[Math.max(0, index - 1)] ?? state.editor.layers[0];
      state.editor.activeLayerId = fallback?.id ?? "";
    }

    state.editor.dirty = true;
    renderLayers();
    renderPixels();
  };

  const loadImage = async (source: string) => {
    if (!source) {
      return null;
    }

    const image = new Image();
    image.decoding = "async";
    image.crossOrigin = "anonymous";
    image.src = source;

    try {
      await new Promise<void>((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => reject(new Error("Texture preview failed to load.")), {
          once: true,
        });
      });
    } catch {
      return null;
    }

    return image;
  };

  const imagePixels = (image: HTMLImageElement, size: number): Array<string | null> | null => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      return null;
    }

    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, size, size);
    context.drawImage(image, 0, 0, size, size);

    try {
      const { data } = context.getImageData(0, 0, size, size);
      return Array.from({ length: size * size }, (_, index) => {
        const offset = index * 4;
        const alpha = data[offset + 3];

        if (alpha < 8) {
          return null;
        }

        return `#${[data[offset], data[offset + 1], data[offset + 2]]
          .map((channel) => channel.toString(16).padStart(2, "0"))
          .join("")}`;
      });
    } catch {
      return null;
    }
  };

  const imageSourceToPixels = async (source: string, size: number) => {
    const image = await loadImage(source);
    return image ? imagePixels(image, size) : null;
  };

  const loadAssetImage = async (asset: WorkspaceAsset) => {
    let source = await loadTextureDataUrl(asset);

    if (!source && asset.previewUrl) {
      source = asset.previewUrl;
    }

    return loadImage(source);
  };

  // Pick the editing resolution from the texture's real pixel size so we never
  // downscale (e.g. a 16x16 stays 16x16, a 32x32 HD texture stays 32x32).
  const nativeGridSize = (image: HTMLImageElement) => {
    const natural = Math.max(image.naturalWidth, image.naturalHeight);

    if (!natural) {
      return state.editor.gridSize;
    }

    return Math.max(8, Math.min(128, natural));
  };

  const snapshotEditor = (): EditorSnapshot => ({
    layers: state.editor.layers.map(cloneLayer),
    activeLayerId: state.editor.activeLayerId,
  });

  const pushHistory = () => {
    state.editor.history = [...state.editor.history.slice(-24), snapshotEditor()];
  };

  const restoreSnapshot = (snapshot: EditorSnapshot) => {
    state.editor.layers = snapshot.layers.map(cloneLayer);
    state.editor.activeLayerId =
      state.editor.layers.find((layer) => layer.id === snapshot.activeLayerId)?.id ??
      state.editor.layers[0]?.id ??
      "";
    renderLayers();
    renderPixels();
  };

  const pixelFromEvent = (event: PointerEvent) => {
    if (!pixelCanvas) {
      return null;
    }

    const rect = pixelCanvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * state.editor.gridSize);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * state.editor.gridSize);

    if (x < 0 || y < 0 || x >= state.editor.gridSize || y >= state.editor.gridSize) {
      return null;
    }

    return { x, y };
  };

  const brushOrigin = (center: number) => center - Math.floor((state.editor.brushSize - 1) / 2);

  const applyTool = (x: number, y: number) => {
    const size = state.editor.gridSize;

    if (state.editor.tool === "picker") {
      // The eyedropper always samples a single pixel, regardless of brush size.
      const color = compositeLayers(state.editor.layers, size)[y * size + x];

      if (color) {
        setEditorColor(color);
      }

      return;
    }

    const layer = activeLayer();

    if (!layer) {
      return;
    }

    if (!layer.visible) {
      layer.visible = true;
      renderLayers();
    }

    const startX = brushOrigin(x);
    const startY = brushOrigin(y);
    let changed = false;

    for (let dy = 0; dy < state.editor.brushSize; dy += 1) {
      for (let dx = 0; dx < state.editor.brushSize; dx += 1) {
        const px = startX + dx;
        const py = startY + dy;

        if (px < 0 || py < 0 || px >= size || py >= size) {
          continue;
        }

        const index = py * size + px;

        if (state.editor.tool === "recolor") {
          // Only recolor existing pixels, preserving their shading; skip transparent ones.
          const existing = layer.pixels[index];

          if (existing) {
            layer.pixels[index] = shadeRecolor(existing, state.editor.color);
            changed = true;
          }
        } else {
          layer.pixels[index] = state.editor.tool === "erase" ? null : state.editor.color;
          changed = true;
        }
      }
    }

    if (changed) {
      state.editor.dirty = true;
      renderPixels();
    }
  };

  const resetEditorLayers = (size: number) => {
    const layer = createLayer("Base", size);
    state.editor.layers = [layer];
    state.editor.activeLayerId = layer.id;
    state.editor.history = [];
  };

  const setGridSize = (size: number) => {
    state.editor.gridSize = size;

    if (gridSize) {
      gridSize.value = String(size);
    }
  };

  const openEditor = async (asset: WorkspaceAsset) => {
    moveState = null;
    updateSelectionOverlay();
    selectAsset(asset);
    setGridSize(normalizeGridSize());
    resetEditorLayers(state.editor.gridSize);
    state.editor.dirty = false;
    workspaceScreen?.classList.add("editor-open");
    editorDrawer?.setAttribute("aria-hidden", "false");

    if (editorTitle) {
      editorTitle.textContent = asset.name;
    }

    const image = await loadAssetImage(asset);

    if (image) {
      // Match the canvas to the texture's real resolution before reading it.
      setGridSize(nativeGridSize(image));
      resetEditorLayers(state.editor.gridSize);
      const pixels = imagePixels(image, state.editor.gridSize);

      if (pixels) {
        state.editor.layers[0].pixels = pixels;
      }
    }

    renderLayers();
    renderPixels();
  };

  const closeEditor = () => {
    editorDrawer?.setAttribute("aria-hidden", "true");
    workspaceScreen?.classList.remove("editor-open");
  };

  const canvasToBase64 = () => {
    if (!pixelCanvas) {
      return "";
    }

    return pixelCanvas.toDataURL("image/png").split(",")[1] ?? "";
  };

  const saveTexture = async () => {
    if (!state.selectedAsset) {
      setStatus("Select an asset before saving.");
      return;
    }

    if (moveState) {
      commitMoveState();
    }

    renderPixels();
    const pngBase64 = canvasToBase64();

    const output = await callBackend<SaveTextureResult>(
      "save_texture",
      {
        projectId: state.project.id || "preview",
        assetId: state.selectedAsset.id,
        pngBase64,
      },
      () => "browser-preview",
    );

    state.selectedAsset.edited = true;
    const savedPath = typeof output === "string" ? "" : output.path ?? "";
    state.selectedAsset.previewPath = savedPath || state.selectedAsset.previewPath;
    state.selectedAsset.previewUrl = savedPath
      ? pathToPreviewUrl(savedPath)
      : `data:image/png;base64,${pngBase64}`;
    state.editor.dirty = false;
    setStatus("Texture saved.");
    renderWorkspace();
    closeEditor();
  };

  const renderExportPreview = () => {
    const packVersion = exportVersion?.value.trim() || state.project.packVersion || "1.0";
    const author = state.project.author?.trim() || "Me!";
    const description =
      ellipsize(stripHtml(state.project.description) || "A clean texture pack for survival worlds.") ||
      "A clean texture pack for survival worlds.";

    if (exportPackName) {
      exportPackName.textContent = state.project.name;
    }

    if (exportPackDescription) {
      exportPackDescription.textContent = description;
    }

    if (exportPackMeta) {
      exportPackMeta.textContent = `${author} ° ${packVersion}`;
    }

    if (exportPackIcon) {
      exportPackIcon.textContent = "";

      if (state.project.iconDataUrl) {
        const image = document.createElement("img");
        image.src = state.project.iconDataUrl;
        image.alt = "";
        exportPackIcon.append(image);
      } else {
        exportPackIcon.textContent = "TP";
      }
    }
  };

  const openExportModal = () => {
    if (exportVersion && !exportVersion.value.trim()) {
      exportVersion.value = state.project.packVersion || "1.0";
    }

    renderExportPreview();
    exportModal?.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => exportVersion?.focus());
  };

  const closeExportModal = () => {
    exportModal?.setAttribute("aria-hidden", "true");
  };

  const exportPack = async () => {
    const packVersion = exportVersion?.value.trim();

    if (!packVersion) {
      setStatus("Enter a pack version before exporting.");
      exportVersion?.focus();
      return;
    }

    state.project.packVersion = packVersion;
    setStatus("Choose where to export the resource pack...");

    const confirmButton = document.getElementById("confirm-export") as HTMLButtonElement | null;
    const previousLabel = confirmButton?.textContent ?? "Export pack";

    if (confirmButton) {
      confirmButton.disabled = true;
      confirmButton.textContent = "Exporting...";
    }

    try {
      const output = await invoke<ExportResult>("export_pack", {
        projectId: state.project.id || "preview",
        version: state.project.minecraftVersion || state.project.version || "1.21.6",
        packVersion,
        name: state.project.name,
        author: state.project.author || "Me!",
        description: stripHtml(state.project.description),
        iconBase64: state.project.iconDataUrl || "",
      });
      closeExportModal();
      setStatus(`Export complete: ${formatExportResult(output)}`);
    } catch (error) {
      const message = String(error);

      if (message.includes("cancelled")) {
        setStatus("Export cancelled.");
        return;
      }

      console.error("export_pack failed", error);
      setStatus("Export failed. Check the console for details.");
    } finally {
      if (confirmButton) {
        confirmButton.disabled = false;
        confirmButton.textContent = previousLabel;
      }
    }
  };

  const hidePixelCursor = () => {
    if (pixelCursor) {
      pixelCursor.style.opacity = "0";
    }
  };

  const updatePixelCursor = (event: PointerEvent) => {
    if (!pixelCanvas || !pixelCursor) {
      return;
    }

    if (state.editor.tool === "move") {
      hidePixelCursor();
      return;
    }

    const pixel = pixelFromEvent(event);

    if (!pixel) {
      hidePixelCursor();
      return;
    }

    const rect = pixelCanvas.getBoundingClientRect();
    const cell = rect.width / state.editor.gridSize;
    const span = state.editor.tool === "picker" ? 1 : state.editor.brushSize;
    const startX = state.editor.tool === "picker" ? pixel.x : brushOrigin(pixel.x);
    const startY = state.editor.tool === "picker" ? pixel.y : brushOrigin(pixel.y);

    pixelCursor.style.width = `${cell * span}px`;
    pixelCursor.style.height = `${cell * span}px`;
    pixelCursor.style.left = `${pixelCanvas.offsetLeft + startX * cell}px`;
    pixelCursor.style.top = `${pixelCanvas.offsetTop + startY * cell}px`;
    pixelCursor.dataset.tool = state.editor.tool;
    pixelCursor.style.opacity = "1";
  };

  pixelCanvas?.addEventListener("contextmenu", (event) => event.preventDefault());
  pixelCanvas?.addEventListener("pointermove", updatePixelCursor);
  pixelCanvas?.addEventListener("pointerenter", updatePixelCursor);
  pixelCanvas?.addEventListener("pointerleave", hidePixelCursor);
  pixelCanvas?.addEventListener("pointerdown", (event) => {
    const pixel = pixelFromEvent(event);

    if (!pixel || !pixelCanvas) {
      return;
    }

    if (state.editor.tool === "move") {
      if (!moveState || moveState.phase === "selecting") {
        pushHistory();
        moveState = {
          phase: "selecting",
          rect: { x: pixel.x, y: pixel.y, w: 1, h: 1 },
          floatingPixels: [],
          offset: { x: 0, y: 0 },
          dragStartPixel: pixel,
          dragStartOffset: { x: 0, y: 0 },
        };
        state.editor.drawing = true;
        pixelCanvas.setPointerCapture(event.pointerId);
        updateSelectionOverlay();
      } else if (moveState.phase === "placed") {
        const rx = moveState.rect.x + moveState.offset.x;
        const ry = moveState.rect.y + moveState.offset.y;
        const inside =
          pixel.x >= rx &&
          pixel.x < rx + moveState.rect.w &&
          pixel.y >= ry &&
          pixel.y < ry + moveState.rect.h;

        if (inside) {
          moveState.phase = "moving";
          moveState.dragStartPixel = pixel;
          moveState.dragStartOffset = { ...moveState.offset };
          state.editor.drawing = true;
          pixelCanvas.setPointerCapture(event.pointerId);
        } else {
          commitMoveState();
          renderPixels();
          pushHistory();
          moveState = {
            phase: "selecting",
            rect: { x: pixel.x, y: pixel.y, w: 1, h: 1 },
            floatingPixels: [],
            offset: { x: 0, y: 0 },
            dragStartPixel: pixel,
            dragStartOffset: { x: 0, y: 0 },
          };
          state.editor.drawing = true;
          pixelCanvas.setPointerCapture(event.pointerId);
          updateSelectionOverlay();
        }
      }

      return;
    }

    state.editor.drawing = true;

    if (state.editor.tool !== "picker") {
      pushHistory();
    }

    pixelCanvas.setPointerCapture(event.pointerId);
    applyTool(pixel.x, pixel.y);
  });
  pixelCanvas?.addEventListener("pointermove", (event) => {
    if (state.editor.tool === "move") {
      if (!moveState || !state.editor.drawing) {
        return;
      }

      const pixel = pixelFromEvent(event);

      if (!pixel) {
        return;
      }

      if (moveState.phase === "selecting") {
        const startX = moveState.dragStartPixel.x;
        const startY = moveState.dragStartPixel.y;
        const x = Math.min(startX, pixel.x);
        const y = Math.min(startY, pixel.y);
        const w = Math.abs(pixel.x - startX) + 1;
        const h = Math.abs(pixel.y - startY) + 1;
        moveState.rect = { x, y, w, h };
        updateSelectionOverlay();
      } else if (moveState.phase === "moving") {
        const dx = pixel.x - moveState.dragStartPixel.x;
        const dy = pixel.y - moveState.dragStartPixel.y;
        moveState.offset = {
          x: moveState.dragStartOffset.x + dx,
          y: moveState.dragStartOffset.y + dy,
        };
        renderPixels();
        updateSelectionOverlay();
      }

      return;
    }

    if (!state.editor.drawing) {
      return;
    }

    const pixel = pixelFromEvent(event);

    if (pixel) {
      applyTool(pixel.x, pixel.y);
    }
  });
  pixelCanvas?.addEventListener("pointerup", () => {
    if (state.editor.tool === "move" && moveState) {
      if (moveState.phase === "selecting") {
        state.editor.drawing = false;

        if (moveState.rect.w > 0 && moveState.rect.h > 0) {
          const layer = activeLayer();
          const size = state.editor.gridSize;
          const { x, y, w, h } = moveState.rect;
          const floating: FloatingPixel[] = [];

          for (let dy = 0; dy < h; dy += 1) {
            for (let dx = 0; dx < w; dx += 1) {
              const px = x + dx;
              const py = y + dy;
              const idx = py * size + px;
              const color = layer.pixels[idx];

              if (color) {
                floating.push({ relX: dx, relY: dy, color });
                layer.pixels[idx] = null;
              }
            }
          }

          moveState.phase = "placed";
          moveState.floatingPixels = floating;
          state.editor.dirty = true;
          renderPixels();
          updateSelectionOverlay();
        } else {
          moveState = null;
          updateSelectionOverlay();
        }
      } else if (moveState.phase === "moving") {
        moveState.phase = "placed";
        state.editor.drawing = false;
      }

      return;
    }

    state.editor.drawing = false;
  });
  pixelCanvas?.addEventListener("pointercancel", () => {
    if (state.editor.tool === "move" && moveState) {
      if (moveState.phase === "moving") {
        moveState.offset = { ...moveState.dragStartOffset };
        moveState.phase = "placed";
        renderPixels();
        updateSelectionOverlay();
      } else if (moveState.phase === "selecting") {
        moveState = null;
        updateSelectionOverlay();
      }

      state.editor.drawing = false;
      return;
    }

    state.editor.drawing = false;
  });

  const setActiveTool = (tool: Tool) => {
    if (state.editor.tool === "move" && tool !== "move") {
      commitMoveState();
      renderPixels();
    }

    state.editor.tool = tool;
    document
      .querySelectorAll<HTMLButtonElement>(".tool-button.is-active")
      .forEach((activeButton) => activeButton.classList.remove("is-active"));
    document.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`)?.classList.add("is-active");
  };

  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveTool((button.dataset.tool ?? "pencil") as Tool);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-tooltip-name]").forEach((button) => {
    button.addEventListener("mouseenter", () => {
      if (!toolTooltip || !toolTooltipName || !toolTooltipShortcut) {
        return;
      }

      toolTooltipName.textContent = button.dataset.tooltipName ?? "";
      toolTooltipShortcut.textContent = button.dataset.tooltipShortcut ?? "";
      toolTooltip.classList.add("is-visible");
      toolTooltip.removeAttribute("aria-hidden");
      const rect = button.getBoundingClientRect();
      toolTooltip.style.top = `${rect.top}px`;
      toolTooltip.style.left = `${rect.right + 8}px`;
    });
    button.addEventListener("mouseleave", () => {
      toolTooltip?.classList.remove("is-visible");
      toolTooltip?.setAttribute("aria-hidden", "true");
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && !event.shiftKey && !event.altKey) {
      const toolByKey: Record<string, Tool> = {
        "1": "pencil",
        "2": "erase",
        "3": "picker",
        "4": "recolor",
        "5": "move",
      };
      const tool = toolByKey[event.key];

      if (tool) {
        const editorOpen = editorDrawer?.getAttribute("aria-hidden") === "false";

        if (editorOpen) {
          event.preventDefault();
          setActiveTool(tool);
        }
      }
    }
  });

  drawColor?.addEventListener("input", () => {
    setEditorColor(drawColor.value);
  });

  colorPreview?.addEventListener("click", () => {
    const isOpen = colorPopover?.getAttribute("aria-hidden") === "false";
    setColorPopoverOpen(!isOpen);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-editor-color]").forEach((button) => {
    button.addEventListener("click", () => {
      setEditorColor(button.dataset.editorColor ?? "");
      setColorPopoverOpen(false);
    });
  });

  document.addEventListener("mousedown", (event) => {
    const picker = document.getElementById("color-picker");

    if (!picker?.contains(event.target as Node)) {
      setColorPopoverOpen(false);
    }
  });

  gridSize?.addEventListener("change", () => {
    const next = normalizeGridSize();

    if (next === state.editor.gridSize) {
      return;
    }

    state.editor.gridSize = next;
    state.editor.layers.forEach((layer) => {
      layer.pixels = createPixels(next);
    });
    state.editor.history = [];
    state.editor.dirty = true;
    renderLayers();
    renderPixels();
  });

  const normalizeBrushSize = () => {
    const raw = Number(brushSize?.value || 1);
    const clamped = Math.max(1, Math.min(8, Number.isFinite(raw) ? Math.round(raw) : 1));

    if (brushSize) {
      brushSize.value = String(clamped);
    }

    return clamped;
  };

  // While typing, only update the live brush state — don't rewrite the field, or
  // clearing the value (e.g. to replace "8") instantly snaps it back and blocks
  // editing. The field is normalized on commit (blur / Enter) instead.
  brushSize?.addEventListener("input", () => {
    const raw = Math.round(Number(brushSize.value));

    if (Number.isFinite(raw) && raw >= 1) {
      state.editor.brushSize = Math.min(8, raw);
    }
  });
  brushSize?.addEventListener("change", () => {
    state.editor.brushSize = normalizeBrushSize();
  });
  state.editor.brushSize = normalizeBrushSize();

  setEditorColor(state.editor.color);

  document.getElementById("clear-canvas")?.addEventListener("click", () => {
    const layer = activeLayer();

    if (!layer) {
      return;
    }

    pushHistory();
    layer.pixels = createPixels(state.editor.gridSize);
    state.editor.dirty = true;
    renderPixels();
  });

  document.getElementById("undo-canvas")?.addEventListener("click", () => {
    const previous = state.editor.history.pop();

    if (!previous) {
      return;
    }

    restoreSnapshot(previous);
    state.editor.dirty = true;
  });

  document.getElementById("add-layer")?.addEventListener("click", addLayer);

  const pointerFraction = (element: HTMLElement, event: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const bindColorDrag = (
    element: HTMLElement | null,
    onMove: (fraction: { x: number; y: number }) => void,
  ) => {
    if (!element) {
      return;
    }

    let active = false;
    const handle = (event: PointerEvent) => onMove(pointerFraction(element, event));

    element.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      active = true;
      element.setPointerCapture(event.pointerId);
      handle(event);
    });
    element.addEventListener("pointermove", (event) => {
      if (active) {
        handle(event);
      }
    });
    const stop = (event: PointerEvent) => {
      active = false;

      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
    };
    element.addEventListener("pointerup", stop);
    element.addEventListener("pointercancel", stop);
  };

  bindColorDrag(colorArea, ({ x, y }) => {
    editorColorHsv = { ...editorColorHsv, s: x, v: 1 - y };
    applyEditorColor();
  });
  bindColorDrag(colorHue, ({ x }) => {
    editorColorHsv = { ...editorColorHsv, h: x * 360 };
    applyEditorColor();
  });

  const displayNameFromSlug = (slug: string) =>
    slug
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
      .join(" ") || slug;

  // Slugify a texture sub-path, keeping `/` so users can target nested folders
  // (e.g. "title/mylogo" under gui). Mirrors the backend's is_valid_asset_name.
  const slugifyTexturePath = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .split("/")
      .map((segment) => segment.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, ""))
      .filter(Boolean)
      .join("/");

  const setNewTextureStatus = (message: string, invalid = false) => {
    if (newTextureStatus) {
      newTextureStatus.textContent = message;
      newTextureStatus.className = invalid
        ? "version-status version-status--invalid"
        : "version-status";
    }
  };

  // The real top-level Minecraft texture folders, derived from what this pack
  // version actually ships — block/item/entity plus every folder the "other"
  // assets live in (gui, painting, particle, environment, misc, ...).
  const DEFAULT_FOLDERS = ["block", "item", "entity", "gui", "painting", "particle", "misc"];

  const availableFolders = () => {
    const folders = new Set<string>(["block", "item", "entity"]);

    state.assets.forEach((asset) => {
      if (asset.kind === "other") {
        const top = asset.id.replace(/^other\//, "").split("/")[0];

        if (top) {
          folders.add(top);
        }
      }
    });

    const list = [...folders];
    return list.length > 3 ? list.sort() : DEFAULT_FOLDERS;
  };

  const updateNewTexturePath = () => {
    const name = slugifyTexturePath(newTextureName?.value ?? "") || "my_texture";

    if (newTexturePathValue) {
      newTexturePathValue.textContent = `${newTextureFolder}/${name}.png`;
    }
  };

  const setNewTextureFolder = (folder: string) => {
    newTextureFolder = folder;

    if (newTextureKindLabel) {
      newTextureKindLabel.textContent = folder;
    }

    newTextureKindMenu
      ?.querySelectorAll<HTMLButtonElement>(".custom-select-option")
      .forEach((option) => {
        option.classList.toggle("is-selected", option.dataset.folder === folder);
      });

    updateNewTexturePath();
  };

  const setNewTextureKindMenuOpen = (isOpen: boolean) => {
    newTextureKindMenu?.setAttribute("aria-hidden", String(!isOpen));
    newTextureKindTrigger?.setAttribute("aria-expanded", String(isOpen));
  };

  const rebuildFolderMenu = () => {
    if (!newTextureKindMenu) {
      return;
    }

    newTextureKindMenu.textContent = "";

    availableFolders().forEach((folder) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "custom-select-option";
      option.setAttribute("role", "option");
      option.dataset.folder = folder;
      option.textContent = folder;
      option.addEventListener("click", () => {
        setNewTextureFolder(folder);
        setNewTextureKindMenuOpen(false);
      });
      newTextureKindMenu.append(option);
    });
  };

  newTextureKindTrigger?.addEventListener("click", () => {
    const isOpen = newTextureKindMenu?.getAttribute("aria-hidden") === "false";
    setNewTextureKindMenuOpen(!isOpen);
  });

  newTextureName?.addEventListener("input", updateNewTexturePath);

  document.addEventListener("mousedown", (event) => {
    if (!newTextureKind?.contains(event.target as Node)) {
      setNewTextureKindMenuOpen(false);
    }
  });

  const setNewTextureModalOpen = (isOpen: boolean) => {
    newTextureModal?.setAttribute("aria-hidden", String(!isOpen));
    setNewTextureKindMenuOpen(false);

    if (isOpen) {
      if (newTextureName) {
        newTextureName.value = "";
      }

      rebuildFolderMenu();
      const folders = availableFolders();
      setNewTextureFolder(folders.includes("block") ? "block" : folders[0] ?? "block");
      setNewTextureStatus("Lowercase letters, numbers, _, - and / only.");
      requestAnimationFrame(() => newTextureName?.focus());
    }
  };

  const createNewTexture = () => {
    const name = slugifyTexturePath(newTextureName?.value ?? "");

    if (!name) {
      setNewTextureStatus("Enter a valid texture name.", true);
      newTextureName?.focus();
      return;
    }

    const folder = newTextureFolder;
    const realPath = `${folder}/${name}`;
    // block/item/entity are real asset kinds; every other folder maps to the
    // internal "other" bucket while keeping its real path as the asset name.
    const kind: AssetKind =
      folder === "block" || folder === "item" || folder === "entity"
        ? (folder as AssetKind)
        : "other";
    const assetName = kind === "other" ? realPath : name;
    const id = `${kind}/${assetName}`;

    if (state.assets.some((asset) => asset.id === id)) {
      setNewTextureStatus("A texture with that path already exists.", true);
      return;
    }

    const asset: WorkspaceAsset = {
      id,
      name: displayNameFromSlug(name.split("/").pop() ?? name),
      kind,
      texturePath: `${realPath}.png`,
      edited: true,
    };

    state.assets = [asset, ...state.assets];
    renderStats();
    setNewTextureModalOpen(false);
    void openEditor(asset);
    setStatus(`New texture "${asset.texturePath}" is ready. Draw it, then Save texture.`);
  };

  document.getElementById("new-texture")?.addEventListener("click", () => {
    setNewTextureModalOpen(true);
  });
  document.getElementById("cancel-new-texture")?.addEventListener("click", () => {
    setNewTextureModalOpen(false);
  });
  document.getElementById("confirm-new-texture")?.addEventListener("click", createNewTexture);
  newTextureName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createNewTexture();
    }
  });
  newTextureModal?.addEventListener("mousedown", (event) => {
    if (event.target === newTextureModal) {
      setNewTextureModalOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && newTextureModal?.getAttribute("aria-hidden") === "false") {
      setNewTextureModalOpen(false);
    }
  });

  const importTextureFromFile = (file: File) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const source = typeof reader.result === "string" ? reader.result : "";

      if (!source) {
        setStatus("Could not read that image file.");
        return;
      }

      void imageSourceToPixels(source, state.editor.gridSize).then((pixels) => {
        if (!pixels) {
          setStatus("Could not import that image.");
          return;
        }

        pushHistory();
        const name = file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "Imported";
        const layer = createLayer(name, state.editor.gridSize);
        layer.pixels = pixels;
        state.editor.layers.unshift(layer);
        state.editor.activeLayerId = layer.id;
        state.editor.dirty = true;
        renderLayers();
        renderPixels();
        setStatus(`Imported "${file.name}" as a new layer.`);
      });
    });
    reader.readAsDataURL(file);
  };

  importFile?.addEventListener("change", () => {
    const file = importFile.files?.[0];

    if (file) {
      importTextureFromFile(file);
    }

    importFile.value = "";
  });
  document.getElementById("import-texture")?.addEventListener("click", () => {
    importFile?.click();
  });

  renderLayers();

  document.getElementById("save-texture")?.addEventListener("click", () => {
    void saveTexture();
  });
  document.getElementById("discard-texture")?.addEventListener("click", closeEditor);

  void listen<TextureCacheProgress>("texture-cache-progress", (event) => {
    setLoadingProgress(event.payload);
  }).catch((error) => {
    console.warn("Texture progress events are available inside the Tauri shell only.", error);
  });

  assetSearch?.addEventListener("input", () => {
    state.query = assetSearch.value;
    renderAssetGrid();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeFilter = (button.dataset.filter ?? "all") as WorkspaceState["activeFilter"];
      document
        .querySelectorAll<HTMLButtonElement>(".workspace-nav-item.is-active")
        .forEach((activeButton) => activeButton.classList.remove("is-active"));
      button.classList.add("is-active");
      renderAssetGrid();
    });
  });

  document.getElementById("export-button")?.addEventListener("click", () => {
    openExportModal();
  });
  exportVersion?.addEventListener("input", renderExportPreview);
  document.getElementById("cancel-export")?.addEventListener("click", closeExportModal);
  document.getElementById("confirm-export")?.addEventListener("click", () => {
    void exportPack();
  });
  exportModal?.addEventListener("mousedown", (event) => {
    if (event.target === exportModal) {
      closeExportModal();
    }
  });
  document.getElementById("return-main-menu")?.addEventListener("click", () => {
    closeEditor();
    closeExportModal();
    workspaceScreen?.setAttribute("hidden", "");
    homeScreen?.removeAttribute("hidden");
  });

  return {
    open(project: WorkspaceProject = { name: "Untitled Pack" }) {
      const safeName = project.name.trim() || "Untitled Pack";
      const fallbackId =
        safeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "preview";

      state.project = {
        id: project.id || fallbackId,
        name: safeName,
        version: project.version,
        minecraftVersion: project.minecraftVersion || project.version || "1.21.6",
        packVersion: project.packVersion || "1.0",
        author: project.author?.trim() || "Me!",
        description: project.description,
        iconDataUrl: project.iconDataUrl,
      };
      homeScreen?.setAttribute("hidden", "");
      shaderWorkspace?.setAttribute("hidden", "");
      workspaceScreen?.removeAttribute("hidden");
      closeEditor();
      closeExportModal();
      setStatus("Loading vanilla textures for this Minecraft version...");
      void loadAssets();
    },
  };
}
