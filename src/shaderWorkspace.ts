import { invoke } from "@tauri-apps/api/core";
import { parseAiReply } from "./aiReply";
import { newAiStreamId, onAiStream } from "./aiStream";
import { showScreen } from "./screenTransition";
import { shaderOptionGroupById, shaderOptionGroups } from "./shaderOptions";
import type { ShaderOptionCategory, ShaderOptionControl, ShaderOptionValue } from "./shaderOptions";
import {
  buildLangFile,
  buildOptionsGlsl,
  buildShaderProperties,
  defaultVisualSettings,
} from "./shaderOptionsCodegen";
import type { VisualSettings } from "./shaderOptionsCodegen";

type ShaderMode = "visual" | "code";
type CodeTab = "explorer" | "editor";

type ShaderProject = {
  id?: string;
  name: string;
  minecraftVersion?: string;
  packVersion?: string;
  author?: string;
  description?: string;
  iconDataUrl?: string;
};

type ShaderFile = {
  id: string;
  name: string;
  path: string;
  language: string;
  description: string;
  contents: string;
  saved: boolean;
};

type ShaderExportResult =
  | string
  | {
      path: string;
      file_count?: number;
      fileCount?: number;
    };

type FolderNode = { type: "folder"; name: string; path: string; children: TreeNode[] };
type FileNode = { type: "file"; name: string; path: string; file: ShaderFile };
type TreeNode = FolderNode | FileNode;
type AiPendingImage = { id: string; name: string; url: string; size: number };

const SHADER_FILES_STORAGE_KEY = "anvil.shaderFiles.preview";

// Generated sources of truth. The shader passes are static templates that
// #include the options file and consume its #defines (real Iris option
// system); shaders.properties lays out the in-game menu, the lang file names
// the options.
const GENERATED_OPTIONS_PATH = "anvil_options.glsl";
const GENERATED_PROPERTIES_PATH = "shaders.properties";
const GENERATED_LANG_PATH = "lang/en_us.lang";
const GENERATED_PATHS = new Set([GENERATED_OPTIONS_PATH, GENERATED_PROPERTIES_PATH, GENERATED_LANG_PATH]);

// Newest first. The selector targets Iris, where the loader is fixed and the
// Minecraft version decides which features/options are available.
// The GLSL pipeline is written and validated against Iris on 1.21.x only —
// older targets are untested (modern Iris uniforms, modern block IDs).
const SHADER_VERSIONS = ["1.21"];
const DEFAULT_SHADER_VERSION = "1.21";

const parseVersion = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);

const versionAtLeast = (current: string, min: string) => {
  const a = parseVersion(current);
  const b = parseVersion(min);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return true;
};
const AI_PANEL_TRANSITION_MS = 220;
const SHADER_COLOR_PRESETS = [
  "#79c0ff",
  "#7ee787",
  "#ffce67",
  "#ff9ddb",
  "#d2a8ff",
  "#ffffff",
  "#8b949e",
  "#050505",
];

const defaultSettings = defaultVisualSettings;

// Browser-preview fallback: mirror the real shader pack templates that the
// desktop backend serves, loaded straight from the shared shaderpack sources.
// The `v` query is a cache-buster: the webview once stored these module URLs
// with a broken MIME type, and bumping the query sidesteps any such stale
// disk-cache entry for good (see shaderPackRawMime in vite.config.ts).
const shaderPackSources = import.meta.glob("/src-tauri/shaderpack/shaders/**/*", {
  query: "?raw&v=2",
  import: "default",
  eager: true,
}) as Record<string, string>;

const starterFiles: ShaderFile[] = Object.entries(shaderPackSources)
  .map(([fullPath, contents]) => {
    const path = fullPath.replace("/src-tauri/shaderpack/shaders/", "");
    return {
      id: path,
      name: baseOf(path),
      path,
      language: languageForPath(path),
      description: "Anvil shader pack template.",
      contents,
      saved: false,
    };
  })
  .sort((a, b) => a.path.localeCompare(b.path));

