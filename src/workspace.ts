import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseAiReply } from "./aiReply";
import { newAiStreamId, onAiStream } from "./aiStream";
import { showScreen } from "./screenTransition";

type AssetKind = "block" | "item" | "entity" | "other";
type Tool =
  | "pencil"
  | "erase"
  | "picker"
  | "recolor"
  | "move"
  | "fill"
  | "line"
  | "rect"
  | "ellipse";

const SHAPE_TOOLS = new Set<Tool>(["line", "rect", "ellipse"]);

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
    redo: EditorSnapshot[];
    recentColors: string[];
    zoom: number;
    showGrid: boolean;
    dirty: boolean;
    drawing: boolean;
  };
};

type ResourceAiPendingImage = { id: string; name: string; url: string; size: number; mimeType: string };
type ResourceAiProvider = "ollama" | "openrouter" | "gemini";
type ResourceAiConfig = {
  provider: ResourceAiProvider;
  baseUrl?: string;
  apiKey?: string;
  model: string;
};
type TextureAiImage = { name: string; mimeType: string; dataUrl: string };
type TextureAiBackendResponse = { text: string; promptTokens?: number | null; totalTokens?: number | null };
type TextureAiPixelEdit = { x: number; y: number; color: string };
type TextureAiAssetEdit = {
  assetId?: string;
  asset_id?: string;
  texturePath?: string;
  texture_path?: string;
  pixels?: TextureAiPixelEdit[];
};
type TextureAiDataRequest = {
  type?: string;
  assetId?: string;
  asset_id?: string;
  query?: string;
};
type TextureAiResult = {
  reply?: string;
  message?: string;
  requests?: TextureAiDataRequest[];
  edits?: TextureAiAssetEdit[];
};

const ASSET_TILE_WIDTH = 132;
const ASSET_TILE_HEIGHT = 132;
const ASSET_GRID_GAP = 10;
const ASSET_GRID_HORIZONTAL_PADDING = 28;
const ASSET_GRID_BUFFER_ROWS = 4;
const RESOURCE_AI_PANEL_TRANSITION_MS = 220;
const RESOURCE_AI_CONFIG_STORAGE_KEY = "anvil.resourceAi.config";
const TEXTURE_AI_PIXEL_LIMIT = 1024;
const RESOURCE_AI_PROVIDERS: Record<
  ResourceAiProvider,
  {
    title: string;
    badge: string;
    badgeClass: string;
    model: string;
    baseUrl: string;
    apiKeyRequired: boolean;
    showBaseUrl: boolean;
    models: string[];
  }
> = {
  ollama: {
    title: "Local model",
    badge: "LOCAL",
    badgeClass: "ai-provider-badge--local",
    model: "llama3.2",
    baseUrl: "http://localhost:11434",
    apiKeyRequired: false,
    showBaseUrl: true,
    models: ["llama3.2", "llava", "qwen2.5", "gemma3"],
  },
  openrouter: {
    title: "OpenRouter API",
    badge: "API",
    badgeClass: "ai-provider-badge--api",
    model: "openai/gpt-4o-mini",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyRequired: true,
    showBaseUrl: false,
    models: [
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
      "google/gemini-2.0-flash-exp",
      "meta-llama/llama-3.2-11b-vision-instruct",
    ],
  },
  gemini: {
    title: "AI Studio API",
    badge: "API",
    badgeClass: "ai-provider-badge--api",
    model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKeyRequired: true,
    showBaseUrl: false,
    models: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it",
    ],
  },
};

function isResourceAiProvider(value: unknown): value is ResourceAiProvider {
  return value === "ollama" || value === "openrouter" || value === "gemini";
}

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

// Cache hex -> [r,g,b] so the hot render loop never re-parses a colour string.
// Pixel art reuses a small palette, so this Map stays tiny and hits constantly.
const hexColorCache = new Map<string, [number, number, number]>();

function parseHexColor(hex: string): [number, number, number] {
  const cached = hexColorCache.get(hex);

  if (cached) {
    return cached;
  }

  let r = 0;
  let g = 0;
  let b = 0;

  if (hex.length === 7 && hex.charCodeAt(0) === 35) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else if (hex.length === 4 && hex.charCodeAt(0) === 35) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  }

  const rgb: [number, number, number] = [r || 0, g || 0, b || 0];
  hexColorCache.set(hex, rgb);
  return rgb;
}

function compositeLayers(layers: Layer[], size: number) {
  const result = createPixels(size);

  // layers[0] is the top of the stack, so paint from the bottom up.
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];

    if (!layer.visible) {
      continue;
    }

    const pixels = layer.pixels;

    for (let i = 0; i < pixels.length; i += 1) {
      const color = pixels[i];

      if (color) {
        result[i] = color;
      }
    }
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
  const workspaceScreen = document.getElementById("project-workspace");
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
  const gridOverlay = document.getElementById("pixel-grid-overlay");
  const canvasWrap = document.getElementById("editor-canvas-wrap");
  const recentColorsEl = document.getElementById("recent-colors");
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
  const resourceWorkbench = document.getElementById("resource-workbench");
  // Relocate the pixel editor into the workbench grid so it opens in the asset
  // column while the AI panel stays put in its own column — same active panel,
  // never moved or duplicated.
  if (editorDrawer && resourceWorkbench) {
    resourceWorkbench.appendChild(editorDrawer);
  }
  const resourceAiThread = document.getElementById("resource-ai-thread");
  const resourceAiInput = document.getElementById("resource-ai-input") as HTMLTextAreaElement | null;
  const resourceAiSend = document.getElementById("resource-ai-send") as HTMLButtonElement | null;
  const resourceAiPlus = document.getElementById("resource-ai-plus") as HTMLButtonElement | null;
  const resourceAiImageInput = document.getElementById("resource-ai-image-input") as HTMLInputElement | null;
  const resourceAiNewConversation = document.getElementById("resource-ai-new-conversation") as HTMLButtonElement | null;
  const resourceAiToggle = document.getElementById("resource-ai-toggle") as HTMLButtonElement | null;
  const resourceAiContextStatus = document.getElementById("resource-ai-context-status");
  const resourceAiSetupModal = document.getElementById("resource-ai-setup-modal");
  const resourceAiSetupForm = document.getElementById("resource-ai-setup-form") as HTMLFormElement | null;
  const resourceAiSetupClose = document.getElementById("resource-ai-setup-close") as HTMLButtonElement | null;
  const resourceAiCancelSetup = document.getElementById("resource-ai-cancel-setup") as HTMLButtonElement | null;
  const resourceAiSetupProviderTitle = document.getElementById("resource-ai-setup-provider-title");
  const resourceAiSetupProviderIcon = document.getElementById("resource-ai-setup-provider-icon");
  const resourceAiBaseUrlField = document.getElementById("resource-ai-base-url-field");
  const resourceAiBaseUrlInput = document.getElementById("resource-ai-base-url") as HTMLInputElement | null;
  const resourceAiApiKeyField = document.getElementById("resource-ai-api-key-field");
  const resourceAiApiKeyInput = document.getElementById("resource-ai-api-key") as HTMLInputElement | null;
  const resourceAiModelInput = document.getElementById("resource-ai-model") as HTMLInputElement | null;
  const resourceAiModelPresets = document.getElementById("resource-ai-model-presets");
  let newTextureFolder = "block";
  let loadingStartedAt = 0;
  let editorColorHsv: Hsv = { h: 134, s: 0.66, v: 0.91 };
  let renderedAssets: WorkspaceAsset[] = [];
  let renderedAssetWindow = "";
  let assetScrollFrame = 0;
  let resourceAiAttachedImageBytes = 0;
  let resourceAiPendingImages: ResourceAiPendingImage[] = [];
  let resourceAiPendingImageSeq = 0;
  let resourceAiPanelTimer = 0;
  let resourceAiPanelFrame = 0;
  let resourceAiSelectedProvider: ResourceAiProvider = "ollama";
  let resourceAiRequestActive = false;
  // Bumped on every send and on Stop. An in-flight request whose token no longer
  // matches is abandoned (the backend HTTP call can't be cancelled, but its
  // result is ignored).
  let resourceAiRequestToken = 0;
  // Exact tokens the provider reported for the last request (null before any).
  let resourceAiLastTotalTokens: number | null = null;
  const resourceAiImageWarning = document.getElementById("resource-ai-image-warning");
  // Persistent per-asset tile cache. The grid is virtualized, but rebuilding a
  // tile means recreating its <img> and re-decoding the texture from disk every
  // time it scrolls back into view — the source of the scroll lag. Keeping the
  // built tile (and its already-decoded image) alive lets scrolling just move
  // existing nodes. A tile is only rebuilt when its texture or edited state
  // actually changes.
  const assetTileCache = new Map<
    string,
    { el: HTMLElement; previewUrl: string; edited: boolean }
  >();
  let assetGridTopSpacer: HTMLDivElement | null = null;
  let assetGridWindow: HTMLDivElement | null = null;
  let assetGridBottomSpacer: HTMLDivElement | null = null;
  let assetGridEmpty: HTMLParagraphElement | null = null;
  let assetGridColumnCount = 1;
  let assetGridVisibleRowCount = ASSET_GRID_BUFFER_ROWS * 2 + 1;
  let renderedAssetSignature = "";

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
      redo: [],
      recentColors: [],
      zoom: 1,
      showGrid: false,
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

  const readResourceAiConfig = (): ResourceAiConfig | null => {
    try {
      const raw = window.localStorage.getItem(RESOURCE_AI_CONFIG_STORAGE_KEY);

      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<ResourceAiConfig>;
      const provider = parsed.provider;

      if (!isResourceAiProvider(provider)) {
        return null;
      }

      const model = String(parsed.model ?? "").trim();
      const settings = RESOURCE_AI_PROVIDERS[provider];
      const apiKey = String(parsed.apiKey ?? "").trim();

      if (!model || (settings.apiKeyRequired && !apiKey)) {
        return null;
      }

      return {
        provider,
        baseUrl: String(parsed.baseUrl ?? settings.baseUrl).trim() || settings.baseUrl,
        apiKey,
        model,
      };
    } catch {
      return null;
    }
  };

  const saveResourceAiConfig = (config: ResourceAiConfig) => {
    window.localStorage.setItem(RESOURCE_AI_CONFIG_STORAGE_KEY, JSON.stringify(config));
  };

  const syncResourceAiModelPresets = () => {
    if (!resourceAiModelPresets) {
      return;
    }

    const current = resourceAiModelInput?.value.trim() ?? "";
    resourceAiModelPresets.querySelectorAll<HTMLButtonElement>("button").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.model === current);
    });
  };

  const renderResourceAiModelPresets = (provider: ResourceAiProvider) => {
    if (!resourceAiModelPresets) {
      return;
    }

    const settings = RESOURCE_AI_PROVIDERS[provider];
    resourceAiModelPresets.textContent = "";

    settings.models.forEach((model) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ai-model-chip";
      chip.dataset.model = model;
      chip.textContent = model;
      chip.addEventListener("click", () => {
        if (resourceAiModelInput) {
          resourceAiModelInput.value = model;
        }
        syncResourceAiModelPresets();
        resourceAiModelInput?.focus();
      });
      resourceAiModelPresets.append(chip);
    });

    syncResourceAiModelPresets();
  };

  const selectResourceAiProvider = (provider: ResourceAiProvider) => {
    resourceAiSelectedProvider = provider;
    const saved = readResourceAiConfig();
    const settings = RESOURCE_AI_PROVIDERS[provider];

    document.querySelectorAll<HTMLButtonElement>("[data-ai-provider]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.aiProvider === provider);
    });

    if (resourceAiSetupProviderTitle) {
      resourceAiSetupProviderTitle.textContent = settings.title;
    }

    if (resourceAiSetupProviderIcon) {
      resourceAiSetupProviderIcon.className = `ai-provider-badge ${settings.badgeClass}`;
      resourceAiSetupProviderIcon.textContent = settings.badge;
    }

    if (resourceAiBaseUrlField) {
      resourceAiBaseUrlField.hidden = !settings.showBaseUrl;
    }

    if (resourceAiApiKeyField) {
      resourceAiApiKeyField.hidden = !settings.apiKeyRequired;
    }

    if (resourceAiBaseUrlInput) {
      resourceAiBaseUrlInput.value =
        saved?.provider === provider ? saved.baseUrl ?? settings.baseUrl : settings.baseUrl;
    }

    if (resourceAiApiKeyInput) {
      resourceAiApiKeyInput.value = saved?.provider === provider ? saved.apiKey ?? "" : "";
      resourceAiApiKeyInput.placeholder = settings.apiKeyRequired ? "Required" : "Not needed";
    }

    if (resourceAiModelInput) {
      resourceAiModelInput.value = saved?.provider === provider ? saved.model : settings.model;
    }

    renderResourceAiModelPresets(provider);

    if (resourceAiSetupForm) {
      resourceAiSetupForm.hidden = false;
      // Re-trigger the swap animation so switching providers eases the new
      // fields in instead of snapping them.
      resourceAiSetupForm.classList.remove("is-swapping");
      void resourceAiSetupForm.offsetWidth;
      resourceAiSetupForm.classList.add("is-swapping");
    }
  };

  const openResourceAiSetup = () => {
    const saved = readResourceAiConfig();
    selectResourceAiProvider(saved?.provider ?? resourceAiSelectedProvider);
    resourceAiSetupModal?.setAttribute("aria-hidden", "false");
    window.requestAnimationFrame(() => resourceAiModelInput?.focus());
  };

  const closeResourceAiSetup = () => {
    resourceAiSetupModal?.setAttribute("aria-hidden", "true");
  };

  const configuredResourceAi = () => {
    const config = readResourceAiConfig();

    if (!config) {
      openResourceAiSetup();
      setStatus("Set the AI up.");
      return null;
    }

    return config;
  };

  const updateResourceAiContext = () => {
    if (!resourceAiContextStatus) {
      return;
    }

    // Running total for this conversation: provider-reported counts when
    // available, ~4 chars/token estimates otherwise — hence the "~".
    resourceAiContextStatus.textContent =
      resourceAiLastTotalTokens == null
        ? "No tokens used yet"
        : `~${resourceAiLastTotalTokens.toLocaleString()} tokens used`;
  };

  const resizeResourceAiInput = () => {
    if (!resourceAiInput) {
      return;
    }

    resourceAiInput.style.height = "auto";
    resourceAiInput.style.height = `${Math.min(resourceAiInput.scrollHeight, 96)}px`;
  };

  const syncResourceAiSend = () => {
    if (resourceAiSend) {
      // While a request is active the button stays enabled so it can act as Stop.
      resourceAiSend.disabled = resourceAiRequestActive
        ? false
        : !resourceAiInput?.value.trim() && resourceAiPendingImages.length === 0;
    }
  };

  const updateResourceAiSendMode = () => {
    if (!resourceAiSend) {
      return;
    }
    const icon = resourceAiSend.querySelector("span");
    resourceAiSend.classList.toggle("is-stop", resourceAiRequestActive);
    resourceAiSend.setAttribute("aria-label", resourceAiRequestActive ? "Stop generating" : "Send to assistant");
    if (icon) {
      icon.textContent = resourceAiRequestActive ? "■" : "↑";
    }
  };

  const stopResourceAiRequest = () => {
    if (!resourceAiRequestActive) {
      return;
    }
    resourceAiRequestToken += 1; // invalidate the in-flight request and any stream
    resourceAiRequestActive = false;
    resourceAiThread
      ?.querySelectorAll(".ai-typing")
      .forEach((node) => node.closest(".ai-message")?.remove());
    resourceAiThread
      ?.querySelectorAll(".ai-bubble.is-streaming")
      .forEach((node) => node.classList.remove("is-streaming"));
    setStatus("Stopped.");
    syncResourceAiSend();
    updateResourceAiSendMode();
  };

  // Best-effort: does the configured model accept image input? Used only to warn,
  // never to block — the user can always send anyway.
  const resourceModelSupportsImages = (model: string) => {
    const name = model.toLowerCase();
    const visionTokens = [
      "llava",
      "bakllava",
      "vision",
      "-vl",
      "vl-",
      "moondream",
      "minicpm-v",
      "pixtral",
      "internvl",
      "molmo",
      "gpt-4o",
      "gpt-4.1",
      "o3",
      "o4-mini",
      "claude-3",
      "claude-4",
      "claude-opus",
      "claude-sonnet",
      "gemini",
      "gemma-3",
      "gemma-4",
      "gemma3",
    ];
    return visionTokens.some((token) => name.includes(token));
  };

  const updateResourceAiImageWarning = () => {
    if (!resourceAiImageWarning) {
      return;
    }
    if (resourceAiPendingImages.length === 0) {
      resourceAiImageWarning.hidden = true;
      return;
    }
    const config = readResourceAiConfig();
    const supported = config ? resourceModelSupportsImages(config.model) : true;
    resourceAiImageWarning.hidden = supported;
    if (!supported && config) {
      resourceAiImageWarning.textContent = `⚠ ${config.model} may not read images`;
    }
  };

  const renderResourceAiPendingImages = () => {
    const pendingAttachments = document.getElementById("resource-ai-pending-attachments");
    if (!pendingAttachments) {
      return;
    }

    pendingAttachments.textContent = "";
    pendingAttachments.hidden = resourceAiPendingImages.length === 0;
    updateResourceAiImageWarning();

    resourceAiPendingImages.forEach((pending) => {
      const item = document.createElement("div");
      item.className = "ai-pending-image";

      const image = document.createElement("img");
      image.src = pending.url;
      image.alt = pending.name;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${pending.name}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        resourceAiPendingImages = resourceAiPendingImages.filter((entry) => entry.id !== pending.id);
        renderResourceAiPendingImages();
        syncResourceAiSend();
        updateResourceAiContext();
      });

      item.append(image, remove);
      pendingAttachments.append(item);
    });
  };

  const scrollResourceAiThread = () => {
    if (resourceAiThread) {
      resourceAiThread.scrollTop = resourceAiThread.scrollHeight;
    }
  };

  const resetResourceAiConversation = () => {
    // Abandon any in-flight request/stream so the panel never gets stuck in the
    // "active/stop" state after a new conversation or leaving and re-entering.
    resourceAiRequestToken += 1;
    resourceAiRequestActive = false;

    if (resourceAiThread) {
      resourceAiThread.textContent = "";
    }
    if (resourceAiInput) {
      resourceAiInput.value = "";
      resizeResourceAiInput();
    }
    resourceAiAttachedImageBytes = 0;
    resourceAiPendingImages = [];
    resourceAiLastTotalTokens = null;
    renderResourceAiPendingImages();
    updateResourceAiImageWarning();
    updateResourceAiSendMode(); // restore the ↑ icon if it was a ■ Stop
    syncResourceAiSend();
    updateResourceAiContext();
  };

  const setResourceAiCollapsed = (collapsed: boolean) => {
    if (!resourceWorkbench) {
      return;
    }

    window.clearTimeout(resourceAiPanelTimer);
    if (resourceAiPanelFrame) {
      window.cancelAnimationFrame(resourceAiPanelFrame);
      resourceAiPanelFrame = 0;
    }

    resourceWorkbench.classList.remove("is-ai-collapsing", "is-ai-expanding");
    resourceAiToggle?.setAttribute("aria-expanded", String(!collapsed));
    resourceAiToggle?.setAttribute("aria-label", collapsed ? "Expand AI" : "Collapse AI");

    if (collapsed) {
      if (resourceWorkbench.classList.contains("is-ai-collapsed")) {
        return;
      }

      resourceWorkbench.classList.add("is-ai-collapsing");
      resourceAiPanelTimer = window.setTimeout(() => {
        resourceWorkbench.classList.add("is-ai-collapsed");
        resourceWorkbench.classList.remove("is-ai-collapsing");
      }, RESOURCE_AI_PANEL_TRANSITION_MS);
      return;
    }

    if (!resourceWorkbench.classList.contains("is-ai-collapsed")) {
      return;
    }

    resourceWorkbench.classList.add("is-ai-expanding", "is-ai-collapsing");
    resourceWorkbench.classList.remove("is-ai-collapsed");
    resourceAiPanelFrame = window.requestAnimationFrame(() => {
      resourceAiPanelFrame = 0;
      resourceWorkbench.classList.remove("is-ai-collapsing");
      resourceAiPanelTimer = window.setTimeout(() => {
        resourceWorkbench.classList.remove("is-ai-expanding");
        // WebKitGTK (Tauri/Linux) can leave the panel's composited layer stale
        // after the collapse transform, so the thread renders blank even though
        // the messages are still in the DOM. Force a repaint to bring them back.
        repaintResourceAiThread();
      }, RESOURCE_AI_PANEL_TRANSITION_MS);
    });
  };

  const repaintResourceAiThread = () => {
    if (!resourceAiThread) {
      return;
    }
    resourceAiThread.style.display = "none";
    void resourceAiThread.offsetHeight; // force reflow → WebKitGTK re-rasterizes
    resourceAiThread.style.display = "";
  };

  const isResourceAiCollapsedOrCollapsing = () =>
    Boolean(
      resourceWorkbench?.classList.contains("is-ai-collapsed") ||
        (resourceWorkbench?.classList.contains("is-ai-collapsing") &&
          !resourceWorkbench?.classList.contains("is-ai-expanding")),
    );

  const appendResourceAiMessage = (text: string, role: "user" | "assistant", images: ResourceAiPendingImage[] = []) => {
    if (!resourceAiThread) {
      return;
    }

    const message = document.createElement("div");
    message.className = `ai-message ai-message--${role}`;
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    if (text) {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      bubble.append(paragraph);
    }
    if (images.length) {
      bubble.classList.add("ai-bubble--attachments");
      const attachments = document.createElement("div");
      attachments.className = "ai-attachments";
      images.forEach((pending) => {
        const image = document.createElement("img");
        image.src = pending.url;
        image.alt = pending.name;
        image.loading = "lazy";
        attachments.append(image);
      });
      bubble.append(attachments);
    }
    message.append(bubble);
    resourceAiThread.append(message);
    scrollResourceAiThread();
    updateResourceAiContext();
  };

  const resourceImageFileDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
      reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read image.")));
      reader.readAsDataURL(file);
    });

  const addResourceAiPendingImages = async (files: FileList | File[] | null) => {
    const imageFiles = [...(files ?? [])].filter((file) => file.type.startsWith("image/"));

    if (!imageFiles.length) {
      return;
    }

    const previews = await Promise.all(
      imageFiles.slice(0, Math.max(0, 5 - resourceAiPendingImages.length)).map(async (file) => ({
        id: `resource-ai-image-${++resourceAiPendingImageSeq}`,
        name: file.name,
        size: file.size,
        mimeType: file.type || "image/png",
        url: await resourceImageFileDataUrl(file),
      })),
    );

    resourceAiPendingImages = [...resourceAiPendingImages, ...previews].slice(0, 5);
    renderResourceAiPendingImages();
    syncResourceAiSend();
    updateResourceAiContext();
  };

  const resourceImageFilesFromPaste = (data: DataTransfer | null) => {
    if (!data) {
      return [];
    }

    const itemFiles = [...data.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (itemFiles.length) {
      return itemFiles;
    }

    return [...data.files].filter((file) => file.type.startsWith("image/"));
  };

  const appendResourceAiTyping = () => {
    if (!resourceAiThread) {
      return null;
    }

    const message = document.createElement("div");
    message.className = "ai-message ai-message--assistant";
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    const typing = document.createElement("div");
    typing.className = "ai-typing";
    typing.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    bubble.append(typing);
    message.append(bubble);
    resourceAiThread.append(message);
    scrollResourceAiThread();
    updateResourceAiContext();
    return message;
  };

  // Live model output. The typing dots flip into a dim raw-text feed as soon
  // as the first delta arrives, so a long generation visibly makes progress
  // instead of looking stuck.
  const attachLiveAiStream = (message: HTMLElement | null) => {
    let feed: HTMLElement | null = null;

    return {
      push: (delta: string) => {
        if (!message) {
          return;
        }
        if (!feed) {
          const bubble = message.querySelector(".ai-bubble");
          if (!bubble) {
            return;
          }
          bubble.textContent = "";
          const live = document.createElement("div");
          live.className = "ai-live";
          const label = document.createElement("span");
          label.className = "ai-live-label";
          label.textContent = "Thinking…";
          feed = document.createElement("pre");
          feed.className = "ai-live-text";
          live.append(label, feed);
          bubble.append(live);
        }
        feed.textContent += delta;
        feed.scrollTop = feed.scrollHeight;
        scrollResourceAiThread();
      },
    };
  };

  const createResourceAiThinking = (thinking: string) => {
    const details = document.createElement("details");
    details.className = "ai-thinking";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking";
    const body = document.createElement("div");
    body.className = "ai-thinking-body";
    body.textContent = thinking;
    details.append(summary, body);
    return details;
  };

  const appendResourceAiStreamingMessage = (thinking = "") => {
    if (!resourceAiThread) {
      return null;
    }

    const message = document.createElement("div");
    message.className = "ai-message ai-message--assistant";
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble is-streaming";
    if (thinking) {
      bubble.append(createResourceAiThinking(thinking));
    }
    const paragraph = document.createElement("p");
    paragraph.className = "ai-stream-text";
    bubble.append(paragraph);
    message.append(bubble);
    resourceAiThread.append(message);
    scrollResourceAiThread();
    updateResourceAiContext();

    return { bubble, paragraph };
  };

  const streamResourceAiText = (target: HTMLParagraphElement, text: string, token: number) =>
    new Promise<void>((resolve) => {
      const chunks = text.match(/\S+\s*/g) ?? [text];
      let index = 0;

      const tick = () => {
        // Stop streaming immediately if the user hit Stop or started a new request.
        if (token !== resourceAiRequestToken) {
          resolve();
          return;
        }

        target.textContent += chunks[index] ?? "";
        index += 1;
        scrollResourceAiThread();
        updateResourceAiContext();

        if (index >= chunks.length) {
          resolve();
          return;
        }

        window.setTimeout(tick, text.length > 420 ? 12 : 22);
      };

      tick();
    });

  // Turn a raw model response into a clean reply + the reasoning to fold away.
  const parseTextureAiReply = (raw: string) =>
    parseAiReply<TextureAiResult>(raw, ["reply", "edits", "message", "requests"]);

  // Compact "(x,y)=#rrggbb" dump of a flat pixel array; transparent pixels are
  // skipped and the list is capped so a big texture can't blow up the prompt.
  const compactPixelString = (pixels: Array<string | null>, size: number) => {
    const colored: string[] = [];
    for (let index = 0; index < pixels.length && colored.length < 1200; index += 1) {
      const color = pixels[index];
      if (color) {
        colored.push(`(${index % size},${Math.floor(index / size)})=${color}`);
      }
    }
    return `${size}x${size}, ${colored.length} colored pixels\n${colored.join(" ")}`;
  };

  const isEditorOpenFor = (assetId: string | undefined) =>
    (workspaceScreen?.classList.contains("editor-open") ?? false) && state.selectedAsset?.id === assetId;

  // Exact pixels of an asset: live editor layers if it's the open one, otherwise
  // decode its texture off-screen.
  const assetPixelString = async (asset: WorkspaceAsset) => {
    if (isEditorOpenFor(asset.id)) {
      const size = state.editor.gridSize;
      return compactPixelString(compositeLayers(state.editor.layers, size), size);
    }

    const image = await loadAssetImage(asset);
    const size = image ? nativeGridSize(image) : 16;
    const pixels = (image ? imagePixels(image, size) : null) ?? new Array<string | null>(size * size).fill(null);
    return compactPixelString(pixels, size);
  };

  const openAssetPixelString = () => {
    if (!state.selectedAsset || !isEditorOpenFor(state.selectedAsset.id)) {
      return null;
    }
    const size = state.editor.gridSize;
    return compactPixelString(compositeLayers(state.editor.layers, size), size);
  };

  const resolveAiEditAsset = (edit: TextureAiAssetEdit) => {
    const rawId = String(edit.assetId ?? edit.asset_id ?? edit.texturePath ?? edit.texture_path ?? "").trim();

    if (!rawId) {
      return state.selectedAsset;
    }

    return (
      state.assets.find(
        (asset) =>
          asset.id === rawId ||
          asset.texturePath === rawId ||
          asset.texturePath === `${rawId}.png` ||
          asset.id.endsWith(`/${rawId.replace(/\.png$/i, "")}`),
      ) ?? null
    );
  };

  // Answer the model's data "requests" (block list / pixels) into a text blob
  // that's fed back to it on the next round.
  const fulfillResourceAiRequests = async (requests: TextureAiDataRequest[]) => {
    const parts: string[] = [];

    for (const request of requests.slice(0, 8)) {
      const type = String(request.type ?? "").toLowerCase();

      if (type === "search" || type === "find") {
        const query = String(request.query ?? request.assetId ?? request.asset_id ?? "")
          .toLowerCase()
          .trim();
        const matches = query
          ? state.assets.filter(
              (asset) =>
                asset.id.toLowerCase().includes(query) || asset.name.toLowerCase().includes(query),
            )
          : [];
        const list = matches
          .slice(0, 80)
          .map((asset) => `${asset.id} (${asset.name}) [${asset.kind}]`)
          .join("\n");
        parts.push(
          matches.length
            ? `Search "${query}" — ${matches.length} match(es):\n${list}`
            : `Search "${query}": no textures matched.`,
        );
      } else if (type === "blocks" || type === "block" || type === "list" || type === "all") {
        const list = state.assets
          .slice(0, 800)
          .map((asset) => `${asset.id} (${asset.name}) [${asset.kind}]`)
          .join("\n");
        const suffix = state.assets.length > 800 ? ` (showing first 800; use search for the rest)` : "";
        parts.push(`Textures (${state.assets.length})${suffix}:\n${list}`);
      } else if (type === "pixels" || type === "pixel" || type === "colors") {
        const id = String(request.assetId ?? request.asset_id ?? "").trim();
        const asset = id ? resolveAiEditAsset({ assetId: id }) : state.selectedAsset;

        if (!asset) {
          parts.push(`Pixels for "${id || "selected"}": no matching texture.`);
          continue;
        }

        parts.push(`Pixels of ${asset.id} (${asset.name}):\n${await assetPixelString(asset)}`);
      }
    }

    return parts.join("\n\n");
  };

  // Clamp/validate a raw edit's pixels against a grid size.
  const validateAiPixels = (pixels: TextureAiPixelEdit[] | undefined, size: number, budget: number) => {
    const valid: TextureAiPixelEdit[] = [];
    for (const pixel of pixels ?? []) {
      if (valid.length >= budget) {
        break;
      }
      const x = Number(pixel.x);
      const y = Number(pixel.y);
      const color = normalizeHexColor(String(pixel.color ?? ""));
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < size && y < size && color) {
        valid.push({ x, y, color });
      }
    }
    return valid;
  };

  // Apply AI pixels to the texture currently open in the editor (as an undoable
  // "AI edit" layer, shown live).
  const applyAiEditsToOpenAsset = (pixels: TextureAiPixelEdit[], budget: number) => {
    const size = state.editor.gridSize;
    const valid = validateAiPixels(pixels, size, budget);
    if (!valid.length) {
      return 0;
    }

    pushHistory();
    const aiLayer = createLayer("AI edit", size);
    state.editor.layers.unshift(aiLayer);
    state.editor.activeLayerId = aiLayer.id;
    valid.forEach((pixel) => {
      aiLayer.pixels[pixel.y * size + pixel.x] = pixel.color;
    });

    if (state.selectedAsset) {
      state.selectedAsset.edited = true;
      assetTileCache.delete(state.selectedAsset.id);
    }
    state.editor.dirty = true;
    renderLayers();
    renderPixels();
    renderStats();
    renderAssetGrid();
    return valid.length;
  };

  // Apply AI pixels to a texture that is NOT open: decode it, overlay the pixels,
  // and save it back to disk without disturbing the editor.
  const applyAiEditsToOtherAsset = async (asset: WorkspaceAsset, pixels: TextureAiPixelEdit[], budget: number) => {
    const image = await loadAssetImage(asset);
    const size = image ? nativeGridSize(image) : 16;
    const base = (image ? imagePixels(image, size) : null) ?? new Array<string | null>(size * size).fill(null);
    const valid = validateAiPixels(pixels, size, budget);
    if (!valid.length) {
      return 0;
    }

    valid.forEach((pixel) => {
      base[pixel.y * size + pixel.x] = pixel.color;
    });

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) {
      return 0;
    }
    drawPixelsToContext(context, base, size);
    const pngBase64 = canvas.toDataURL("image/png").split(",")[1] ?? "";

    const output = await callBackend<SaveTextureResult>(
      "save_texture",
      { projectId: state.project.id || "preview", assetId: asset.id, pngBase64 },
      () => "browser-preview",
    );

    asset.edited = true;
    const savedPath = typeof output === "string" ? "" : output.path ?? "";
    asset.previewPath = savedPath || asset.previewPath;
    asset.previewUrl = savedPath ? pathToPreviewUrl(savedPath) : `data:image/png;base64,${pngBase64}`;
    assetTileCache.delete(asset.id);
    renderAssetGrid();
    return valid.length;
  };

  const applyTextureAiEdits = async (result: TextureAiResult | null) => {
    const edits = result?.edits?.filter((edit) => Array.isArray(edit.pixels) && edit.pixels.length > 0) ?? [];

    if (!edits.length) {
      return { changed: 0, assets: [] as WorkspaceAsset[] };
    }

    // Group pixels by the asset they target so we can edit several blocks at once.
    const groups = new Map<string, { asset: WorkspaceAsset; pixels: TextureAiPixelEdit[] }>();
    for (const edit of edits) {
      const asset = resolveAiEditAsset(edit);
      if (!asset) {
        continue;
      }
      const group = groups.get(asset.id) ?? { asset, pixels: [] };
      group.pixels.push(...(edit.pixels ?? []));
      groups.set(asset.id, group);
    }

    if (!groups.size) {
      return { changed: 0, assets: [] as WorkspaceAsset[] };
    }

    let changed = 0;
    const changedAssets: WorkspaceAsset[] = [];
    let budget = TEXTURE_AI_PIXEL_LIMIT;

    for (const { asset, pixels } of groups.values()) {
      if (budget <= 0) {
        break;
      }
      const applied = isEditorOpenFor(asset.id)
        ? applyAiEditsToOpenAsset(pixels, budget)
        : await applyAiEditsToOtherAsset(asset, pixels, budget);

      if (applied > 0) {
        changed += applied;
        budget -= applied;
        changedAssets.push(asset);
      }
    }

    return { changed, assets: changedAssets };
  };

  const runTextureAi = async (
    config: ResourceAiConfig,
    prompt: string,
    images: ResourceAiPendingImage[],
    toolResults = "",
    streamId: string | null = null,
  ) => {
    // Don't dump the whole list — the model must filter/search for textures.
    // Send only per-kind counts and a few example ids so it learns the id format.
    const kindCounts = new Map<string, number>();
    for (const asset of state.assets) {
      kindCounts.set(asset.kind, (kindCounts.get(asset.kind) ?? 0) + 1);
    }
    const assetSummary = [...kindCounts.entries()].map(([kind, count]) => `${kind} ×${count}`).join(", ");
    const assets = [...kindCounts.keys()].flatMap((kind) =>
      state.assets
        .filter((asset) => asset.kind === kind)
        .slice(0, 3)
        .map((asset) => ({
          id: asset.id,
          name: asset.name,
          texturePath: asset.texturePath,
          edited: Boolean(asset.edited),
        })),
    );

    // Only report a texture as "open in the editor" when it actually is.
    const openAsset =
      (workspaceScreen?.classList.contains("editor-open") ?? false) ? state.selectedAsset : null;

    const response = await invoke<TextureAiBackendResponse>("run_texture_ai", {
      config,
      request: {
        prompt,
        projectName: state.project.name,
        gridSize: state.editor.gridSize,
        selectedAssetId: openAsset?.id ?? null,
        selectedAssetName: openAsset?.name ?? null,
        assets,
        totalAssets: state.assets.length,
        assetSummary,
        images: images.map((image) => ({
          name: image.name,
          mimeType: image.mimeType,
          dataUrl: image.url,
        })) as TextureAiImage[],
        openAssetPixels: openAssetPixelString(),
        toolResults: toolResults || null,
        streamId,
      },
    });

    return response;
  };

  const submitResourceAiPrompt = async (prompt: string) => {
    const text = prompt.trim();
    if (!text && !resourceAiPendingImages.length) {
      return;
    }

    if (resourceAiRequestActive) {
      return;
    }

    const config = configuredResourceAi();

    if (!config) {
      return;
    }

    resourceAiRequestActive = true;
    const token = ++resourceAiRequestToken;
    syncResourceAiSend();
    updateResourceAiSendMode();

    const sentImages = resourceAiPendingImages;
    resourceAiAttachedImageBytes += sentImages.reduce((total, image) => total + image.size, 0);
    resourceAiPendingImages = [];
    renderResourceAiPendingImages();
    appendResourceAiMessage(text, "user", sentImages);
    if (resourceAiInput) {
      resourceAiInput.value = "";
      resizeResourceAiInput();
    }
    syncResourceAiSend();

    const typing = appendResourceAiTyping();
    const live = attachLiveAiStream(typing);
    setStatus("Texture AI is thinking...");

    try {
      // Request/fulfill loop: the model may ask for the block list or a block's
      // pixels before it can answer. We answer and re-ask, bounded so it ends.
      const MAX_AI_ROUNDS = 3;
      let toolResults = "";
      let usedTokens = 0;
      let parsed = parseTextureAiReply("{}");

      for (let round = 0; round < MAX_AI_ROUNDS; round += 1) {
        const streamId = newAiStreamId();
        const stopStream = onAiStream(streamId, (delta) => {
          if (token === resourceAiRequestToken) {
            live.push(delta);
          }
        });

        let response: TextureAiBackendResponse;
        try {
          response = await runTextureAi(config, text, sentImages, toolResults, streamId);
        } finally {
          stopStream();
        }
        if (token !== resourceAiRequestToken) {
          return; // stopped while waiting
        }

        // Exact usage when the provider reports it, a ~4 chars/token estimate
        // of the round's traffic when it doesn't — never silently zero.
        usedTokens +=
          typeof response.totalTokens === "number"
            ? response.totalTokens
            : Math.ceil((text.length + toolResults.length + response.text.length) / 4);

        parsed = parseTextureAiReply(response.text);
        const requests = Array.isArray(parsed.result?.requests) ? parsed.result.requests : [];
        const hasEdits = (parsed.result?.edits?.length ?? 0) > 0;

        if (requests.length && !hasEdits && round < MAX_AI_ROUNDS - 1) {
          setStatus("Texture AI is gathering data…");
          live.push("\n\n— fetching the data it asked for, asking again —\n\n");
          const fulfilled = await fulfillResourceAiRequests(requests);
          if (token !== resourceAiRequestToken) {
            return;
          }
          toolResults = toolResults ? `${toolResults}\n\n${fulfilled}` : fulfilled;
          continue;
        }

        break;
      }

      if (usedTokens > 0) {
        // Conversation-cumulative: every round of every message counts.
        resourceAiLastTotalTokens = (resourceAiLastTotalTokens ?? 0) + usedTokens;
        updateResourceAiContext();
      }

      const { result, reply, thinking } = parsed;
      const applied = await applyTextureAiEdits(result);
      if (token !== resourceAiRequestToken) {
        return;
      }

      typing?.remove();
      const streamTarget = appendResourceAiStreamingMessage(thinking);

      if (streamTarget) {
        await streamResourceAiText(streamTarget.paragraph, reply, token);
        if (token === resourceAiRequestToken) {
          streamTarget.bubble.classList.remove("is-streaming");
        }
      } else {
        appendResourceAiMessage(reply, "assistant");
      }

      if (applied.changed > 0) {
        const names = applied.assets.map((asset) => asset.name).join(", ");
        const openEdited = applied.assets.some((asset) => isEditorOpenFor(asset.id));
        setStatus(
          `AI edited ${applied.changed} pixels on ${names}.${openEdited ? " Save texture to keep it." : ""}`,
        );
      } else if (result?.edits?.length) {
        setStatus("AI replied, but no valid texture pixels were found.");
      } else {
        setStatus("AI replied.");
      }
    } catch (error) {
      if (token !== resourceAiRequestToken) {
        return; // stopped; ignore the failure of the abandoned request
      }
      typing?.remove();
      const message = error instanceof Error ? error.message : String(error);
      appendResourceAiMessage(message, "assistant");
      setStatus("AI request failed.");
    } finally {
      if (token === resourceAiRequestToken) {
        resourceAiRequestActive = false;
        updateResourceAiSendMode();
        syncResourceAiSend();
        updateResourceAiContext();
      }
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

    updateResourceAiContext();
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

  const buildAssetTile = (asset: WorkspaceAsset) => {
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
      image.decoding = "async";
      image.setAttribute("fetchpriority", "low");
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

    return tile;
  };

  const getAssetTile = (asset: WorkspaceAsset) => {
    const previewUrl = asset.previewUrl ?? "";
    const edited = Boolean(asset.edited);
    const cached = assetTileCache.get(asset.id);

    if (cached && cached.previewUrl === previewUrl && cached.edited === edited) {
      return cached.el;
    }

    const el = buildAssetTile(asset);
    assetTileCache.set(asset.id, { el, previewUrl, edited });
    return el;
  };

  const updateAssetGridMetrics = () => {
    if (!assetGrid) {
      assetGridColumnCount = 1;
      assetGridVisibleRowCount = ASSET_GRID_BUFFER_ROWS * 2 + 1;
      return;
    }

    const usableWidth = Math.max(ASSET_TILE_WIDTH, assetGrid.clientWidth - ASSET_GRID_HORIZONTAL_PADDING);
    const columnStride = ASSET_TILE_WIDTH + ASSET_GRID_GAP;
    const rowStride = ASSET_TILE_HEIGHT + ASSET_GRID_GAP;
    assetGridColumnCount = Math.max(1, Math.floor((usableWidth + ASSET_GRID_GAP) / columnStride));
    assetGridVisibleRowCount = Math.ceil(assetGrid.clientHeight / rowStride) + ASSET_GRID_BUFFER_ROWS * 2;
  };

  const ensureAssetGridShell = () => {
    if (!assetGrid) {
      return null;
    }

    if (!assetGridTopSpacer) {
      assetGridTopSpacer = document.createElement("div");
      assetGridTopSpacer.className = "asset-grid-spacer";
    }

    if (!assetGridWindow) {
      assetGridWindow = document.createElement("div");
      assetGridWindow.className = "asset-grid-window";
    }

    if (!assetGridBottomSpacer) {
      assetGridBottomSpacer = document.createElement("div");
      assetGridBottomSpacer.className = "asset-grid-spacer";
    }

    if (
      assetGrid.children[0] !== assetGridTopSpacer ||
      assetGrid.children[1] !== assetGridWindow ||
      assetGrid.children[2] !== assetGridBottomSpacer ||
      assetGrid.children.length !== 3
    ) {
      assetGrid.replaceChildren(assetGridTopSpacer, assetGridWindow, assetGridBottomSpacer);
    }

    return {
      topSpacer: assetGridTopSpacer,
      windowGrid: assetGridWindow,
      bottomSpacer: assetGridBottomSpacer,
    };
  };

  const showEmptyAssetGrid = () => {
    if (!assetGrid) {
      return;
    }

    if (!assetGridEmpty) {
      assetGridEmpty = document.createElement("p");
      assetGridEmpty.className = "asset-empty";
      assetGridEmpty.textContent = "No assets match that search.";
    }

    renderedAssetWindow = "";
    assetGrid.replaceChildren(assetGridEmpty);
  };

  const renderAssetWindow = () => {
    if (!assetGrid) {
      return;
    }

    const assets = renderedAssets;

    if (!assets.length) {
      showEmptyAssetGrid();
      return;
    }

    const shell = ensureAssetGridShell();

    if (!shell) {
      return;
    }

    const columns = assetGridColumnCount;
    const rowStride = ASSET_TILE_HEIGHT + ASSET_GRID_GAP;
    const totalRows = Math.ceil(assets.length / columns);
    const firstRow = Math.max(0, Math.floor(assetGrid.scrollTop / rowStride) - ASSET_GRID_BUFFER_ROWS);
    const visibleRows = assetGridVisibleRowCount;
    const lastRow = Math.min(totalRows, firstRow + visibleRows);
    const startIndex = firstRow * columns;
    const endIndex = Math.min(assets.length, lastRow * columns);
    const signature = `${columns}:${startIndex}:${endIndex}:${assets.length}`;

    if (signature === renderedAssetWindow) {
      return;
    }

    renderedAssetWindow = signature;

    shell.topSpacer.style.height = `${firstRow * rowStride}px`;
    shell.windowGrid.style.setProperty("--asset-grid-columns", String(columns));

    const fragment = document.createDocumentFragment();
    assets.slice(startIndex, endIndex).forEach((asset) => {
      fragment.append(getAssetTile(asset));
    });
    shell.windowGrid.replaceChildren(fragment);

    const renderedRows = Math.ceil((endIndex - startIndex) / columns);
    const bottomRows = Math.max(0, totalRows - firstRow - renderedRows);
    shell.bottomSpacer.style.height = `${bottomRows * rowStride}px`;
  };

  const scheduleAssetWindowRender = () => {
    if (assetScrollFrame) {
      return;
    }

    assetScrollFrame = window.requestAnimationFrame(() => {
      assetScrollFrame = 0;
      renderAssetWindow();
    });
  };

  const renderAssetGrid = () => {
    if (!assetGrid) {
      return;
    }

    renderedAssets = filteredAssets();
    updateAssetGridMetrics();

    // Drop cached tiles only when the underlying asset set actually changes
    // (search, filter, project reload) — not on edits/scroll, which keep the
    // same ids/order and reuse decoded images. The cap is a safety valve so the
    // cache can't grow without bound across many filter switches.
    const signature = `${renderedAssets.length}:${renderedAssets[0]?.id ?? ""}:${
      renderedAssets[renderedAssets.length - 1]?.id ?? ""
    }`;
    if (signature !== renderedAssetSignature || assetTileCache.size > 1500) {
      assetTileCache.clear();
      renderedAssetSignature = signature;
    }

    renderedAssetWindow = "";
    assetGrid.scrollTop = 0;
    renderAssetWindow();
  };

  const renderWorkspace = () => {
    if (projectName) {
      projectName.textContent = state.project.name;
    }

    if (projectIcon) {
      projectIcon.textContent = state.project.iconDataUrl ? "" : "RP";
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
    updateResourceAiContext();
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
    // One putImageData beats thousands of fillStyle/fillRect calls — the latter
    // re-parses the colour string for every pixel and was the source of the lag.
    const image = context.createImageData(size, size);
    const data = image.data;

    for (let i = 0; i < pixels.length; i += 1) {
      const color = pixels[i];

      if (!color) {
        continue; // createImageData is zero-filled, so this stays transparent.
      }

      const rgb = parseHexColor(color);
      const offset = i * 4;
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = 255;
    }

    context.putImageData(image, 0, 0);
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

    const canvasMetrics = getCanvasMetrics();

    if (!canvasMetrics) {
      return;
    }

    const { rect, offsetLeft, offsetTop } = canvasMetrics;
    const cell = rect.width / state.editor.gridSize;
    let { x, y, w, h } = moveState.rect;

    if (moveState.phase !== "selecting") {
      x += moveState.offset.x;
      y += moveState.offset.y;
    }

    selectionOverlay.style.transform = `translate3d(${offsetLeft + x * cell}px, ${offsetTop + y * cell}px, 0)`;
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
    syncLayerRows();
  };

  const syncLayerRows = () => {
    layerList?.querySelectorAll<HTMLElement>("[data-layer-id]").forEach((row) => {
      const layerId = row.dataset.layerId;
      row.classList.toggle("is-active", layerId === state.editor.activeLayerId);
      row.classList.toggle("is-dragging", layerId === dragLayerId);
    });
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
        syncLayerRows();
      });

      row.append(thumb, name, visibility, remove);
      layerList.append(row);
    });

    refreshLayerThumbs();
  };

  // Repainting the main canvas is cheap; refreshing every layer thumbnail is
  // not. During a continuous stroke we skip the thumbnails (updateThumbs=false)
  // and only refresh them once the stroke settles.
  const renderPixels = (updateThumbs = true) => {
    if (!pixelCanvas) {
      return;
    }

    const context = pixelCanvas.getContext("2d");

    if (!context) {
      return;
    }

    const size = state.editor.gridSize;
    if (pixelCanvas.width !== size || pixelCanvas.height !== size) {
      pixelCanvas.width = size;
      pixelCanvas.height = size;
      invalidateCanvasRect();
      positionGridOverlay();
    }
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

    if (updateThumbs) {
      refreshLayerThumbs();
    }
  };

  // Coalesce the rapid repaints of an active stroke into one per frame, and
  // leave the thumbnails alone until the stroke finishes.
  let drawFrame = 0;

  const scheduleDraw = () => {
    if (drawFrame) {
      return;
    }

    drawFrame = window.requestAnimationFrame(() => {
      drawFrame = 0;
      renderPixels(false);
    });
  };

  const finalizeStroke = () => {
    if (drawFrame) {
      window.cancelAnimationFrame(drawFrame);
      drawFrame = 0;
    }

    renderPixels(true);
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
    state.editor.history = [...state.editor.history.slice(-49), snapshotEditor()];
    // A fresh edit invalidates anything that was undone.
    state.editor.redo = [];
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

  const undoEdit = () => {
    const previous = state.editor.history.pop();

    if (!previous) {
      setStatus("Nothing to undo.");
      return;
    }

    // Stash the current state so it can be redone.
    state.editor.redo = [...state.editor.redo.slice(-49), snapshotEditor()];
    cancelActiveStroke();
    restoreSnapshot(previous);
    state.editor.dirty = true;
    setStatus("Undid last change.");
  };

  const redoEdit = () => {
    const next = state.editor.redo.pop();

    if (!next) {
      setStatus("Nothing to redo.");
      return;
    }

    state.editor.history = [...state.editor.history.slice(-49), snapshotEditor()];
    cancelActiveStroke();
    restoreSnapshot(next);
    state.editor.dirty = true;
    setStatus("Redid change.");
  };

  const clearActiveLayer = () => {
    const layer = activeLayer();

    if (!layer) {
      return;
    }

    pushHistory();
    layer.pixels = createPixels(state.editor.gridSize);
    state.editor.dirty = true;
    renderPixels();
    setStatus("Cleared layer.");
  };

  // The canvas rect only changes on resize/scroll/zoom — caching it stops every
  // pointer-move from forcing a synchronous layout right after we mutate the
  // cursor styles (read-after-write layout thrash).
  let canvasMetricsCache: { rect: DOMRect; offsetLeft: number; offsetTop: number } | null = null;
  const getCanvasMetrics = () => {
    if (!canvasMetricsCache && pixelCanvas) {
      canvasMetricsCache = {
        rect: pixelCanvas.getBoundingClientRect(),
        offsetLeft: pixelCanvas.offsetLeft,
        offsetTop: pixelCanvas.offsetTop,
      };
    }
    return canvasMetricsCache;
  };
  const getCanvasRect = () => {
    return getCanvasMetrics()?.rect ?? null;
  };
  const invalidateCanvasRect = () => {
    canvasMetricsCache = null;
  };

  const pixelFromEvent = (event: PointerEvent) => {
    if (!pixelCanvas) {
      return null;
    }

    const rect = getCanvasRect();

    if (!rect) {
      return null;
    }

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
      scheduleDraw();
    }
  };

  const resetEditorLayers = (size: number) => {
    const layer = createLayer("Base", size);
    state.editor.layers = [layer];
    state.editor.activeLayerId = layer.id;
    state.editor.history = [];
    state.editor.redo = [];
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
    // Reset view state for the freshly opened texture.
    state.editor.zoom = 1;
    applyZoom();
    setShowGrid(state.editor.showGrid);
    renderRecentColors();
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
      ellipsize(stripHtml(state.project.description) || "A clean resource pack for survival worlds.") ||
      "A clean resource pack for survival worlds.";

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
        exportPackIcon.textContent = "RP";
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

  // ---- Shape / fill / stroke helpers ---------------------------------------

  // While a shape (line/rect/ellipse) is being dragged we keep the layer's
  // pixels from the moment the stroke began so each preview frame can redraw
  // cleanly from a clean slate instead of stacking on the previous preview.
  let shapeOrigin: { x: number; y: number } | null = null;
  let shapeBackup: Array<string | null> | null = null;

  const paintPixel = (
    layer: Layer,
    centerX: number,
    centerY: number,
    erase: boolean,
  ) => {
    const size = state.editor.gridSize;
    const startX = brushOrigin(centerX);
    const startY = brushOrigin(centerY);

    for (let dy = 0; dy < state.editor.brushSize; dy += 1) {
      for (let dx = 0; dx < state.editor.brushSize; dx += 1) {
        const px = startX + dx;
        const py = startY + dy;

        if (px < 0 || py < 0 || px >= size || py >= size) {
          continue;
        }

        layer.pixels[py * size + px] = erase ? null : state.editor.color;
      }
    }
  };

  const floodFill = (originX: number, originY: number) => {
    const layer = activeLayer();

    if (!layer) {
      return;
    }

    const size = state.editor.gridSize;
    const target = layer.pixels[originY * size + originX] ?? null;
    const replacement = state.editor.color;

    if (target === replacement) {
      return;
    }

    const stack: Array<[number, number]> = [[originX, originY]];

    while (stack.length) {
      const [x, y] = stack.pop()!;

      if (x < 0 || y < 0 || x >= size || y >= size) {
        continue;
      }

      const index = y * size + x;

      if ((layer.pixels[index] ?? null) !== target) {
        continue;
      }

      layer.pixels[index] = replacement;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    state.editor.dirty = true;
    renderPixels();
  };

  type Plot = (x: number, y: number) => void;

  const plotLine = (x0: number, y0: number, x1: number, y1: number, plot: Plot) => {
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let cx = x0;
    let cy = y0;

    for (;;) {
      plot(cx, cy);

      if (cx === x1 && cy === y1) {
        break;
      }

      const e2 = 2 * err;

      if (e2 >= dy) {
        err += dy;
        cx += sx;
      }

      if (e2 <= dx) {
        err += dx;
        cy += sy;
      }
    }
  };

  // Snap a line endpoint to the nearest horizontal, vertical, or 45° direction.
  const constrainLine = (
    origin: { x: number; y: number },
    target: { x: number; y: number },
  ) => {
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    if (adx > ady * 2) {
      return { x: target.x, y: origin.y };
    }

    if (ady > adx * 2) {
      return { x: origin.x, y: target.y };
    }

    const d = Math.max(adx, ady);
    return { x: origin.x + Math.sign(dx) * d, y: origin.y + Math.sign(dy) * d };
  };

  const plotRect = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    filled: boolean,
    plot: Plot,
  ) => {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);

    if (filled) {
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          plot(x, y);
        }
      }
      return;
    }

    for (let x = x0; x <= x1; x += 1) {
      plot(x, y0);
      plot(x, y1);
    }

    for (let y = y0; y <= y1; y += 1) {
      plot(x0, y);
      plot(x1, y);
    }
  };

  const plotEllipse = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    filled: boolean,
    plot: Plot,
  ) => {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;

    const inside = (x: number, y: number) => {
      const nx = rx === 0 ? 0 : (x - cx) / rx;
      const ny = ry === 0 ? 0 : (y - cy) / ry;
      return nx * nx + ny * ny <= 1;
    };

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        if (!inside(x, y)) {
          continue;
        }

        if (
          filled ||
          !inside(x - 1, y) ||
          !inside(x + 1, y) ||
          !inside(x, y - 1) ||
          !inside(x, y + 1)
        ) {
          plot(x, y);
        }
      }
    }
  };

  const drawShapePreview = (
    target: { x: number; y: number },
    filledOrConstrain: boolean,
  ) => {
    const layer = activeLayer();

    if (!layer || !shapeOrigin || !shapeBackup) {
      return;
    }

    layer.pixels = shapeBackup.slice();
    const plot: Plot = (x, y) => paintPixel(layer, x, y, false);

    if (state.editor.tool === "line") {
      const end = filledOrConstrain ? constrainLine(shapeOrigin, target) : target;
      plotLine(shapeOrigin.x, shapeOrigin.y, end.x, end.y, plot);
    } else if (state.editor.tool === "rect") {
      plotRect(shapeOrigin, target, filledOrConstrain, plot);
    } else if (state.editor.tool === "ellipse") {
      plotEllipse(shapeOrigin, target, filledOrConstrain, plot);
    }

    state.editor.dirty = true;
    scheduleDraw();
  };

  const beginShapeStroke = (pixel: { x: number; y: number }) => {
    const layer = activeLayer();

    if (!layer) {
      return;
    }

    pushHistory();
    shapeOrigin = { x: pixel.x, y: pixel.y };
    shapeBackup = layer.pixels.slice();
    state.editor.drawing = true;
  };

  const finishShapeStroke = () => {
    shapeOrigin = null;
    shapeBackup = null;
    state.editor.drawing = false;
  };

  const cancelActiveStroke = () => {
    if (shapeOrigin && shapeBackup) {
      const layer = activeLayer();

      if (layer) {
        layer.pixels = shapeBackup.slice();
      }

      shapeOrigin = null;
      shapeBackup = null;
      renderPixels();
    }

    state.editor.drawing = false;
  };

  // ---- Recent colors --------------------------------------------------------

  const renderRecentColors = () => {
    if (!recentColorsEl) {
      return;
    }

    recentColorsEl.replaceChildren();
    state.editor.recentColors.forEach((color) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "recent-color";
      swatch.style.setProperty("--swatch", color);
      swatch.dataset.editorColor = color;
      swatch.title = color;
      swatch.setAttribute("aria-label", `Use ${color}`);
      swatch.addEventListener("click", () => setEditorColor(color));
      recentColorsEl.append(swatch);
    });
  };

  const pushRecentColor = (value: string) => {
    const color = normalizeHexColor(value);

    if (!color) {
      return;
    }

    const next = [color, ...state.editor.recentColors.filter((entry) => entry !== color)];
    state.editor.recentColors = next.slice(0, 10);
    renderRecentColors();
  };

  // ---- Zoom + grid overlay --------------------------------------------------

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 8;

  const positionGridOverlay = () => {
    if (!gridOverlay || !pixelCanvas) {
      return;
    }

    if (!state.editor.showGrid) {
      gridOverlay.style.opacity = "0";
      return;
    }

    const metrics = getCanvasMetrics();
    if (!metrics) {
      return;
    }

    gridOverlay.style.transform = `translate3d(${metrics.offsetLeft}px, ${metrics.offsetTop}px, 0)`;
    gridOverlay.style.width = `${metrics.rect.width}px`;
    gridOverlay.style.height = `${metrics.rect.height}px`;
    gridOverlay.style.setProperty("--grid-cells", String(state.editor.gridSize));
    gridOverlay.style.opacity = "1";
  };

  const applyZoom = () => {
    if (!pixelCanvas) {
      return;
    }

    pixelCanvas.style.width = "";
    pixelCanvas.style.height = "";

    if (state.editor.zoom > 1) {
      const base = pixelCanvas.getBoundingClientRect().width;
      const scaled = Math.round(base * state.editor.zoom);
      pixelCanvas.style.width = `${scaled}px`;
      pixelCanvas.style.height = `${scaled}px`;
    }

    invalidateCanvasRect();
    positionGridOverlay();
  };

  const setZoom = (zoom: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom)));

    if (next === state.editor.zoom) {
      return;
    }

    state.editor.zoom = next;
    applyZoom();
    setStatus(next === 1 ? "Zoom reset to fit." : `Zoom ${next}×.`);
  };

  const zoomBy = (delta: number) => setZoom(state.editor.zoom + delta);

  const setShowGrid = (show: boolean) => {
    state.editor.showGrid = show;
    const button = document.getElementById("toggle-grid");
    button?.classList.toggle("is-active", show);
    button?.setAttribute("aria-pressed", String(show));
    positionGridOverlay();
  };

  const toggleGrid = () => setShowGrid(!state.editor.showGrid);

  const adjustBrush = (delta: number) => {
    const next = Math.max(1, Math.min(8, state.editor.brushSize + delta));

    if (next === state.editor.brushSize) {
      return;
    }

    state.editor.brushSize = next;

    if (brushSize) {
      brushSize.value = String(next);
    }

    setStatus(`Brush size ${next}.`);
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

    const metrics = getCanvasMetrics();

    if (!metrics) {
      hidePixelCursor();
      return;
    }

    const { rect, offsetLeft, offsetTop } = metrics;
    const cell = rect.width / state.editor.gridSize;
    const span = state.editor.tool === "picker" ? 1 : state.editor.brushSize;
    const startX = state.editor.tool === "picker" ? pixel.x : brushOrigin(pixel.x);
    const startY = state.editor.tool === "picker" ? pixel.y : brushOrigin(pixel.y);
    const width = `${cell * span}px`;
    const height = `${cell * span}px`;

    if (pixelCursor.style.width !== width) {
      pixelCursor.style.width = width;
    }
    if (pixelCursor.style.height !== height) {
      pixelCursor.style.height = height;
    }
    pixelCursor.style.transform = `translate3d(${offsetLeft + startX * cell}px, ${offsetTop + startY * cell}px, 0)`;
    pixelCursor.dataset.tool = state.editor.tool;
    pixelCursor.style.opacity = "1";
  };

  pixelCanvas?.addEventListener("contextmenu", (event) => event.preventDefault());
  pixelCanvas?.addEventListener("pointermove", updatePixelCursor);
  pixelCanvas?.addEventListener("pointerenter", updatePixelCursor);
  pixelCanvas?.addEventListener("pointerleave", hidePixelCursor);
  // Shift-drag with pencil/eraser draws a constrained straight line. We reuse
  // the shape backup machinery, remembering whether we're painting or erasing.
  let freehandLineErase: boolean | null = null;

  const drawFreehandLinePreview = (
    target: { x: number; y: number },
    erase: boolean,
  ) => {
    const layer = activeLayer();

    if (!layer || !shapeOrigin || !shapeBackup) {
      return;
    }

    layer.pixels = shapeBackup.slice();
    const end = constrainLine(shapeOrigin, target);
    plotLine(shapeOrigin.x, shapeOrigin.y, end.x, end.y, (x, y) =>
      paintPixel(layer, x, y, erase),
    );
    state.editor.dirty = true;
    scheduleDraw();
  };

  // Hold Space to pan the (zoomed) canvas by dragging.
  let spaceHeld = false;
  let panState: { startX: number; startY: number; scrollLeft: number; scrollTop: number } | null =
    null;

  const sampleColorAt = (pixel: { x: number; y: number }) => {
    const size = state.editor.gridSize;
    const color = compositeLayers(state.editor.layers, size)[pixel.y * size + pixel.x];

    if (color) {
      setEditorColor(color);
    }
  };

  pixelCanvas?.addEventListener("pointerdown", (event) => {
    // Refresh the cached geometry once at the start of every interaction.
    invalidateCanvasRect();

    // Space-pan takes priority over every tool.
    if (spaceHeld && canvasWrap && pixelCanvas) {
      panState = {
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: canvasWrap.scrollLeft,
        scrollTop: canvasWrap.scrollTop,
      };
      pixelCanvas.setPointerCapture(event.pointerId);
      return;
    }

    const pixel = pixelFromEvent(event);

    if (!pixel || !pixelCanvas) {
      return;
    }

    // Alt = temporary eyedropper on any painting tool.
    if (event.altKey && state.editor.tool !== "move") {
      sampleColorAt(pixel);
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

    if (state.editor.tool === "fill") {
      const size = state.editor.gridSize;
      const layer = activeLayer();
      const target = layer ? layer.pixels[pixel.y * size + pixel.x] ?? null : null;

      if (layer && target !== state.editor.color) {
        pushHistory();
        floodFill(pixel.x, pixel.y);
        pushRecentColor(state.editor.color);
      }

      return;
    }

    if (SHAPE_TOOLS.has(state.editor.tool)) {
      beginShapeStroke(pixel);
      pixelCanvas.setPointerCapture(event.pointerId);
      drawShapePreview(pixel, event.shiftKey);
      return;
    }

    // Shift + pencil/eraser starts a constrained straight-line stroke.
    if (event.shiftKey && (state.editor.tool === "pencil" || state.editor.tool === "erase")) {
      beginShapeStroke(pixel);
      freehandLineErase = state.editor.tool === "erase";
      pixelCanvas.setPointerCapture(event.pointerId);
      drawFreehandLinePreview(pixel, freehandLineErase);
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
    if (panState && canvasWrap) {
      canvasWrap.scrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
      canvasWrap.scrollTop = panState.scrollTop - (event.clientY - panState.startY);
      return;
    }

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
        scheduleDraw();
        updateSelectionOverlay();
      }

      return;
    }

    if (!state.editor.drawing) {
      return;
    }

    const pixel = pixelFromEvent(event);

    if (!pixel) {
      return;
    }

    if (freehandLineErase !== null) {
      drawFreehandLinePreview(pixel, freehandLineErase);
      return;
    }

    if (SHAPE_TOOLS.has(state.editor.tool) && shapeOrigin) {
      drawShapePreview(pixel, event.shiftKey);
      return;
    }

    applyTool(pixel.x, pixel.y);
  });
  pixelCanvas?.addEventListener("pointerup", () => {
    if (panState) {
      panState = null;
      return;
    }

    if (freehandLineErase !== null) {
      finishShapeStroke();
      freehandLineErase = null;
      pushRecentColor(state.editor.color);
      finalizeStroke();
      return;
    }

    if (SHAPE_TOOLS.has(state.editor.tool) && shapeOrigin) {
      finishShapeStroke();
      pushRecentColor(state.editor.color);
      finalizeStroke();
      return;
    }

    // Remember the colour for freehand paint strokes (not erase/pick/move).
    if (
      state.editor.drawing &&
      (state.editor.tool === "pencil" || state.editor.tool === "recolor")
    ) {
      pushRecentColor(state.editor.color);
    }

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
        finalizeStroke();
      }

      return;
    }

    state.editor.drawing = false;
    finalizeStroke();
  });
  pixelCanvas?.addEventListener("pointercancel", () => {
    if (panState) {
      panState = null;
      return;
    }

    if (freehandLineErase !== null || (SHAPE_TOOLS.has(state.editor.tool) && shapeOrigin)) {
      cancelActiveStroke();
      freehandLineErase = null;
      return;
    }

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

    // Drop any half-finished line/shape stroke when switching tools.
    if (shapeOrigin) {
      finishShapeStroke();
      freehandLineErase = null;
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

  // Ctrl+1-9 = primary tools. Ctrl+Shift+1-9 and Ctrl+Alt+1-9 are reserved
  // overflow tiers for actions beyond the first nine; a few are wired today and
  // the rest are ready for future tools.
  const PRIMARY_TOOLS: Record<string, Tool> = {
    "1": "pencil",
    "2": "erase",
    "3": "picker",
    "4": "recolor",
    "5": "move",
    "6": "fill",
    "7": "line",
    "8": "rect",
    "9": "ellipse",
  };
  const SECONDARY_ACTIONS: Record<string, () => void> = {
    "1": toggleGrid,
    "2": () => zoomBy(1),
    "3": () => zoomBy(-1),
    "4": () => setZoom(1),
  };
  const TERTIARY_ACTIONS: Record<string, () => void> = {};

  const digitFromEvent = (event: KeyboardEvent) => {
    if (/^[1-9]$/.test(event.key)) {
      return event.key;
    }
    // Fall back to the physical key so Shift/Alt combos (which change event.key)
    // still resolve to the right number.
    return event.code.startsWith("Digit") ? event.code.slice(5) : "";
  };

  document.addEventListener("keydown", (event) => {
    const editorOpen = editorDrawer?.getAttribute("aria-hidden") === "false";

    if (!editorOpen) {
      return;
    }

    const target = event.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    // Hold Space to pan — but never steal Space from a focused control.
    if (
      event.code === "Space" &&
      !typing &&
      (target === document.body ||
        target === pixelCanvas ||
        target === canvasWrap ||
        target === editorDrawer)
    ) {
      spaceHeld = true;
      canvasWrap?.classList.add("is-panning");
      event.preventDefault();
      return;
    }

    const mod = event.ctrlKey || event.metaKey;

    if (mod) {
      const key = event.key.toLowerCase();

      if (!event.altKey && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoEdit();
        } else {
          undoEdit();
        }
        return;
      }

      if (!event.shiftKey && !event.altKey && key === "y") {
        event.preventDefault();
        redoEdit();
        return;
      }

      if (!event.shiftKey && !event.altKey && (key === "delete" || key === "backspace")) {
        event.preventDefault();
        clearActiveLayer();
        return;
      }

      if (!event.shiftKey && !event.altKey && (key === "=" || key === "+")) {
        event.preventDefault();
        zoomBy(1);
        return;
      }

      if (!event.shiftKey && !event.altKey && (key === "-" || key === "_")) {
        event.preventDefault();
        zoomBy(-1);
        return;
      }

      if (!event.shiftKey && !event.altKey && key === "0") {
        event.preventDefault();
        setZoom(1);
        return;
      }

      const digit = digitFromEvent(event);

      if (digit) {
        if (event.altKey && !event.shiftKey) {
          const action = TERTIARY_ACTIONS[digit];
          if (action) {
            event.preventDefault();
            action();
          }
          return;
        }

        if (event.shiftKey && !event.altKey) {
          const action = SECONDARY_ACTIONS[digit];
          if (action) {
            event.preventDefault();
            action();
          }
          return;
        }

        if (!event.shiftKey && !event.altKey) {
          const tool = PRIMARY_TOOLS[digit];
          if (tool) {
            event.preventDefault();
            setActiveTool(tool);
          }
        }
      }

      return;
    }

    if (typing) {
      return;
    }

    if (event.key === "[") {
      event.preventDefault();
      adjustBrush(-1);
      return;
    }

    if (event.key === "]") {
      event.preventDefault();
      adjustBrush(1);
    }
  });

  document.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      spaceHeld = false;
      panState = null;
      canvasWrap?.classList.remove("is-panning");
    }
  });

  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    if (editorDrawer?.getAttribute("aria-hidden") !== "false" || resizeFrame) {
      return;
    }

    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      applyZoom();
    });
  });

  // Panning the zoomed canvas moves it, so the cached geometry must refresh.
  canvasWrap?.addEventListener("scroll", invalidateCanvasRect, { passive: true });

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
    state.editor.redo = [];
    state.editor.dirty = true;
    renderLayers();
    renderPixels();
    positionGridOverlay();
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

  document.getElementById("clear-canvas")?.addEventListener("click", clearActiveLayer);
  document.getElementById("undo-canvas")?.addEventListener("click", undoEdit);
  document.getElementById("redo-canvas")?.addEventListener("click", redoEdit);
  document.getElementById("zoom-in")?.addEventListener("click", () => zoomBy(1));
  document.getElementById("zoom-out")?.addEventListener("click", () => zoomBy(-1));
  document.getElementById("toggle-grid")?.addEventListener("click", toggleGrid);

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

    if (event.key === "Escape" && resourceAiSetupModal?.getAttribute("aria-hidden") === "false") {
      closeResourceAiSetup();
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

  assetGrid?.addEventListener("scroll", scheduleAssetWindowRender, { passive: true });

  if (assetGrid && "ResizeObserver" in window) {
    new ResizeObserver(() => {
      updateAssetGridMetrics();
      renderedAssetWindow = "";
      scheduleAssetWindowRender();
    }).observe(assetGrid);
  } else {
    window.addEventListener("resize", () => {
      updateAssetGridMetrics();
      renderedAssetWindow = "";
      scheduleAssetWindowRender();
    });
  }

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
    showScreen("home-screen");
  });

  document.querySelectorAll<HTMLButtonElement>("[data-ai-provider]").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = button.dataset.aiProvider as ResourceAiProvider | undefined;

      if (isResourceAiProvider(provider)) {
        selectResourceAiProvider(provider);
      }
    });
  });

  resourceAiModelInput?.addEventListener("input", syncResourceAiModelPresets);

  resourceAiSetupForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const settings = RESOURCE_AI_PROVIDERS[resourceAiSelectedProvider];
    const model = resourceAiModelInput?.value.trim() ?? "";
    const apiKey = resourceAiApiKeyInput?.value.trim() ?? "";
    const baseUrl = resourceAiBaseUrlInput?.value.trim() || settings.baseUrl;

    if (!model) {
      resourceAiModelInput?.focus();
      setStatus("Choose an AI model.");
      return;
    }

    if (settings.apiKeyRequired && !apiKey) {
      resourceAiApiKeyInput?.focus();
      setStatus("Enter an API key.");
      return;
    }

    saveResourceAiConfig({
      provider: resourceAiSelectedProvider,
      baseUrl,
      apiKey,
      model,
    });
    closeResourceAiSetup();
    setStatus(`${settings.title} is ready.`);
    syncResourceAiSend();
    updateResourceAiImageWarning();
  });

  resourceAiSetupClose?.addEventListener("click", closeResourceAiSetup);
  resourceAiCancelSetup?.addEventListener("click", closeResourceAiSetup);
  resourceAiSetupModal?.addEventListener("mousedown", (event) => {
    if (event.target === resourceAiSetupModal) {
      closeResourceAiSetup();
    }
  });

  resourceAiPlus?.addEventListener("click", () => {
    resourceAiImageInput?.click();
  });

  resourceAiImageInput?.addEventListener("change", () => {
    void addResourceAiPendingImages(resourceAiImageInput.files);
    resourceAiImageInput.value = "";
  });

  resourceAiNewConversation?.addEventListener("click", resetResourceAiConversation);

  const resourceAiSettings = document.getElementById("resource-ai-settings") as HTMLButtonElement | null;
  resourceAiSettings?.addEventListener("click", openResourceAiSetup);

  // The shader workspace's AI panel opens the same provider setup modal.
  document.addEventListener("anvil:open-ai-setup", openResourceAiSetup);

  resourceAiToggle?.addEventListener("click", () => {
    setResourceAiCollapsed(!isResourceAiCollapsedOrCollapsing());
  });

  document.getElementById("resource-ai-composer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (resourceAiRequestActive) {
      stopResourceAiRequest();
      return;
    }
    void submitResourceAiPrompt(resourceAiInput?.value ?? "");
  });

  resourceAiInput?.addEventListener("input", () => {
    resizeResourceAiInput();
    syncResourceAiSend();
  });

  resourceAiInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitResourceAiPrompt(resourceAiInput.value);
    } else if (event.key === "Enter" && event.shiftKey) {
      window.setTimeout(resizeResourceAiInput);
    }
  });

  resourceAiInput?.addEventListener("paste", (event) => {
    const imageFiles = resourceImageFilesFromPaste(event.clipboardData);
    if (!imageFiles.length) {
      return;
    }
    event.preventDefault();
    void addResourceAiPendingImages(imageFiles);
  });

  syncResourceAiSend();

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
      showScreen("project-workspace");
      closeEditor();
      closeExportModal();
      resetResourceAiConversation();
      setStatus("Loading vanilla textures for this Minecraft version...");
      void loadAssets();
    },
  };
}