function cloneStarterFiles() {
  return starterFiles.map((file) => ({ ...file }));
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

function normalizeFile(raw: ShaderFile): ShaderFile {
  return {
    id: String(raw.id),
    name: String(raw.name),
    path: String(raw.path),
    language: String(raw.language),
    description: String(raw.description ?? ""),
    contents: String(raw.contents ?? ""),
    saved: Boolean(raw.saved),
  };
}

function projectFallbackId(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "shader";
}

function readPreviewFiles(projectId: string) {
  try {
    const allFiles = JSON.parse(localStorage.getItem(SHADER_FILES_STORAGE_KEY) ?? "{}") as Record<
      string,
      Record<string, string>
    >;
    const saved = allFiles[projectId] ?? {};

    return cloneStarterFiles().map((file) => ({
      ...file,
      contents: saved[file.id] ?? file.contents,
      saved: Boolean(saved[file.id]),
    }));
  } catch (error) {
    console.warn("Failed to read preview shader files.", error);
    return cloneStarterFiles();
  }
}

function writePreviewFile(projectId: string, file: ShaderFile) {
  const allFiles = JSON.parse(localStorage.getItem(SHADER_FILES_STORAGE_KEY) ?? "{}") as Record<
    string,
    Record<string, string>
  >;
  allFiles[projectId] ??= {};
  allFiles[projectId][file.id] = file.contents;
  localStorage.setItem(SHADER_FILES_STORAGE_KEY, JSON.stringify(allFiles));
}

function formatExportResult(result: ShaderExportResult) {
  if (typeof result === "string") {
    return result;
  }

  const count = result.file_count ?? result.fileCount;
  return count === undefined ? result.path : `${result.path} (${count} shader files)`;
}

function stripHtml(value = "") {
  const element = document.createElement("div");
  element.innerHTML = value;
  return element.textContent ?? "";
}

function dirOf(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function baseOf(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function joinPath(dir: string, name: string) {
  return dir ? `${dir}/${name}` : name;
}

function languageForPath(path: string) {
  const base = baseOf(path).toLowerCase();

  if (base.endsWith(".properties")) {
    return "Properties";
  }

  if (base.endsWith(".vsh") || base.endsWith(".fsh") || base.endsWith(".glsl")) {
    return "GLSL";
  }

  return "Text";
}

export function initShaderWorkspace() {
  const projectIcon = document.getElementById("shader-project-icon");
  const projectName = document.getElementById("shader-project-name");
  const fileCount = document.getElementById("shader-file-count");
  const savedCount = document.getElementById("shader-saved-count");
  const status = document.getElementById("shader-status");
  const modeKicker = document.getElementById("shader-mode-kicker");
  const modeTitle = document.getElementById("shader-mode-title");
  const categoryBrowser = document.getElementById("shader-category-browser");
  const categoryEditor = document.getElementById("shader-category-editor");
  const categoryTitle = document.getElementById("shader-category-title");
  const categorySummary = document.getElementById("shader-category-summary");
  const categoryBody = document.getElementById("shader-category-editor-body");
  const shaderWorkbench = document.querySelector<HTMLElement>(".shader-workbench");

  const tree = document.getElementById("code-tree");
  const editorPath = document.getElementById("code-editor-path");
  const editorEmpty = document.getElementById("code-editor-empty");
  const code = document.getElementById("shader-code") as HTMLTextAreaElement | null;
  const editorStack = document.getElementById("code-editor-stack");
  const editorGutter = document.getElementById("code-editor-gutter");
  const editorHighlight = document.getElementById("code-editor-highlight");
  const editorHighlightCode = document.getElementById("code-editor-highlight-code");
  const editorLang = document.getElementById("code-editor-lang");
  const autosaveStatus = document.getElementById("shader-autosave-status");
  const shaderScreen = document.getElementById("shader-workspace");

  const aiThread = document.getElementById("ai-thread");
  const aiInput = document.getElementById("ai-input") as HTMLTextAreaElement | null;
  const aiSend = document.getElementById("ai-send") as HTMLButtonElement | null;
  const aiPendingAttachments = document.getElementById("ai-pending-attachments");
  const aiPlus = document.getElementById("ai-plus") as HTMLButtonElement | null;
  const aiImageInput = document.getElementById("ai-image-input") as HTMLInputElement | null;
  const aiNewConversation = document.getElementById("ai-new-conversation") as HTMLButtonElement | null;
  const aiToggle = document.getElementById("shader-ai-toggle") as HTMLButtonElement | null;
  const aiContextStatus = document.getElementById("ai-context-status");

  const modeCopy: Record<ShaderMode, { kicker: string; title: string }> = {
    visual: { kicker: "Visual Builder", title: "Design your shader" },
    code: { kicker: "Code Editor", title: "Files & GLSL" },
  };

  let fileSeq = 0;

  const state: {
    project: ShaderProject;
    files: ShaderFile[];
    folders: string[];
    expanded: Set<string>;
    selectedPath: string | null;
    activeFileId: string | null;
    mode: ShaderMode;
    codeTab: CodeTab;
    settings: VisualSettings;
  } = {
    project: { id: "shader", name: "Untitled Shader", author: "Me!", description: "" },
    files: cloneStarterFiles(),
    folders: [],
    expanded: new Set<string>(),
    selectedPath: null,
    activeFileId: null,
    mode: "visual",
    codeTab: "explorer",
    settings: defaultSettings(),
  };

  const setStatus = (message: string) => {
    if (status) {
      status.textContent = message;
    }
  };

  const savedShaderOptionValues = new Map<string, ShaderOptionValue>();
  const draftShaderOptionValues = new Map<string, ShaderOptionValue>();
  // Generated files the user has hand-edited in the code editor. Code wins: the
  // visual builder stops regenerating these so manual edits are never clobbered.
  const manualGeneratedPaths = new Set<string>();
  let activeShaderCategory: ShaderOptionCategory | null = null;
  let categoryTransitionTimer = 0;
  let browserExitTimer = 0;
  let optionTooltip: HTMLDivElement | null = null;
  let aiPendingImages: AiPendingImage[] = [];
  let aiPendingImageSeq = 0;
  let aiPanelTimer = 0;
  let aiPanelFrame = 0;

  const CATEGORY_TRANSITION_MS = 220;
  const CATEGORY_BROWSER_EXIT_MS = 120;

  const fileById = (id: string | null) =>
    id ? state.files.find((file) => file.id === id) ?? null : null;

  const fileByPath = (path: string) => state.files.find((file) => file.path === path) ?? null;

  let aiLastTotalTokens: number | null = null;

  const updateAiContext = () => {
    if (!aiContextStatus) {
      return;
    }

    // Running total for this conversation: provider-reported counts when
    // available, ~4 chars/token estimates otherwise — hence the "~".
    aiContextStatus.textContent =
      aiLastTotalTokens == null ? "No tokens used yet" : `~${aiLastTotalTokens.toLocaleString()} tokens used`;
  };

  const updateCounts = () => {
    if (fileCount) {
      fileCount.textContent = String(state.files.length);
    }

    if (savedCount) {
      savedCount.textContent = String(state.files.filter((file) => file.saved).length);
    }

    updateAiContext();
  };

  // ---- Version / Iris targeting ---------------------------------------------

  const selectedVersion = () => state.project.minecraftVersion || DEFAULT_SHADER_VERSION;

  const controlAvailable = (control: ShaderOptionControl) =>
    !control.minVersion || versionAtLeast(selectedVersion(), control.minVersion);

  const categoryAvailable = (category: ShaderOptionCategory) =>
    !category.minVersion || versionAtLeast(selectedVersion(), category.minVersion);

  // Hide category buttons whose category needs a newer Minecraft version.
  const applyVersionToBrowser = () => {
    document.querySelectorAll<HTMLButtonElement>("[data-shader-category]").forEach((button) => {
      const category = shaderOptionGroupById.get(button.dataset.shaderCategory ?? "");
      button.hidden = category ? !categoryAvailable(category) : false;
    });
  };

  // ---- Visual builder -> generated code -------------------------------------

  // Every option becomes a #define (with an Iris-readable value list) so the
  // visual editor is just a friendly front-end for real, exportable code.
  // Hidden-for-version controls still emit their defaults so the pack always
  // compiles.
  const optionResolver = (control: ShaderOptionControl): ShaderOptionValue =>
    savedShaderOptionValues.get(control.id) ?? control.value;

  // Write generated contents back into the matching files (creating them if the
  // user removed them) and mark them unsaved so they show up as pending writes.
  // Files the user has hand-edited are left alone — code overrides the visuals.
  const writeGenerated = (path: string, language: string, contents: string) => {
    const existing = fileByPath(path);

    if (existing && manualGeneratedPaths.has(path)) {
      return existing;
    }

    if (existing) {
      existing.contents = contents;
      existing.saved = false;
      return existing;
    }

    fileSeq += 1;
    const created: ShaderFile = {
      id: `generated-${fileSeq}`,
      name: baseOf(path),
      path,
      language,
      description: "Generated by the Visual builder.",
      contents,
      saved: false,
    };
    state.files.push(created);
    return created;
  };

  const regenerateFromVisual = () => {
    writeGenerated(GENERATED_OPTIONS_PATH, "GLSL", buildOptionsGlsl(selectedVersion(), state.settings, optionResolver));
    writeGenerated(GENERATED_PROPERTIES_PATH, "Properties", buildShaderProperties(optionResolver));
    writeGenerated(GENERATED_LANG_PATH, "Properties", buildLangFile());

    // Keep the open editor in sync if it shows a generated file (and the user
    // hasn't taken it over).
    const active = fileById(state.activeFileId);
    if (active && GENERATED_PATHS.has(active.path) && !manualGeneratedPaths.has(active.path) && code) {
      code.value = active.contents;
      renderEditorDecorations();
    }

    renderTree();
    updateCounts();
    markDirty();
  };

  // ---- Visual control wiring ------------------------------------------------

  const visualRanges: Array<{ id: string; key: keyof VisualSettings; decimals: number }> = [
    { id: "visual-exposure", key: "exposure", decimals: 2 },
    { id: "visual-contrast", key: "contrast", decimals: 2 },
    { id: "visual-saturation", key: "saturation", decimals: 2 },
    { id: "visual-fog", key: "fog", decimals: 2 },
    { id: "visual-bloom", key: "bloom", decimals: 2 },
  ];

  const visualColors: Array<{ id: string; key: "lightColor" | "skyColor" | "waterColor" }> = [
    { id: "visual-light-color", key: "lightColor" },
    { id: "visual-sky-color", key: "skyColor" },
    { id: "visual-water-color", key: "waterColor" },
  ];

  const visualToggles: Array<{ id: string; key: keyof VisualSettings["effects"] }> = [
    { id: "visual-toggle-bloom", key: "bloom" },
    { id: "visual-toggle-foliage", key: "foliage" },
    { id: "visual-toggle-water", key: "water" },
    { id: "visual-toggle-vignette", key: "vignette" },
    { id: "visual-toggle-sharpen", key: "sharpen" },
  ];

  // Push the current settings out to every control (used on open and by the AI).
  const syncVisualControls = () => {
    visualRanges.forEach(({ id, key, decimals }) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      const output = document.getElementById(`${id}-value`);
      const value = state.settings[key] as number;
      if (input) {
        input.value = String(value);
      }
      if (output) {
        output.textContent = value.toFixed(decimals);
      }
    });

    visualColors.forEach(({ id, key }) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      const chip = document.getElementById(`${id}-chip`);
      const hex = document.getElementById(`${id}-hex`);
      const value = state.settings[key];
      if (input) {
        input.value = value;
      }
      if (chip) {
        chip.style.background = value;
      }
      if (hex) {
        hex.textContent = value;
      }
    });

    visualToggles.forEach(({ id, key }) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input) {
        input.checked = state.settings.effects[key];
      }
    });
  };

  const bindVisualControls = () => {
    visualRanges.forEach(({ id, key, decimals }) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      const output = document.getElementById(`${id}-value`);
      input?.addEventListener("input", () => {
        const value = Number(input.value);
        (state.settings[key] as number) = value;
        if (output) {
          output.textContent = value.toFixed(decimals);
        }
        regenerateFromVisual();
        setStatus(`Updated ${key} to ${value.toFixed(decimals)}.`);
      });
    });

    visualColors.forEach(({ id, key }) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      const chip = document.getElementById(`${id}-chip`);
      const hex = document.getElementById(`${id}-hex`);
      input?.addEventListener("input", () => {
        state.settings[key] = input.value;
        if (chip) {
          chip.style.background = input.value;
        }
        if (hex) {
          hex.textContent = input.value;
        }
        regenerateFromVisual();
        setStatus(`Updated color to ${input.value}.`);
      });
    });

    visualToggles.forEach(({ id, key }) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      input?.addEventListener("change", () => {
        state.settings.effects[key] = input.checked;
        regenerateFromVisual();
        setStatus(`${input.checked ? "Enabled" : "Disabled"} ${key}.`);
      });
    });
  };

  // ---- Shader category editor ----------------------------------------------

  const defaultOptionValue = (control: ShaderOptionControl) => control.value;

  const savedOptionValue = (control: ShaderOptionControl) =>
    savedShaderOptionValues.has(control.id)
      ? savedShaderOptionValues.get(control.id) ?? defaultOptionValue(control)
      : defaultOptionValue(control);

  const draftOptionValue = (control: ShaderOptionControl) =>
    draftShaderOptionValues.has(control.id)
      ? draftShaderOptionValues.get(control.id) ?? savedOptionValue(control)
      : savedOptionValue(control);

  // Options commit as soon as they change — the regenerate is debounced so a
  // slider drag doesn't rebuild the generated files on every input event.
  let optionRegenerateTimer = 0;

  const setDraftOptionValue = (control: ShaderOptionControl, value: ShaderOptionValue) => {
    draftShaderOptionValues.set(control.id, value);
    savedShaderOptionValues.set(control.id, value);
    window.clearTimeout(optionRegenerateTimer);
    optionRegenerateTimer = window.setTimeout(() => {
      optionRegenerateTimer = 0;
      regenerateFromVisual();
    }, 150);
  };

  const clearCategoryTransitionTimers = () => {
    if (categoryTransitionTimer) {
      window.clearTimeout(categoryTransitionTimer);
      categoryTransitionTimer = 0;
    }
    if (browserExitTimer) {
      window.clearTimeout(browserExitTimer);
      browserExitTimer = 0;
    }
  };

  const resetCategoryAnimationClasses = () => {
    categoryBrowser?.classList.remove("shader-category-browser--enter", "shader-category-browser--exit");
    categoryEditor?.classList.remove("shader-category-editor--enter", "shader-category-editor--exit");
  };

  const clearActiveCategoryButton = () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-shader-category].is-active")
      .forEach((button) => button.classList.remove("is-active"));
  };

  const closeOpenOptionMenus = (except?: HTMLElement) => {
    document.querySelectorAll<HTMLElement>(".shader-option-select").forEach((select) => {
      if (except && select === except) {
        return;
      }

      select.classList.remove("is-open");
      select.querySelector<HTMLButtonElement>(".shader-option-select-trigger")?.setAttribute("aria-expanded", "false");
      select.querySelector<HTMLElement>(".shader-option-select-menu")?.setAttribute("aria-hidden", "true");
    });
  };

  const ensureOptionTooltip = () => {
    if (!optionTooltip) {
      optionTooltip = document.createElement("div");
      optionTooltip.className = "shader-option-tooltip";
      optionTooltip.setAttribute("role", "tooltip");
      optionTooltip.hidden = true;
      document.body.append(optionTooltip);
    }

    return optionTooltip;
  };

  const hideOptionTooltip = () => {
    if (!optionTooltip) {
      return;
    }

    optionTooltip.hidden = true;
    optionTooltip.classList.remove("is-visible");
  };

  const showOptionTooltip = (anchor: HTMLElement, text: string) => {
    const tooltip = ensureOptionTooltip();
    const viewportMargin = 12;
    const maxWidth = Math.max(160, Math.min(260, window.innerWidth - viewportMargin * 2));

    tooltip.textContent = text;
    tooltip.style.maxWidth = `${maxWidth}px`;
    tooltip.style.left = "0";
    tooltip.style.top = "0";
    tooltip.style.visibility = "hidden";
    tooltip.hidden = false;

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const preferredLeft = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
    const preferredTop = anchorRect.bottom + 8;
    const fallbackTop = anchorRect.top - tooltipRect.height - 8;
    const maxLeft = window.innerWidth - tooltipRect.width - viewportMargin;
    const maxTop = window.innerHeight - tooltipRect.height - viewportMargin;
    const left = Math.min(Math.max(viewportMargin, preferredLeft), Math.max(viewportMargin, maxLeft));
    const top =
      preferredTop + tooltipRect.height <= window.innerHeight - viewportMargin
        ? preferredTop
        : Math.min(Math.max(viewportMargin, fallbackTop), Math.max(viewportMargin, maxTop));

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.visibility = "visible";
    tooltip.classList.add("is-visible");
  };

  const describeOption = (control: ShaderOptionControl) =>
    control.description ??
    `Adjusts ${control.label.toLowerCase()} for ${activeShaderCategory?.title.toLowerCase() ?? "this shader category"}.`;

  const createHelpButton = (control: ShaderOptionControl) => {
    const help = document.createElement("button");
    help.type = "button";
    help.className = "shader-option-help";
    help.textContent = "?";
    help.setAttribute("aria-label", `${control.label} help`);

    const show = () => showOptionTooltip(help, describeOption(control));
    help.addEventListener("mouseenter", show);
    help.addEventListener("focus", show);
    help.addEventListener("mouseleave", hideOptionTooltip);
    help.addEventListener("blur", hideOptionTooltip);
    help.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      show();
    });

    return help;
  };

  const createOptionControl = (control: ShaderOptionControl) => {
    const field = document.createElement("div");
    field.className = `shader-option-control shader-option-control--${control.kind}`;

    const top = document.createElement("span");
    top.className = "shader-option-control-top";

    const labelWrap = document.createElement("span");
    labelWrap.className = "shader-option-label";

    const label = document.createElement("strong");
    label.textContent = control.label;

    // Reset affordance — only shown once the value drifts from its default.
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "shader-option-reset";
    resetButton.textContent = "↺";
    resetButton.hidden = true;
    resetButton.title = "Reset to default";
    resetButton.setAttribute("aria-label", `Reset ${control.label} to default`);

    labelWrap.append(label, createHelpButton(control), resetButton);
    top.append(labelWrap);

    const value = draftOptionValue(control);
    const defaultValue = control.value;

    // Each control kind registers how to push a value back into its widget so
    // the reset button can restore the default both in state and on screen.
    let applyValue: (next: ShaderOptionValue) => void = () => {};

    const syncReset = () => {
      resetButton.hidden = draftOptionValue(control) === defaultValue;
    };

    resetButton.addEventListener("click", () => {
      setDraftOptionValue(control, defaultValue);
      applyValue(defaultValue);
      syncReset();
    });

    if (control.kind === "range") {
      const min = control.min ?? 0;
      const max = control.max ?? 1;

      const output = document.createElement("output");
      top.append(output);

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(control.step ?? 0.01);
      input.setAttribute("aria-label", control.label);

      const format = (raw: number) => (Number.isInteger(raw) ? String(raw) : raw.toFixed(2));

      const paintFill = (raw: number) => {
        const fraction = max === min ? 0 : (raw - min) / (max - min);
        input.style.setProperty("--range-p", String(Math.min(1, Math.max(0, fraction))));
      };

      applyValue = (next) => {
        const raw = Number(next);
        input.value = String(raw);
        output.textContent = format(raw);
        paintFill(raw);
      };

      input.addEventListener("input", () => {
        const nextValue = Number(input.value);
        setDraftOptionValue(control, nextValue);
        output.textContent = format(nextValue);
        paintFill(nextValue);
        syncReset();
      });

      applyValue(Number(value));
      field.append(top, input);
      syncReset();
      return field;
    }

    if (control.kind === "toggle") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("aria-label", control.label);

      const switchTrack = document.createElement("button");
      switchTrack.type = "button";
      switchTrack.className = "shader-option-switch";
      switchTrack.setAttribute("aria-label", control.label);

      const updateToggle = (checked: boolean, record: boolean) => {
        input.checked = checked;
        if (record) {
          setDraftOptionValue(control, checked);
        }
        switchTrack.setAttribute("aria-pressed", String(checked));
      };

      applyValue = (next) => updateToggle(Boolean(next), false);

      updateToggle(Boolean(value), false);
      input.addEventListener("change", () => {
        updateToggle(input.checked, true);
        syncReset();
      });
      switchTrack.addEventListener("click", () => {
        updateToggle(!input.checked, true);
        syncReset();
      });

      field.append(input, switchTrack, top);
      syncReset();
      return field;
    }

    if (control.kind === "color") {
      const output = document.createElement("output");
      top.append(output);

      const colorControl = document.createElement("div");
      colorControl.className = "shader-color-control";

      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "shader-color-swatch";
      swatch.setAttribute("aria-label", control.label);

      const input = document.createElement("input");
      input.className = "shader-color-hex";
      input.type = "text";
      input.maxLength = 7;
      input.spellcheck = false;
      input.setAttribute("aria-label", `${control.label} hex`);

      const palette = document.createElement("div");
      palette.className = "shader-color-palette";
      palette.setAttribute("aria-label", `${control.label} presets`);

      const normalizeColor = (next: ShaderOptionValue) => {
        const raw = String(next).trim();
        const withHash = raw.startsWith("#") ? raw : `#${raw}`;

        return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : "";
      };

      const updateColor = (next: ShaderOptionValue, record: boolean) => {
        const normalized = normalizeColor(next);

        if (!normalized) {
          return false;
        }

        input.value = normalized;
        output.textContent = normalized;
        swatch.style.setProperty("--shader-option-color", normalized);

        if (record) {
          setDraftOptionValue(control, normalized);
        }

        return true;
      };

      applyValue = (next) => {
        updateColor(next, false);
      };

      applyValue(value);

      input.addEventListener("input", () => {
        const changed = updateColor(input.value, true);

        if (changed) {
          syncReset();
        }
      });

      input.addEventListener("blur", () => {
        if (!updateColor(input.value, true)) {
          applyValue(draftOptionValue(control));
        }
        syncReset();
      });

      SHADER_COLOR_PRESETS.forEach((preset) => {
        const presetButton = document.createElement("button");
        presetButton.type = "button";
        presetButton.className = "shader-color-preset";
        presetButton.style.setProperty("--shader-option-color", preset);
        presetButton.setAttribute("aria-label", preset);
        presetButton.addEventListener("click", () => {
          updateColor(preset, true);
          syncReset();
        });
        palette.append(presetButton);
      });

      swatch.addEventListener("click", () => {
        input.focus();
        input.select();
      });

      colorControl.append(swatch, input, palette);
      field.append(top, colorControl);
      syncReset();
      return field;
    }

    const select = document.createElement("div");
    select.className = "custom-select shader-option-select";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "custom-select-trigger shader-option-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const selectedLabel = document.createElement("span");

    const caret = document.createElement("span");
    caret.className = "custom-select-caret";
    caret.setAttribute("aria-hidden", "true");

    trigger.append(selectedLabel, caret);

    const menu = document.createElement("div");
    menu.className = "custom-select-menu shader-option-select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-hidden", "true");

    const setMenuOpen = (isOpen: boolean) => {
      if (isOpen) {
        closeOpenOptionMenus(select);
      }
      select.classList.toggle("is-open", isOpen);
      trigger.setAttribute("aria-expanded", String(isOpen));
      menu.setAttribute("aria-hidden", String(!isOpen));
    };

    const setSelected = (option: string, record: boolean) => {
      selectedLabel.textContent = option;
      if (record) {
        setDraftOptionValue(control, option);
      }
      menu.querySelectorAll<HTMLButtonElement>(".custom-select-option").forEach((button) => {
        const isSelected = button.dataset.value === option;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-selected", String(isSelected));
      });
    };

    applyValue = (next) => setSelected(String(next), false);

    (control.options ?? []).forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "custom-select-option";
      item.setAttribute("role", "option");
      item.textContent = option;
      item.dataset.value = option;
      item.addEventListener("click", () => {
        setSelected(option, true);
        setMenuOpen(false);
        syncReset();
      });
      menu.append(item);
    });

    setSelected(String(value), false);

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = trigger.getAttribute("aria-expanded") === "true";
      setMenuOpen(!isOpen);
    });
    select.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        trigger.focus();
      }
    });

    select.append(trigger, menu);
    field.append(top, select);
    syncReset();
    return field;
  };

  const renderCategoryEditor = (category: ShaderOptionCategory) => {
    if (!categoryBody) {
      return;
    }

    closeOpenOptionMenus();
    hideOptionTooltip();
    categoryBody.textContent = "";

    let hiddenForVersion = 0;
    category.sections.forEach((section) => {
      const available = section.controls.filter((control) => {
        const ok = controlAvailable(control);
        if (!ok) {
          hiddenForVersion += 1;
        }
        return ok;
      });

      if (!available.length) {
        return;
      }

      const panel = document.createElement("section");
      panel.className = "shader-option-section";

      const title = document.createElement("h4");
      title.textContent = section.title;

      const controls = document.createElement("div");
      controls.className = "shader-option-grid";
      available.forEach((control) => controls.append(createOptionControl(control)));

      panel.append(title, controls);
      categoryBody.append(panel);
    });

    if (hiddenForVersion > 0) {
      const note = document.createElement("p");
      note.className = "shader-option-version-note";
      note.textContent = `${hiddenForVersion} option${hiddenForVersion === 1 ? "" : "s"} hidden — only available on newer Minecraft versions.`;
      categoryBody.append(note);
    }
  };

  const openCategoryEditor = (category: ShaderOptionCategory) => {
    activeShaderCategory = category;
    draftShaderOptionValues.clear();
    category.sections.forEach((section) => {
      section.controls.forEach((control) => {
        draftShaderOptionValues.set(control.id, savedOptionValue(control));
      });
    });

    if (categoryTitle) {
      categoryTitle.textContent = category.title;
    }
    if (categorySummary) {
      categorySummary.textContent = category.summary;
    }

    clearCategoryTransitionTimers();
    closeOpenOptionMenus();
    hideOptionTooltip();
    renderCategoryEditor(category);

    const launchEditor = () => {
      categoryBrowser?.setAttribute("hidden", "");
      resetCategoryAnimationClasses();
      categoryEditor?.removeAttribute("hidden");
      void categoryEditor?.offsetWidth;
      categoryEditor?.classList.add("shader-category-editor--enter");
      if (categoryEditor?.parentElement) {
        categoryEditor.parentElement.scrollTop = 0;
      }
      categoryTransitionTimer = window.setTimeout(() => {
        categoryEditor?.classList.remove("shader-category-editor--enter");
        categoryTransitionTimer = 0;
      }, CATEGORY_TRANSITION_MS);
      setStatus(`${category.title} options opened.`);
    };

    if (categoryBrowser && !categoryBrowser.hasAttribute("hidden")) {
      resetCategoryAnimationClasses();
      categoryBrowser.classList.add("shader-category-browser--exit");
      browserExitTimer = window.setTimeout(() => {
        browserExitTimer = 0;
        launchEditor();
      }, CATEGORY_BROWSER_EXIT_MS);
      return;
    }

    launchEditor();
  };

  const closeCategoryEditor = (animated = true, statusText?: string) => {
    clearCategoryTransitionTimers();
    closeOpenOptionMenus();
    hideOptionTooltip();

    const finishClose = () => {
      activeShaderCategory = null;
      draftShaderOptionValues.clear();
      categoryEditor?.setAttribute("hidden", "");
      categoryBrowser?.removeAttribute("hidden");
      resetCategoryAnimationClasses();
      clearActiveCategoryButton();
      if (categoryBrowser?.parentElement) {
        categoryBrowser.parentElement.scrollTop = 0;
      }
      if (animated) {
        void categoryBrowser?.offsetWidth;
        categoryBrowser?.classList.add("shader-category-browser--enter");
        categoryTransitionTimer = window.setTimeout(() => {
          categoryBrowser?.classList.remove("shader-category-browser--enter");
          categoryTransitionTimer = 0;
        }, CATEGORY_TRANSITION_MS);
      }
      if (statusText) {
        setStatus(statusText);
      }
    };

    if (!animated || !categoryEditor || categoryEditor.hasAttribute("hidden")) {
      finishClose();
      return;
    }

    resetCategoryAnimationClasses();
    categoryEditor.classList.add("shader-category-editor--exit");
    categoryTransitionTimer = window.setTimeout(() => {
      categoryTransitionTimer = 0;
      finishClose();
    }, CATEGORY_TRANSITION_MS);
  };

  const exitCategoryEditor = () => {
    if (!activeShaderCategory) {
      return;
    }

    closeCategoryEditor(true);
  };

  // ---- Code editor: file tree ----------------------------------------------

  let folderPathCache: Set<string> | null = null;

  const invalidateFolderPathCache = () => {
    folderPathCache = null;
  };

  const allFolderPaths = () => {
    if (folderPathCache) {
      return folderPathCache;
    }

    const paths = new Set<string>(state.folders);
    state.files.forEach((file) => {
      let dir = dirOf(file.path);
      while (dir) {
        paths.add(dir);
        dir = dirOf(dir);
      }
    });
    folderPathCache = paths;
    return paths;
  };

  const buildTree = (): FolderNode => {
    const root: FolderNode = { type: "folder", name: "", path: "", children: [] };
    const folders = new Map<string, TreeNode>([["", root]]);

    const ensureFolder = (path: string): TreeNode => {
      const existing = folders.get(path);
      if (existing) {
        return existing;
      }
      const parent = ensureFolder(dirOf(path));
      const node: TreeNode = { type: "folder", name: baseOf(path), path, children: [] };
      folders.set(path, node);
      if (parent.type === "folder") {
        parent.children.push(node);
      }
      return node;
    };

    [...allFolderPaths()].sort().forEach((path) => ensureFolder(path));

    state.files.forEach((file) => {
      const parent = ensureFolder(dirOf(file.path));
      if (parent.type === "folder") {
        parent.children.push({ type: "file", name: baseOf(file.path), path: file.path, file });
      }
    });

    const sortNode = (node: TreeNode) => {
      if (node.type !== "folder") {
        return;
      }
      node.children.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "folder" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortNode);
    };
    sortNode(root);

    return root;
  };

  const fileIconClass = (path: string) =>
    path.toLowerCase().endsWith(".properties") ? "code-tree-icon--props" : "code-tree-icon--file";

  let renamingPath: string | null = null;
  let draggingFilePath: string | null = null;

  const syncTreeSelection = () => {
    tree?.querySelectorAll<HTMLElement>("[data-tree-path]").forEach((row) => {
      row.classList.toggle("is-selected", row.dataset.treePath === state.selectedPath);
    });
  };

  const startRename = (node: TreeNode) => {
    renamingPath = node.path;
    renderTree();
    const input = tree?.querySelector<HTMLInputElement>(".code-tree-rename");
    input?.focus();
    input?.select();
  };

  const commitRename = (node: TreeNode, rawName: string) => {
    renamingPath = null;
    const name = rawName.trim();

    if (!name || name.includes("/") || name === node.name) {
      renderTree();
      return;
    }

    const newPath = joinPath(dirOf(node.path), name);

    if (node.type === "file") {
      const file = fileByPath(node.path);
      if (file) {
        deletePersistedFile(file.path);
        file.path = newPath;
        file.name = name;
        file.language = languageForPath(newPath);
        file.saved = false;
      }
    } else {
      const prefix = `${node.path}/`;
      const newPrefix = `${newPath}/`;
      state.folders = state.folders.map((folder) =>
        folder === node.path ? newPath : folder.startsWith(prefix) ? newPrefix + folder.slice(prefix.length) : folder,
      );
      state.files.forEach((file) => {
        if (file.path.startsWith(prefix)) {
          deletePersistedFile(file.path);
          file.path = newPrefix + file.path.slice(prefix.length);
          file.name = baseOf(file.path);
          file.saved = false;
        }
      });
      const nextExpanded = new Set<string>();
      state.expanded.forEach((path) => {
        if (path === node.path) {
          nextExpanded.add(newPath);
        } else if (path.startsWith(prefix)) {
          nextExpanded.add(newPrefix + path.slice(prefix.length));
        } else {
          nextExpanded.add(path);
        }
      });
      state.expanded = nextExpanded;
      state.expanded.add(newPath);
    }
    invalidateFolderPathCache();

    if (state.selectedPath === node.path) {
      state.selectedPath = newPath;
    }

    renderTree();
    refreshEditorBar();
    markDirty();
    setStatus(`Renamed to ${name}.`);
  };

  const deleteNode = (node: TreeNode) => {
    if (node.type === "file") {
      deletePersistedFile(node.path);
      state.files = state.files.filter((file) => file.path !== node.path);
      const active = fileById(state.activeFileId);
      if (active && active.path === node.path) {
        state.activeFileId = null;
      }
    } else {
      const prefix = `${node.path}/`;
      const removed = state.files.filter(
        (file) => file.path === node.path || file.path.startsWith(prefix),
      );
      removed.forEach((file) => deletePersistedFile(file.path));
      state.files = state.files.filter((file) => !removed.includes(file));
      state.folders = state.folders.filter(
        (folder) => folder !== node.path && !folder.startsWith(prefix),
      );
      const active = fileById(state.activeFileId);
      if (active && removed.includes(active)) {
        state.activeFileId = null;
      }
    }
    invalidateFolderPathCache();

    if (state.selectedPath === node.path) {
      state.selectedPath = null;
    }

    renderTree();
    updateCounts();
    refreshEditorBar();
    setStatus(`Deleted ${node.name}.`);
  };

  const uniqueName = (dir: string, base: string, extension: string) => {
    let name = `${base}${extension}`;
    let counter = 1;
    const taken = (candidate: string) => {
      const fullPath = joinPath(dir, candidate);
      return (
        state.files.some((file) => file.path === fullPath) ||
        allFolderPaths().has(fullPath)
      );
    };
    while (taken(name)) {
      counter += 1;
      name = `${base}-${counter}${extension}`;
    }
    return name;
  };

  const targetDir = () => {
    if (!state.selectedPath) {
      return "";
    }
    if (allFolderPaths().has(state.selectedPath)) {
      return state.selectedPath;
    }
    return dirOf(state.selectedPath);
  };

  const uniqueMovedFileName = (dir: string, currentPath: string) => {
    const originalName = baseOf(currentPath);
    const extensionIndex = originalName.lastIndexOf(".");
    const base = extensionIndex > 0 ? originalName.slice(0, extensionIndex) : originalName;
    const extension = extensionIndex > 0 ? originalName.slice(extensionIndex) : "";
    let name = originalName;
    let counter = 1;

    const taken = (candidate: string) => {
      const fullPath = joinPath(dir, candidate);
      return (
        fullPath !== currentPath &&
        (state.files.some((file) => file.path === fullPath) || allFolderPaths().has(fullPath))
      );
    };

    while (taken(name)) {
      counter += 1;
      name = `${base}-${counter}${extension}`;
    }

    return name;
  };

  const dragFilePath = (event: DragEvent) =>
    draggingFilePath ||
    event.dataTransfer?.getData("application/x-anvil-shader-path") ||
    event.dataTransfer?.getData("text/plain") ||
    "";

  const canDropFileInto = (targetDir: string, path = draggingFilePath) => {
    if (targetDir && !allFolderPaths().has(targetDir)) {
      return false;
    }

    const file = path ? fileByPath(path) : null;
    return Boolean(file && dirOf(file.path) !== targetDir);
  };

  const clearDropTargets = () => {
    tree?.classList.remove("is-root-drop-target");
    tree
      ?.querySelectorAll<HTMLElement>(".code-tree-row.is-drop-target")
      .forEach((row) => row.classList.remove("is-drop-target"));
  };

  const clearDragState = () => {
    draggingFilePath = null;
    clearDropTargets();
    tree
      ?.querySelectorAll<HTMLElement>(".code-tree-row.is-dragging")
      .forEach((row) => row.classList.remove("is-dragging"));
  };

  const markFolderDropTarget = (row: HTMLElement) => {
    clearDropTargets();
    row.classList.add("is-drop-target");
  };

  const formatDropTarget = (path: string) => (path ? `shaders/${path}` : "shaders");

  const moveFileIntoFolder = (filePath: string, targetDir: string) => {
    const file = fileByPath(filePath);

    if (!file || !canDropFileInto(targetDir, filePath)) {
      return;
    }

    persistEditorContent();

    const previousPath = file.path;
    deletePersistedFile(previousPath);
    const nextName = uniqueMovedFileName(targetDir, previousPath);
    const nextPath = joinPath(targetDir, nextName);
    file.path = nextPath;
    file.name = nextName;
    file.language = languageForPath(nextPath);
    file.saved = false;
    invalidateFolderPathCache();

    if (targetDir) {
      state.expanded.add(targetDir);
    }
    if (state.selectedPath === previousPath || state.selectedPath === filePath) {
      state.selectedPath = nextPath;
    }

    updateCounts();
    renderTree();
    refreshEditorBar();
    markDirty();
    setStatus(`Moved ${file.name} to ${formatDropTarget(targetDir)}.`);
  };

  const createFile = () => {
    const dir = targetDir();
    const name = uniqueName(dir, "untitled", ".fsh");
    const path = joinPath(dir, name);
    fileSeq += 1;
    const file: ShaderFile = {
      id: `file-${fileSeq}`,
      name,
      path,
      language: languageForPath(path),
      description: "New shader file.",
      contents: "",
      saved: false,
    };
    state.files.push(file);
    invalidateFolderPathCache();
    if (dir) {
      state.expanded.add(dir);
    }
    state.selectedPath = path;
    updateCounts();
    renderTree();
    markDirty();
    const node = findNode(buildTree(), path);
    if (node) {
      startRename(node);
    }
  };

  const createFolder = () => {
    const dir = targetDir();
    const name = uniqueName(dir, "new-folder", "");
    const path = joinPath(dir, name);
    state.folders.push(path);
    invalidateFolderPathCache();
    if (dir) {
      state.expanded.add(dir);
    }
    state.expanded.add(path);
    state.selectedPath = path;
    renderTree();
    const node = findNode(buildTree(), path);
    if (node) {
      startRename(node);
    }
  };

  const findNode = (node: TreeNode, path: string): TreeNode | null => {
    if (node.path === path) {
      return node;
    }
    if (node.type === "folder") {
      for (const child of node.children) {
        const found = findNode(child, path);
        if (found) {
          return found;
        }
      }
    }
    return null;
  };

  const openFileInEditor = (file: ShaderFile) => {
    persistEditorContent();
    scheduleAutoSave(); // any buffered edits from a previous file still land
    state.activeFileId = file.id;
    state.selectedPath = file.path;
    editorOpenSnapshot = file.contents; // "Discard changes" restores this
    setCodeTab("editor");
    refreshEditorBar();
    syncTreeSelection();
  };

  const renderNode = (node: TreeNode, depth: number, container: HTMLElement) => {
    if (node.type === "folder" && node.path !== "") {
      const row = document.createElement("div");
      const collapsed = !state.expanded.has(node.path);
      row.className = "code-tree-row";
      if (state.selectedPath === node.path) {
        row.classList.add("is-selected");
      }
      if (collapsed) {
        row.classList.add("is-collapsed");
      }
      row.style.paddingLeft = `${8 + depth * 15}px`;
      row.dataset.treePath = node.path;

      const twisty = document.createElement("span");
      twisty.className = "code-tree-twisty";
      twisty.textContent = "▶";

      const icon = document.createElement("span");
      icon.className = "code-tree-icon code-tree-icon--folder";

      row.append(twisty, icon);
      appendNameOrRename(row, node);
      appendActions(row, node);

      row.addEventListener("dragenter", (event) => {
        if (!canDropFileInto(node.path)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        markFolderDropTarget(row);
      });
      row.addEventListener("dragover", (event) => {
        if (!canDropFileInto(node.path)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        markFolderDropTarget(row);
      });
      row.addEventListener("dragleave", (event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !row.contains(nextTarget)) {
          row.classList.remove("is-drop-target");
        }
      });
      row.addEventListener("drop", (event) => {
        const filePath = dragFilePath(event);
        if (!canDropFileInto(node.path, filePath)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        moveFileIntoFolder(filePath, node.path);
        clearDragState();
      });

      row.addEventListener("click", () => {
        state.selectedPath = node.path;
        if (state.expanded.has(node.path)) {
          state.expanded.delete(node.path);
        } else {
          state.expanded.add(node.path);
        }
        renderTree();
      });

      container.append(row);

      if (!collapsed) {
        node.children.forEach((child) => renderNode(child, depth + 1, container));
      }
      return;
    }

    if (node.type === "folder") {
      node.children.forEach((child) => renderNode(child, depth, container));
      return;
    }

    const row = document.createElement("div");
    row.className = "code-tree-row";
    row.draggable = true;
    if (state.selectedPath === node.path) {
      row.classList.add("is-selected");
    }
    if (!node.file.saved) {
      row.classList.add("is-dirty");
    }
    row.style.paddingLeft = `${8 + depth * 15 + 16}px`;
    row.dataset.treePath = node.path;

    const icon = document.createElement("span");
    icon.className = `code-tree-icon ${fileIconClass(node.path)}`;
    row.append(icon);
    appendNameOrRename(row, node);
    appendActions(row, node);

    row.addEventListener("click", () => {
      state.selectedPath = node.path;
      syncTreeSelection();
    });
    row.addEventListener("dblclick", () => openFileInEditor(node.file));
    row.addEventListener("dragstart", (event) => {
      if (renamingPath === node.path) {
        event.preventDefault();
        return;
      }

      draggingFilePath = node.path;
      row.classList.add("is-dragging");
      state.selectedPath = node.path;
      syncTreeSelection();
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-anvil-shader-path", node.path);
        event.dataTransfer.setData("text/plain", node.path);
      }
    });
    row.addEventListener("dragend", clearDragState);

    container.append(row);
  };

  const appendNameOrRename = (row: HTMLElement, node: TreeNode) => {
    if (renamingPath === node.path) {
      const input = document.createElement("input");
      input.className = "code-tree-rename";
      input.value = node.name;
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("dblclick", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitRename(node, input.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          renamingPath = null;
          renderTree();
        }
      });
      input.addEventListener("blur", () => {
        if (renamingPath === node.path) {
          commitRename(node, input.value);
        }
      });
      row.append(input);
      return;
    }

    const name = document.createElement("span");
    name.className = "code-tree-name";
    name.textContent = node.name;
    row.append(name);
  };

  const appendActions = (row: HTMLElement, node: TreeNode) => {
    const actions = document.createElement("span");
    actions.className = "code-tree-actions";

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "code-tree-action";
    rename.title = "Rename";
    rename.textContent = "✎";
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      startRename(node);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "code-tree-action code-tree-action--delete";
    remove.title = "Delete";
    remove.textContent = "🗑";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteNode(node);
    });

    actions.append(rename, remove);
    row.append(actions);
  };

  const renderTree = () => {
    if (!tree) {
      return;
    }

    tree.textContent = "";
    const root = buildTree();

    if (!root.children.length) {
      const empty = document.createElement("p");
      empty.className = "code-tree-empty";
      empty.textContent = "No files yet. Use “New file” to start.";
      tree.append(empty);
      return;
    }

    root.children.forEach((child) => renderNode(child, 0, tree));
  };

  // ---- Editor ---------------------------------------------------------------

  const persistEditorContent = () => {
    const file = fileById(state.activeFileId);
    if (file && code) {
      file.contents = code.value;
    }
  };

  // --- Syntax highlighting (GLSL + .properties) -------------------------------

  const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const GLSL_KEYWORDS = new Set([
    "void", "float", "int", "bool", "vec2", "vec3", "vec4", "ivec2", "ivec3", "ivec4",
    "bvec2", "bvec3", "bvec4", "mat2", "mat3", "mat4", "sampler2D", "samplerCube",
    "uniform", "varying", "attribute", "const", "if", "else", "for", "while", "return",
    "break", "continue", "discard", "in", "out", "inout", "struct", "true", "false",
    "precision", "highp", "mediump", "lowp",
  ]);

  const GLSL_BUILTINS = new Set([
    "texture2D", "texture", "mix", "clamp", "pow", "exp", "exp2", "log", "log2", "sqrt",
    "inversesqrt", "abs", "sign", "floor", "ceil", "fract", "mod", "min", "max", "step",
    "smoothstep", "length", "distance", "dot", "cross", "normalize", "reflect", "refract",
    "sin", "cos", "tan", "asin", "acos", "atan", "radians", "degrees", "ftransform",
    "gl_FragColor", "gl_FragData", "gl_Position", "gl_FragCoord", "gl_Vertex", "gl_Color",
    "gl_Normal", "gl_MultiTexCoord0", "gl_MultiTexCoord1", "gl_ModelViewMatrix",
    "gl_ProjectionMatrix", "gl_NormalMatrix", "gl_TextureMatrix",
  ]);

  // One combined pass over a comment-free code segment.
  const GLSL_TOKEN_PATTERN =
    /(#\s*\w+)|("[^"\n]*")|\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fF]?)\b|\b([A-Za-z_]\w*)\b/g;

  const highlightGlslSegment = (segment: string) =>
    escapeHtml(segment).replace(GLSL_TOKEN_PATTERN, (match, directive, str, num, word) => {
      if (directive) return `<span class="tok-pre">${match}</span>`;
      if (str) return `<span class="tok-str">${match}</span>`;
      if (num) return `<span class="tok-num">${match}</span>`;
      if (word) {
        if (GLSL_KEYWORDS.has(word)) return `<span class="tok-kw">${match}</span>`;
        if (GLSL_BUILTINS.has(word)) return `<span class="tok-fn">${match}</span>`;
        if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) return `<span class="tok-macro">${match}</span>`;
      }
      return match;
    });

  const highlightPropertiesLine = (line: string) => {
    const escaped = escapeHtml(line);
    if (/^\s*#/.test(line)) {
      return `<span class="tok-comment">${escaped}</span>`;
    }
    const equals = escaped.indexOf("=");
    if (equals > 0) {
      return `<span class="tok-key">${escaped.slice(0, equals)}</span>=<span class="tok-val">${escaped.slice(equals + 1)}</span>`;
    }
    return escaped;
  };

  // Highlights full GLSL source, tracking /* ... */ across lines.
  const highlightGlsl = (source: string) => {
    let inBlockComment = false;
    return source.split("\n").map((line) => {
      let html = "";
      let rest = line;
      while (rest.length) {
        if (inBlockComment) {
          const end = rest.indexOf("*/");
          if (end === -1) {
            html += `<span class="tok-comment">${escapeHtml(rest)}</span>`;
            rest = "";
          } else {
            html += `<span class="tok-comment">${escapeHtml(rest.slice(0, end + 2))}</span>`;
            rest = rest.slice(end + 2);
            inBlockComment = false;
          }
          continue;
        }
        const lineComment = rest.indexOf("//");
        const blockComment = rest.indexOf("/*");
        if (lineComment !== -1 && (blockComment === -1 || lineComment < blockComment)) {
          html += highlightGlslSegment(rest.slice(0, lineComment));
          html += `<span class="tok-comment">${escapeHtml(rest.slice(lineComment))}</span>`;
          rest = "";
        } else if (blockComment !== -1) {
          html += highlightGlslSegment(rest.slice(0, blockComment));
          rest = rest.slice(blockComment);
          inBlockComment = true;
        } else {
          html += highlightGlslSegment(rest);
          rest = "";
        }
      }
      return html;
    }).join("\n");
  };

  let renderedLineCount = -1;
  // File contents captured when the editor was opened, for "Discard changes".
  let editorOpenSnapshot = "";

  const renderEditorDecorations = () => {
    if (!code || !editorHighlightCode || !editorGutter) {
      return;
    }

    const file = fileById(state.activeFileId);
    const source = code.value;
    const isProperties = (file?.language ?? "GLSL") === "Properties";

    editorHighlightCode.innerHTML = isProperties
      ? source.split("\n").map(highlightPropertiesLine).join("\n") + "\n"
      : highlightGlsl(source) + "\n";

    const lineCount = source.split("\n").length;
    if (lineCount !== renderedLineCount) {
      renderedLineCount = lineCount;
      const numbers: string[] = [];
      for (let line = 1; line <= lineCount; line += 1) {
        numbers.push(`<div>${line}</div>`);
      }
      editorGutter.innerHTML = `<div class="code-editor-gutter-inner">${numbers.join("")}</div>`;
    }

    syncEditorScroll();
  };

  const syncEditorScroll = () => {
    if (!code) {
      return;
    }
    if (editorHighlight) {
      editorHighlight.style.transform = `translate(${-code.scrollLeft}px, ${-code.scrollTop}px)`;
    }
    const gutterInner = editorGutter?.firstElementChild as HTMLElement | null;
    if (gutterInner) {
      gutterInner.style.transform = `translateY(${-code.scrollTop}px)`;
    }
  };

  // Insert text at the caret, keeping the browser's undo stack intact.
  const insertAtCursor = (text: string) => {
    if (!code) {
      return;
    }
    code.focus();
    if (!document.execCommand("insertText", false, text)) {
      const start = code.selectionStart;
      code.setRangeText(text, start, code.selectionEnd, "end");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  // ---- Auto-save --------------------------------------------------------------

  const AUTO_SAVE_DELAY_MS = 900;
  let autoSaveTimer = 0;
  let activeSave: Promise<void> | null = null;

  const setSaveState = (saveState: "saved" | "pending" | "saving" | "error") => {
    if (autosaveStatus) {
      autosaveStatus.dataset.state = saveState;
      autosaveStatus.textContent =
        saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "error" ? "Save failed" : "Unsaved";
    }
  };

  const performSave = async () => {
    persistEditorContent();
    const pending = state.files.filter((file) => !file.saved);

    if (!pending.length) {
      setSaveState("saved");
      return;
    }

    setSaveState("saving");
    try {
      for (const file of pending) {
        await persistFile(file);
      }
      setSaveState("saved");
    } catch (error) {
      console.error("Auto-save failed.", error);
      setSaveState("error");
      window.clearTimeout(autoSaveTimer);
      autoSaveTimer = window.setTimeout(() => void flushAutoSave(), 4000);
    }

    renderTree();
    updateCounts();
  };

  // Save everything now. Safe to call concurrently — waits out any in-flight
  // save, then runs a fresh one so the latest edits always land on disk.
  const flushAutoSave = async (): Promise<void> => {
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = 0;
    while (activeSave) {
      await activeSave;
    }
    activeSave = performSave();
    try {
      await activeSave;
    } finally {
      activeSave = null;
    }
  };

  // Every change funnels through here: mark dirty, then save shortly after.
  const markDirty = () => {
    setSaveState("pending");
    scheduleAutoSave();
  };

  const scheduleAutoSave = () => {
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = window.setTimeout(() => void flushAutoSave(), AUTO_SAVE_DELAY_MS);
  };

  const refreshEditorBar = () => {
    const file = fileById(state.activeFileId);

    if (!file) {
      if (editorPath) {
        editorPath.textContent = "No file open";
      }
      if (editorEmpty) {
        editorEmpty.hidden = false;
      }
      if (editorStack) {
        editorStack.hidden = true;
      }
      if (editorLang) {
        editorLang.hidden = true;
      }
      return;
    }

    if (editorPath) {
      editorPath.textContent = `shaders/${file.path}`;
    }
    if (editorEmpty) {
      editorEmpty.hidden = true;
    }
    if (editorStack) {
      editorStack.hidden = false;
    }
    if (editorLang) {
      editorLang.hidden = false;
      editorLang.textContent = file.language;
    }
    if (code && code.value !== file.contents) {
      code.value = file.contents;
    }
    renderedLineCount = -1;
    renderEditorDecorations();
  };

  // ---- Mode + tab switching -------------------------------------------------

  const setMode = (mode: ShaderMode) => {
    if (state.mode === mode) {
      return;
    }
    persistEditorContent();
    scheduleAutoSave(); // buffered code edits land when leaving the editor
    state.mode = mode;

    document.querySelectorAll<HTMLButtonElement>("[data-shader-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.shaderMode === mode);
    });

    document.querySelectorAll<HTMLElement>("[data-shader-panel]").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.shaderPanel === mode);
    });

    if (modeKicker) {
      modeKicker.textContent = modeCopy[mode].kicker;
    }
    if (modeTitle) {
      modeTitle.textContent = modeCopy[mode].title;
    }

    if (mode === "code") {
      renderTree();
      refreshEditorBar();
    }
  };

  const setCodeTab = (tab: CodeTab) => {
    state.codeTab = tab;
    document.querySelectorAll<HTMLButtonElement>("[data-code-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.codeTab === tab);
    });
    document.querySelectorAll<HTMLElement>("[data-code-view]").forEach((view) => {
      view.classList.toggle("is-active", view.dataset.codeView === tab);
    });
    if (tab === "editor") {
      refreshEditorBar();
    }
  };

  const setShaderVersion = (version: string) => {
    state.project.minecraftVersion = version;
    applyVersionToBrowser();

    // Re-render an open category so its controls match the new version, and
    // refresh the generated options file.
    if (activeShaderCategory) {
      renderCategoryEditor(activeShaderCategory);
    }
    if (fileByPath(GENERATED_OPTIONS_PATH)) {
      regenerateFromVisual();
    }
    setStatus(`Targeting Iris on Minecraft ${version}.`);
  };

  // Custom dropdown for the version, matching the app's option selects instead
  // of an ugly native <select>.
  let syncVersionDropdownLabel: ((version: string) => void) | null = null;

  const buildVersionDropdown = () => {
    const host = document.getElementById("shader-version-dropdown");
    if (!host) {
      return;
    }
    host.textContent = "";

    const select = document.createElement("div");
    select.className = "custom-select shader-option-select shader-version-select-control";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "custom-select-trigger shader-option-select-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    const caret = document.createElement("span");
    caret.className = "custom-select-caret";
    caret.setAttribute("aria-hidden", "true");
    trigger.append(label, caret);

    const menu = document.createElement("div");
    menu.className = "custom-select-menu shader-option-select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-hidden", "true");

    const setOpen = (open: boolean) => {
      if (open) {
        closeOpenOptionMenus(select);
      }
      select.classList.toggle("is-open", open);
      trigger.setAttribute("aria-expanded", String(open));
      menu.setAttribute("aria-hidden", String(!open));
    };

    const setLabel = (version: string) => {
      label.textContent = version;
      menu.querySelectorAll<HTMLButtonElement>(".custom-select-option").forEach((button) => {
        const isSelected = button.dataset.value === version;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-selected", String(isSelected));
      });
    };
    syncVersionDropdownLabel = setLabel;

    SHADER_VERSIONS.forEach((version) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "custom-select-option";
      item.setAttribute("role", "option");
      item.textContent = version;
      item.dataset.value = version;
      item.addEventListener("click", () => {
        setLabel(version);
        setOpen(false);
        setShaderVersion(version);
      });
      menu.append(item);
    });

    setLabel(selectedVersion());

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(trigger.getAttribute("aria-expanded") !== "true");
    });
    select.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.focus();
      }
    });

    select.append(trigger, menu);
    host.append(select);
  };

  // ---- Save / export --------------------------------------------------------

  const persistFile = async (file: ShaderFile) => {
    const projectId = state.project.id ?? projectFallbackId(state.project.name);
    const wasActive = state.activeFileId === file.id;
    try {
      const saved = await invoke<ShaderFile>("save_shader_file", {
        projectId,
        fileId: file.id,
        filePath: file.path,
        contents: file.contents,
      });
      Object.assign(file, normalizeFile(saved));
      if (wasActive) {
        state.activeFileId = file.id; // the backend may normalize the id
      }
    } catch (error) {
      if (isTauriRuntime()) {
        throw error;
      }
      writePreviewFile(projectId, file);
      file.saved = true;
    }
  };

  // Remove a file from disk after a rename/move/delete (best effort).
  const deletePersistedFile = (path: string) => {
    if (!isTauriRuntime()) {
      return;
    }
    const projectId = state.project.id ?? projectFallbackId(state.project.name);
    void invoke("delete_shader_file", { projectId, filePath: path }).catch((error) => {
      console.warn("Failed to delete shader file on disk.", error);
    });
  };

  const exportShaderPack = async () => {
    await flushAutoSave();

    try {
      const result = await invoke<ShaderExportResult>("export_shader_pack", {
        projectId: state.project.id ?? projectFallbackId(state.project.name),
        name: state.project.name,
        author: state.project.author ?? "Me!",
        description: stripHtml(state.project.description),
        iconBase64: state.project.iconDataUrl ?? "",
      });
      setStatus(`Exported shader pack to ${formatExportResult(result)}.`);
    } catch (error) {
      if (isTauriRuntime()) {
        console.error("Failed to export shader pack.", error);
        setStatus(error instanceof Error ? error.message : String(error));
        return;
      }
      setStatus("Shader export is available in the desktop app.");
    }
  };

  // ---- AI assistant (hardcoded) --------------------------------------------

  type AiPreset = {
    match: string[];
    reply: string;
    settings: Omit<Partial<VisualSettings>, "effects"> & {
      effects?: Partial<VisualSettings["effects"]>;
    };
  };

  const aiPresets: AiPreset[] = [
    {
      match: ["sunset", "warm", "cinematic", "golden", "sunrise"],
      reply: "Applied warm light, softer bloom, and a golden sky grade.",
      settings: {
        exposure: 1.18,
        contrast: 1.12,
        saturation: 1.25,
        fog: 0.4,
        bloom: 0.7,
        lightColor: "#ffcf9e",
        skyColor: "#ffb27a",
        effects: { bloom: true, vignette: true },
      },
    },
    {
      match: ["nether", "dark", "moody", "fog", "foggy", "horror", "gloomy"],
      reply: "Applied lower exposure, heavier fog, and smoky orange light.",
      settings: {
        exposure: 0.92,
        contrast: 1.08,
        saturation: 0.85,
        fog: 0.72,
        bloom: 0.5,
        lightColor: "#ff8a5c",
        skyColor: "#5e1d13",
        waterColor: "#3a1f1a",
        effects: { vignette: true },
      },
    },
    {
      match: ["vibrant", "crisp", "survival", "colorful", "sharp", "clean", "bright"],
      reply: "Applied crisp contrast, higher saturation, and sharpened texture detail.",
      settings: {
        exposure: 1.06,
        contrast: 1.22,
        saturation: 1.45,
        fog: 0.25,
        bloom: 0.35,
        lightColor: "#ffffff",
        skyColor: "#8fc7ff",
        effects: { sharpen: true, bloom: true },
      },
    },
  ];

  const defaultPreset: AiPreset = {
    match: [],
    reply: "Applied a balanced grade with soft bloom and a cool sky tint.",
    settings: {
      exposure: 1.08,
      contrast: 1.1,
      saturation: 1.15,
      bloom: 0.5,
      lightColor: "#ffe9c4",
      skyColor: "#8fc7ff",
      effects: { bloom: true },
    },
  };

  const pickPreset = (prompt: string) => {
    const lower = prompt.toLowerCase();
    return aiPresets.find((preset) => preset.match.some((word) => lower.includes(word))) ?? defaultPreset;
  };

  const applyPreset = (preset: AiPreset) => {
    const { effects, ...rest } = preset.settings;
    Object.assign(state.settings, rest);
    if (effects) {
      Object.assign(state.settings.effects, effects);
    }
    syncVisualControls();
    regenerateFromVisual();
  };

  const scrollThread = () => {
    if (aiThread) {
      aiThread.scrollTop = aiThread.scrollHeight;
    }
  };

  const resizeAiInput = () => {
    if (!aiInput) {
      return;
    }

    aiInput.style.height = "auto";
    aiInput.style.height = `${Math.min(aiInput.scrollHeight, 96)}px`;
  };

  const syncAiSend = () => {
    if (aiSend) {
      aiSend.disabled = !aiInput?.value.trim() && aiPendingImages.length === 0;
    }
  };

  const renderAiPendingImages = () => {
    if (!aiPendingAttachments) {
      return;
    }

    aiPendingAttachments.textContent = "";
    aiPendingAttachments.hidden = aiPendingImages.length === 0;

    aiPendingImages.forEach((pending) => {
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
        aiPendingImages = aiPendingImages.filter((entry) => entry.id !== pending.id);
        renderAiPendingImages();
        syncAiSend();
        updateAiContext();
      });

      item.append(image, remove);
      aiPendingAttachments.append(item);
    });
  };

  const resetAiConversation = () => {
    if (aiThread) {
      aiThread.textContent = "";
    }
    if (aiInput) {
      aiInput.value = "";
      resizeAiInput();
    }
    if (aiSend) {
      aiSend.disabled = true;
    }
    aiPendingImages = [];
    aiHistory = [];
    aiLastTotalTokens = null;
    renderAiPendingImages();
    updateAiContext();
  };

  const setAiCollapsed = (collapsed: boolean) => {
    if (!shaderWorkbench) {
      return;
    }

    window.clearTimeout(aiPanelTimer);
    if (aiPanelFrame) {
      window.cancelAnimationFrame(aiPanelFrame);
      aiPanelFrame = 0;
    }

    shaderWorkbench.classList.remove("is-ai-collapsing", "is-ai-expanding");
    aiToggle?.setAttribute("aria-expanded", String(!collapsed));
    aiToggle?.setAttribute("aria-label", collapsed ? "Expand AI" : "Collapse AI");

    if (collapsed) {
      if (shaderWorkbench.classList.contains("is-ai-collapsed")) {
        return;
      }

      shaderWorkbench.classList.add("is-ai-collapsing");
      aiPanelTimer = window.setTimeout(() => {
        shaderWorkbench.classList.add("is-ai-collapsed");
        shaderWorkbench.classList.remove("is-ai-collapsing");
      }, AI_PANEL_TRANSITION_MS);
      return;
    }

    if (!shaderWorkbench.classList.contains("is-ai-collapsed")) {
      return;
    }

    shaderWorkbench.classList.add("is-ai-expanding", "is-ai-collapsing");
    shaderWorkbench.classList.remove("is-ai-collapsed");
    aiPanelFrame = window.requestAnimationFrame(() => {
      aiPanelFrame = 0;
      shaderWorkbench.classList.remove("is-ai-collapsing");
      aiPanelTimer = window.setTimeout(() => {
        shaderWorkbench.classList.remove("is-ai-expanding");
      }, AI_PANEL_TRANSITION_MS);
    });
  };

  const isAiCollapsedOrCollapsing = () =>
    Boolean(
      shaderWorkbench?.classList.contains("is-ai-collapsed") ||
        (shaderWorkbench?.classList.contains("is-ai-collapsing") &&
          !shaderWorkbench?.classList.contains("is-ai-expanding")),
    );

  const appendUserMessage = (text: string, images: AiPendingImage[] = []) => {
    if (!aiThread) {
      return;
    }
    const message = document.createElement("div");
    message.className = "ai-message ai-message--user";
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
    aiThread.append(message);
    scrollThread();
    updateAiContext();
  };

  const imageFileDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
      reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read image.")));
      reader.readAsDataURL(file);
    });

  const addPendingImages = async (files: FileList | File[] | null) => {
    const imageFiles = [...(files ?? [])].filter((file) => file.type.startsWith("image/"));

    if (!imageFiles.length) {
      return;
    }

    const previews = await Promise.all(
      imageFiles.slice(0, Math.max(0, 5 - aiPendingImages.length)).map(async (file) => ({
        id: `shader-ai-image-${++aiPendingImageSeq}`,
        name: file.name,
        size: file.size,
        url: await imageFileDataUrl(file),
      })),
    );

    aiPendingImages = [...aiPendingImages, ...previews].slice(0, 5);
    renderAiPendingImages();
    syncAiSend();
    updateAiContext();
  };

  const imageFilesFromPaste = (data: DataTransfer | null) => {
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

  const appendTyping = () => {
    if (!aiThread) {
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
    aiThread.append(message);
    scrollThread();
    updateAiContext();
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
        scrollThread();
      },
    };
  };

  const appendAssistantReply = (reply: string, node: HTMLElement | null, thinking = "") => {
    if (!aiThread) {
      return;
    }
    const message = node ?? document.createElement("div");
    message.className = "ai-message ai-message--assistant";
    message.textContent = "";

    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    if (thinking) {
      // Reasoning models' scratchpad folds away, same as the Resource Pack panel.
      const details = document.createElement("details");
      details.className = "ai-thinking";
      const detailsSummary = document.createElement("summary");
      detailsSummary.textContent = "Thinking";
      const body = document.createElement("div");
      body.className = "ai-thinking-body";
      body.textContent = thinking;
      details.append(detailsSummary, body);
      bubble.append(details);
    }
    reply
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = part;
        bubble.append(paragraph);
      });

    message.append(bubble);
    if (!node) {
      aiThread.append(message);
    }
    scrollThread();
    updateAiContext();
  };

  // ---- AI assistant: real provider-backed option editing ----------------------

  type ShaderAiEdit = { id?: unknown; value?: unknown };
  type ShaderAiBackendResponse = { text: string; promptTokens?: number | null; totalTokens?: number | null };
  type ShaderAiConfig = { provider: string; baseUrl: string | null; apiKey: string | null; model: string };

  // Shared with the Resource Pack workspace's provider setup.
  const AI_CONFIG_STORAGE_KEY = "anvil.resourceAi.config";

  let aiHistory: string[] = [];

  const readAiConfig = (): ShaderAiConfig | null => {
    try {
      const raw = window.localStorage.getItem(AI_CONFIG_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Partial<ShaderAiConfig>;
      const provider = String(parsed.provider ?? "").trim().toLowerCase();
      const model = String(parsed.model ?? "").trim();
      if (!provider || !model) {
        return null;
      }
      return {
        provider,
        baseUrl: String(parsed.baseUrl ?? "").trim() || null,
        apiKey: String(parsed.apiKey ?? "").trim() || null,
        model,
      };
    } catch {
      return null;
    }
  };

  const controlsById = new Map<string, ShaderOptionControl>();
  shaderOptionGroups.forEach((group) => {
    group.sections.forEach((section) => {
      section.controls.forEach((control) => controlsById.set(control.id, control));
    });
  });

  // Compact, grouped option catalog with current values — the model's
  // read/write surface.
  const buildOptionsDoc = () => {
    const lines: string[] = [];
    shaderOptionGroups.forEach((group) => {
      lines.push(`## ${group.title}`);
      group.sections.forEach((section) => {
        section.controls.forEach((control) => {
          const current = optionResolver(control);
          let bounds = "";
          if (control.kind === "range") {
            bounds = `${control.min ?? 0}..${control.max ?? 1} step ${control.step ?? 0.01}`;
          } else if (control.kind === "select") {
            bounds = `choices: ${(control.options ?? []).join("; ")}`;
          } else if (control.kind === "toggle") {
            bounds = "true/false";
          } else {
            bounds = "#rrggbb hex";
          }
          lines.push(`${control.id} | ${control.kind} | ${String(current)} | ${bounds}`);
        });
      });
    });
    return lines.join("\n");
  };

  // Validate and coerce a model-proposed value into the control's domain.
  const coerceAiValue = (control: ShaderOptionControl, raw: unknown): ShaderOptionValue | null => {
    if (control.kind === "toggle") {
      if (typeof raw === "boolean") return raw;
      const text = String(raw).trim().toLowerCase();
      if (text === "true" || text === "on" || text === "1") return true;
      if (text === "false" || text === "off" || text === "0") return false;
      return null;
    }

    if (control.kind === "range") {
      const value = Number(raw);
      if (!Number.isFinite(value)) return null;
      const min = control.min ?? 0;
      const max = control.max ?? 1;
      const step = control.step ?? 0.01;
      const clamped = Math.min(max, Math.max(min, value));
      const stepped = Math.round((clamped - min) / step) * step + min;
      const decimals = (String(step).split(".")[1] ?? "").length;
      return Number(stepped.toFixed(decimals));
    }

    if (control.kind === "select") {
      const options = control.options ?? [];
      if (typeof raw === "number" && options[raw] !== undefined) return options[raw];
      const text = String(raw).trim().toLowerCase();
      const match = options.find((option) => option.toLowerCase() === text);
      return match ?? null;
    }

    const text = String(raw).trim();
    const withHash = text.startsWith("#") ? text : `#${text}`;
    return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : null;
  };

  const categoryHasControl = (category: ShaderOptionCategory, controlId: string) =>
    category.sections.some((section) => section.controls.some((control) => control.id === controlId));

  const applyAiEdits = (edits: ShaderAiEdit[]): string[] => {
    const applied: string[] = [];

    for (const edit of edits) {
      const control = controlsById.get(String(edit.id ?? ""));
      if (!control) {
        continue;
      }
      const value = coerceAiValue(control, edit.value);
      if (value === null || value === optionResolver(control)) {
        continue;
      }
      savedShaderOptionValues.set(control.id, value);
      if (activeShaderCategory && categoryHasControl(activeShaderCategory, control.id)) {
        draftShaderOptionValues.set(control.id, value);
      }
      applied.push(`${control.label}: ${String(value)}`);
    }

    if (applied.length) {
      if (activeShaderCategory) {
        renderCategoryEditor(activeShaderCategory);
      }
      regenerateFromVisual();
    }

    return applied;
  };

  const runShaderAi = async (config: ShaderAiConfig, prompt: string, images: AiPendingImage[], typing: HTMLElement | null) => {
    setStatus("Assistant is reading your shader options…");
    const streamId = newAiStreamId();
    const live = attachLiveAiStream(typing);
    const stopStream = onAiStream(streamId, live.push);
    try {
      const optionsDoc = buildOptionsDoc();
      const response = await invoke<ShaderAiBackendResponse>("run_shader_ai", {
        config,
        request: {
          prompt,
          projectName: state.project.name,
          minecraftVersion: selectedVersion(),
          optionsDoc,
          quickSettings: JSON.stringify(state.settings),
          history: aiHistory.slice(-8).join("\n") || null,
          images: images.map((image) => ({
            name: image.name,
            mimeType: image.url.slice(5, image.url.indexOf(";")) || "image/png",
            dataUrl: image.url,
          })),
          streamId,
        },
      });

      // Conversation-cumulative: exact usage when the provider reports it, a
      // ~4 chars/token estimate of this round's traffic when it doesn't.
      aiLastTotalTokens =
        (aiLastTotalTokens ?? 0) +
        (typeof response.totalTokens === "number"
          ? response.totalTokens
          : Math.ceil((prompt.length + optionsDoc.length + response.text.length) / 4));

      const { result, reply, thinking } = parseAiReply<{ reply?: string; edits?: ShaderAiEdit[] }>(
        response.text,
        ["reply", "edits"],
      );
      const applied = applyAiEdits(Array.isArray(result?.edits) ? result.edits : []);

      const summary = applied.length ? `${reply}\n\nApplied: ${applied.join(" · ")}` : reply;
      appendAssistantReply(summary, typing, thinking);
      aiHistory.push(`USER: ${prompt}`, `ASSISTANT: ${reply}`);
      aiHistory = aiHistory.slice(-16);
      setStatus(
        applied.length
          ? `Assistant changed ${applied.length} option${applied.length === 1 ? "" : "s"} — written to ${GENERATED_OPTIONS_PATH}.`
          : "Assistant replied.",
      );
    } catch (error) {
      console.error("Shader AI request failed.", error);
      appendAssistantReply(error instanceof Error ? error.message : String(error), typing);
      setStatus("Assistant request failed.");
    } finally {
      stopStream();
    }
  };

  const submitAiPrompt = (prompt: string) => {
    const text = prompt.trim();
    if (!text && !aiPendingImages.length) {
      return;
    }
    const sentImages = aiPendingImages;
    aiPendingImages = [];
    renderAiPendingImages();
    appendUserMessage(text, sentImages);
    if (aiInput) {
      aiInput.value = "";
      resizeAiInput();
    }
    syncAiSend();
    const typing = appendTyping();

    if (isTauriRuntime()) {
      const config = readAiConfig();
      if (!config) {
        // Same flow as the Resource Pack panel: ask for a provider first.
        appendAssistantReply("Set the AI up first — pick a provider in the settings that just opened.", typing);
        document.dispatchEvent(new CustomEvent("anvil:open-ai-setup"));
        setStatus("Set the AI up.");
        return;
      }
      void runShaderAi(config, text, sentImages, typing);
      return;
    }

    // Browser preview: fall back to the built-in mood presets.
    const preset = pickPreset(text);
    setStatus("Assistant is writing shader code…");
    window.setTimeout(() => {
      applyPreset(preset);
      appendAssistantReply(preset.reply, typing);
      setStatus(`Assistant updated ${GENERATED_OPTIONS_PATH}.`);
    }, 750);
  };

  // ---- Event wiring ---------------------------------------------------------

  bindVisualControls();

  document.querySelectorAll<HTMLButtonElement>("[data-shader-category]").forEach((button) => {
    button.addEventListener("click", () => {
      document
        .querySelectorAll<HTMLButtonElement>("[data-shader-category].is-active")
        .forEach((activeButton) => activeButton.classList.remove("is-active"));
      button.classList.add("is-active");

      const category = shaderOptionGroupById.get(button.dataset.shaderCategory ?? "");
      if (category) {
        openCategoryEditor(category);
      } else {
        const label = button.querySelector("strong")?.textContent?.trim() ?? "Shader";
        setStatus(`${label} category selected.`);
      }
    });
  });

  document.getElementById("shader-category-back")?.addEventListener("click", exitCategoryEditor);

  document.addEventListener("mousedown", (event) => {
    if (!(event.target as Element | null)?.closest(".shader-option-select")) {
      closeOpenOptionMenus();
    }
  });
  window.addEventListener("resize", hideOptionTooltip);
  document.addEventListener("scroll", hideOptionTooltip, true);

  document.querySelectorAll<HTMLButtonElement>("[data-shader-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode((button.dataset.shaderMode ?? "visual") as ShaderMode));
  });

  buildVersionDropdown();

  document.querySelectorAll<HTMLButtonElement>("[data-code-tab]").forEach((button) => {
    button.addEventListener("click", () => setCodeTab((button.dataset.codeTab ?? "explorer") as CodeTab));
  });

  // The editor session ends through these two: both return to the Explorer,
  // one keeps the edits, the other restores the file as it was when opened.
  document.getElementById("code-editor-savechanges")?.addEventListener("click", () => {
    persistEditorContent();
    void flushAutoSave();
    setCodeTab("explorer");
    const file = fileById(state.activeFileId);
    setStatus(file ? `Saved ${file.name}.` : "Saved.");
  });

  document.getElementById("code-editor-discard")?.addEventListener("click", () => {
    const file = fileById(state.activeFileId);
    if (file && code && file.contents !== editorOpenSnapshot) {
      file.contents = editorOpenSnapshot;
      file.saved = false;
      code.value = editorOpenSnapshot;
      // Discarding a generated file hands ownership back to the visual builder.
      manualGeneratedPaths.delete(file.path);
      void flushAutoSave();
      setStatus(`Discarded changes to ${file.name}.`);
    }
    setCodeTab("explorer");
  });
  document.getElementById("code-new-file")?.addEventListener("click", createFile);
  document.getElementById("code-new-folder")?.addEventListener("click", createFolder);
  tree?.addEventListener("dragover", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".code-tree-row") || !canDropFileInto("")) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    clearDropTargets();
    tree.classList.add("is-root-drop-target");
  });
  tree?.addEventListener("dragleave", (event) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !tree.contains(nextTarget)) {
      clearDropTargets();
    }
  });
  tree?.addEventListener("drop", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".code-tree-row")) {
      return;
    }

    const filePath = dragFilePath(event);
    if (!canDropFileInto("", filePath)) {
      return;
    }

    event.preventDefault();
    moveFileIntoFolder(filePath, "");
    clearDragState();
  });

  code?.addEventListener("input", () => {
    const file = fileById(state.activeFileId);
    if (!file) {
      return;
    }
    file.contents = code.value;
    file.saved = false;
    renderEditorDecorations();
    updateAiContext();
    // No auto-save while typing here — the editor session ends with the
    // explicit "Save changes" or "Discard changes" buttons.
    setSaveState("pending");

    // Hand-editing a generated file hands ownership to the code: the visual
    // builder will no longer overwrite it.
    if (GENERATED_PATHS.has(file.path) && !manualGeneratedPaths.has(file.path)) {
      manualGeneratedPaths.add(file.path);
      setStatus(`${file.path} is now hand-edited — visual changes won't overwrite it.`);
    }
  });

  code?.addEventListener("scroll", syncEditorScroll);

  code?.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      insertAtCursor("    ");
      return;
    }
    if (event.key === "Enter") {
      // Auto-indent: carry the current line's leading whitespace over.
      const upToCursor = code.value.slice(0, code.selectionStart);
      const currentLine = upToCursor.slice(upToCursor.lastIndexOf("\n") + 1);
      const indent = currentLine.match(/^[ \t]*/)?.[0] ?? "";
      if (indent) {
        event.preventDefault();
        insertAtCursor(`\n${indent}`);
      }
    }
  });

  // Ctrl+S anywhere in the shader workspace saves immediately.
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && shaderScreen && !shaderScreen.hasAttribute("hidden")) {
      event.preventDefault();
      void flushAutoSave();
    }
  });
  document.getElementById("shader-export-pack")?.addEventListener("click", () => {
    void exportShaderPack();
  });
  document.getElementById("shader-return-main-menu")?.addEventListener("click", () => {
    showScreen("home-screen");
  });

  aiPlus?.addEventListener("click", () => {
    aiImageInput?.click();
  });

  aiImageInput?.addEventListener("change", () => {
    void addPendingImages(aiImageInput.files);
    aiImageInput.value = "";
  });

  aiNewConversation?.addEventListener("click", resetAiConversation);

  // The provider setup modal lives at app root and is wired by the Resource
  // Pack workspace — both AI panels share one provider configuration.
  document.getElementById("shader-ai-settings")?.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("anvil:open-ai-setup"));
  });
  aiToggle?.addEventListener("click", () => {
    setAiCollapsed(!isAiCollapsedOrCollapsing());
  });

  document.getElementById("ai-composer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAiPrompt(aiInput?.value ?? "");
  });

  aiInput?.addEventListener("input", () => {
    resizeAiInput();
    syncAiSend();
  });

  aiInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitAiPrompt(aiInput.value);
    } else if (event.key === "Enter" && event.shiftKey) {
      window.setTimeout(resizeAiInput);
    }
  });

  aiInput?.addEventListener("paste", (event) => {
    const imageFiles = imageFilesFromPaste(event.clipboardData);
    if (!imageFiles.length) {
      return;
    }
    event.preventDefault();
    void addPendingImages(imageFiles);
  });

  syncAiSend();

  // ---- Loading --------------------------------------------------------------

  const loadFiles = async () => {
    const projectId = state.project.id ?? projectFallbackId(state.project.name);

    try {
      state.files = (await invoke<ShaderFile[]>("list_shader_files", { projectId })).map(normalizeFile);
    } catch (error) {
      if (isTauriRuntime()) {
        throw error;
      }
      console.warn("Shader files are using the browser preview store.", error);
      state.files = readPreviewFiles(projectId);
    }

    state.folders = [];
    state.expanded = new Set<string>();
    invalidateFolderPathCache();
    state.selectedPath = null;
    state.activeFileId = null;
    updateCounts();
    renderTree();
    refreshEditorBar();
    setSaveState("saved");
  };

  return {
    open(project: ShaderProject = { name: "Untitled Shader" }) {
      const safeName = project.name.trim() || "Untitled Shader";
      const fallbackId = projectFallbackId(safeName);
      state.project = {
        id: project.id || fallbackId,
        name: safeName,
        minecraftVersion: project.minecraftVersion || "1.21.6",
        packVersion: project.packVersion || "1.0",
        author: project.author?.trim() || "Me!",
        description: project.description ?? "",
        iconDataUrl: project.iconDataUrl,
      };
      state.settings = defaultSettings();
      state.codeTab = "explorer";
      state.mode = "visual";
      savedShaderOptionValues.clear();
      manualGeneratedPaths.clear();

      // Normalize "1.21.6" → a selectable "1.21" so the dropdown and the option
      // version checks line up.
      const normalizedVersion =
        SHADER_VERSIONS.find((version) => (state.project.minecraftVersion ?? "").startsWith(version)) ??
        DEFAULT_SHADER_VERSION;
      state.project.minecraftVersion = normalizedVersion;
      syncVersionDropdownLabel?.(normalizedVersion);
      applyVersionToBrowser();

      if (projectName) {
        projectName.textContent = safeName;
      }

      if (projectIcon) {
        if (project.iconDataUrl) {
          projectIcon.textContent = "";
          projectIcon.style.backgroundImage = `url("${project.iconDataUrl}")`;
        } else {
          projectIcon.textContent = "S";
          projectIcon.style.backgroundImage = "";
        }
      }

      // Reset the mode UI to the visual builder.
      document.querySelectorAll<HTMLButtonElement>("[data-shader-mode]").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.shaderMode === "visual");
      });
      document.querySelectorAll<HTMLElement>("[data-shader-panel]").forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.shaderPanel === "visual");
      });
      if (modeKicker) {
        modeKicker.textContent = modeCopy.visual.kicker;
      }
      if (modeTitle) {
        modeTitle.textContent = modeCopy.visual.title;
      }
      setCodeTab("explorer");
      syncVisualControls();
      closeCategoryEditor(false);

      showScreen("shader-workspace");
      setStatus("Loading shader starter files...");
      void loadFiles()
        .then(() => setStatus("Shader pack ready."))
        .catch((error) => {
          console.error("Failed to load shader files.", error);
          setStatus("Could not load shader files.");
        });
    },
  };
}
