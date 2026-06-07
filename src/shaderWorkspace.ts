import { invoke } from "@tauri-apps/api/core";

type ShaderMode = "visual" | "code" | "ai";
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

type VisualSettings = {
  exposure: number;
  contrast: number;
  saturation: number;
  fog: number;
  bloom: number;
  lightColor: string;
  skyColor: string;
  waterColor: string;
  effects: {
    bloom: boolean;
    foliage: boolean;
    water: boolean;
    vignette: boolean;
    sharpen: boolean;
  };
};

type FolderNode = { type: "folder"; name: string; path: string; children: TreeNode[] };
type FileNode = { type: "file"; name: string; path: string; file: ShaderFile };
type TreeNode = FolderNode | FileNode;

const SHADER_FILES_STORAGE_KEY = "anvil.shaderFiles.preview";

const GENERATED_FINAL_PATH = "final.fsh";
const GENERATED_PROPERTIES_PATH = "shaders.properties";

const defaultSettings = (): VisualSettings => ({
  exposure: 1,
  contrast: 1,
  saturation: 1,
  fog: 0.35,
  bloom: 0.4,
  lightColor: "#ffe9c4",
  skyColor: "#8fc7ff",
  waterColor: "#2f6f8f",
  effects: {
    bloom: true,
    foliage: true,
    water: true,
    vignette: false,
    sharpen: false,
  },
});

const starterFiles: ShaderFile[] = [
  {
    id: "final_vsh",
    name: "Final vertex",
    path: "final.vsh",
    language: "GLSL",
    description: "Passes screen-space coordinates into the final fragment pass.",
    saved: false,
    contents: `#version 120

varying vec2 texcoord;

void main() {
    gl_Position = ftransform();
    texcoord = gl_MultiTexCoord0.xy;
}
`,
  },
  {
    id: "final_fsh",
    name: "Final fragment",
    path: "final.fsh",
    language: "GLSL",
    description: "Applies the final color grade. This starter keeps the source image intact.",
    saved: false,
    contents: `#version 120

uniform sampler2D colortex0;
varying vec2 texcoord;

void main() {
    vec4 color = texture2D(colortex0, texcoord);
    gl_FragColor = color;
}
`,
  },
  {
    id: "gbuffers_terrain_vsh",
    name: "Terrain vertex",
    path: "gbuffers_terrain.vsh",
    language: "GLSL",
    description: "Starter terrain vertex pass for block geometry.",
    saved: false,
    contents: `#version 120

varying vec2 texcoord;
varying vec4 vertexColor;

void main() {
    gl_Position = ftransform();
    texcoord = gl_MultiTexCoord0.xy;
    vertexColor = gl_Color;
}
`,
  },
  {
    id: "gbuffers_terrain_fsh",
    name: "Terrain fragment",
    path: "gbuffers_terrain.fsh",
    language: "GLSL",
    description: "Starter terrain fragment pass with a small light lift.",
    saved: false,
    contents: `#version 120

uniform sampler2D texture;
varying vec2 texcoord;
varying vec4 vertexColor;

void main() {
    vec4 albedo = texture2D(texture, texcoord) * vertexColor;
    albedo.rgb = pow(albedo.rgb, vec3(0.92));
    gl_FragColor = albedo;
}
`,
  },
  {
    id: "settings",
    name: "Shader settings",
    path: "shaders.properties",
    language: "Properties",
    description: "Basic shader-pack metadata and option placeholders.",
    saved: false,
    contents: `sliders=ANVIL_EXPOSURE ANVIL_FOG
screen=ANVIL_EXPOSURE ANVIL_FOG

ANVIL_EXPOSURE=1.0
ANVIL_FOG=0.5
`,
  },
];

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

function hexToVec3(hex: string) {
  const value = hex.replace("#", "");
  const channel = (start: number) => (parseInt(value.slice(start, start + 2), 16) || 0) / 255;
  return `${channel(0).toFixed(3)}, ${channel(2).toFixed(3)}, ${channel(4).toFixed(3)}`;
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
  const homeScreen = document.getElementById("home-screen");
  const textureWorkspace = document.getElementById("project-workspace");
  const shaderWorkspace = document.getElementById("shader-workspace");
  const projectIcon = document.getElementById("shader-project-icon");
  const projectName = document.getElementById("shader-project-name");
  const fileCount = document.getElementById("shader-file-count");
  const savedCount = document.getElementById("shader-saved-count");
  const status = document.getElementById("shader-status");
  const modeKicker = document.getElementById("shader-mode-kicker");
  const modeTitle = document.getElementById("shader-mode-title");

  const tree = document.getElementById("code-tree");
  const editorPath = document.getElementById("code-editor-path");
  const editorDirty = document.getElementById("code-editor-dirty");
  const editorEmpty = document.getElementById("code-editor-empty");
  const code = document.getElementById("shader-code") as HTMLTextAreaElement | null;

  const aiThread = document.getElementById("ai-thread");
  const aiInput = document.getElementById("ai-input") as HTMLTextAreaElement | null;
  const aiSend = document.getElementById("ai-send") as HTMLButtonElement | null;

  const modeCopy: Record<ShaderMode, { kicker: string; title: string }> = {
    visual: { kicker: "Visual Builder", title: "Design your shader" },
    code: { kicker: "Code Editor", title: "Files & GLSL" },
    ai: { kicker: "AI Assistant", title: "Describe it, Anvil writes it" },
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

  const fileById = (id: string | null) =>
    id ? state.files.find((file) => file.id === id) ?? null : null;

  const fileByPath = (path: string) => state.files.find((file) => file.path === path) ?? null;

  const updateCounts = () => {
    if (fileCount) {
      fileCount.textContent = String(state.files.length);
    }

    if (savedCount) {
      savedCount.textContent = String(state.files.filter((file) => file.saved).length);
    }
  };

  // ---- Visual builder -> generated code -------------------------------------

  const generateProperties = (s: VisualSettings) => `# Generated by Anvil Visual Builder
sliders=EXPOSURE CONTRAST SATURATION FOG BLOOM
screen=EXPOSURE CONTRAST SATURATION FOG BLOOM

EXPOSURE=${s.exposure.toFixed(2)}
CONTRAST=${s.contrast.toFixed(2)}
SATURATION=${s.saturation.toFixed(2)}
FOG=${s.fog.toFixed(2)}
BLOOM=${s.bloom.toFixed(2)}

BLOOM_PASS=${s.effects.bloom}
WAVING_FOLIAGE=${s.effects.foliage}
WATER_RIPPLES=${s.effects.water}
VIGNETTE=${s.effects.vignette}
SHARPEN=${s.effects.sharpen}
`;

  const generateFinal = (s: VisualSettings) => {
    const lines = [
      "#version 120",
      "// Final color grade — generated by Anvil Visual Builder.",
      "uniform sampler2D colortex0;",
      "varying vec2 texcoord;",
      "",
      `const float EXPOSURE = ${s.exposure.toFixed(2)};`,
      `const float CONTRAST = ${s.contrast.toFixed(2)};`,
      `const float SATURATION = ${s.saturation.toFixed(2)};`,
      `const float FOG_DENSITY = ${s.fog.toFixed(2)};`,
      `const float BLOOM_STRENGTH = ${s.bloom.toFixed(2)};`,
      `const vec3 LIGHT_TINT = vec3(${hexToVec3(s.lightColor)});`,
      `const vec3 SKY_TINT = vec3(${hexToVec3(s.skyColor)});`,
      `const vec3 WATER_TINT = vec3(${hexToVec3(s.waterColor)});`,
      "",
      "void main() {",
      "    vec3 color = texture2D(colortex0, texcoord).rgb;",
      "    color *= EXPOSURE * LIGHT_TINT;",
      "    color = (color - 0.5) * CONTRAST + 0.5;",
      "    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));",
      "    color = mix(vec3(luma), color, SATURATION);",
      "    color = mix(color, SKY_TINT, FOG_DENSITY * 0.12);",
    ];

    if (s.effects.bloom) {
      lines.push("    color += BLOOM_STRENGTH * smoothstep(0.7, 1.0, luma) * SKY_TINT;");
    }

    if (s.effects.vignette) {
      lines.push("    color *= 1.0 - distance(texcoord, vec2(0.5)) * 0.5;");
    }

    if (s.effects.sharpen) {
      lines.push("    color += (color - vec3(luma)) * 0.15; // sharpen");
    }

    lines.push("    gl_FragColor = vec4(color, 1.0);", "}", "");
    return lines.join("\n");
  };

  // Write generated contents back into the matching files (creating them if the
  // user removed them) and mark them unsaved so they show up as pending writes.
  const writeGenerated = (path: string, language: string, contents: string) => {
    const existing = fileByPath(path);

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
    writeGenerated(GENERATED_FINAL_PATH, "GLSL", generateFinal(state.settings));
    writeGenerated(GENERATED_PROPERTIES_PATH, "Properties", generateProperties(state.settings));

    // Keep the open editor in sync if it shows one of the generated files.
    const active = fileById(state.activeFileId);
    if (active && (active.path === GENERATED_FINAL_PATH || active.path === GENERATED_PROPERTIES_PATH) && code) {
      code.value = active.contents;
    }

    renderTree();
    updateCounts();
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

  // ---- Code editor: file tree ----------------------------------------------

  const allFolderPaths = () => {
    const paths = new Set<string>(state.folders);
    state.files.forEach((file) => {
      let dir = dirOf(file.path);
      while (dir) {
        paths.add(dir);
        dir = dirOf(dir);
      }
    });
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
        file.path = newPath;
        file.name = name;
        file.language = languageForPath(newPath);
      }
    } else {
      const prefix = `${node.path}/`;
      const newPrefix = `${newPath}/`;
      state.folders = state.folders.map((folder) =>
        folder === node.path ? newPath : folder.startsWith(prefix) ? newPrefix + folder.slice(prefix.length) : folder,
      );
      state.files.forEach((file) => {
        if (file.path.startsWith(prefix)) {
          file.path = newPrefix + file.path.slice(prefix.length);
          file.name = baseOf(file.path);
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

    if (state.selectedPath === node.path) {
      state.selectedPath = newPath;
    }

    renderTree();
    refreshEditorBar();
    setStatus(`Renamed to ${name}.`);
  };

  const deleteNode = (node: TreeNode) => {
    if (node.type === "file") {
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
      state.files = state.files.filter((file) => !removed.includes(file));
      state.folders = state.folders.filter(
        (folder) => folder !== node.path && !folder.startsWith(prefix),
      );
      const active = fileById(state.activeFileId);
      if (active && removed.includes(active)) {
        state.activeFileId = null;
      }
    }

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
    if (dir) {
      state.expanded.add(dir);
    }
    state.selectedPath = path;
    updateCounts();
    renderTree();
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
    state.activeFileId = file.id;
    state.selectedPath = file.path;
    setCodeTab("editor");
    refreshEditorBar();
    renderTree();
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

      const twisty = document.createElement("span");
      twisty.className = "code-tree-twisty";
      twisty.textContent = "▶";

      const icon = document.createElement("span");
      icon.className = "code-tree-icon code-tree-icon--folder";

      row.append(twisty, icon);
      appendNameOrRename(row, node);
      appendActions(row, node);

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
    if (state.selectedPath === node.path) {
      row.classList.add("is-selected");
    }
    if (!node.file.saved) {
      row.classList.add("is-dirty");
    }
    row.style.paddingLeft = `${8 + depth * 15 + 16}px`;

    const icon = document.createElement("span");
    icon.className = `code-tree-icon ${fileIconClass(node.path)}`;
    row.append(icon);
    appendNameOrRename(row, node);
    appendActions(row, node);

    row.addEventListener("click", () => {
      state.selectedPath = node.path;
      renderTree();
    });
    row.addEventListener("dblclick", () => openFileInEditor(node.file));

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

  const refreshEditorBar = () => {
    const file = fileById(state.activeFileId);

    if (!file) {
      if (editorPath) {
        editorPath.textContent = "No file open";
      }
      if (editorEmpty) {
        editorEmpty.hidden = false;
      }
      if (code) {
        code.hidden = true;
      }
      if (editorDirty) {
        editorDirty.hidden = true;
      }
      return;
    }

    if (editorPath) {
      editorPath.textContent = `shaders/${file.path}`;
    }
    if (editorEmpty) {
      editorEmpty.hidden = true;
    }
    if (code) {
      code.hidden = false;
      code.value = file.contents;
    }
    if (editorDirty) {
      editorDirty.hidden = file.saved;
    }
  };

  // ---- Mode + tab switching -------------------------------------------------

  const setMode = (mode: ShaderMode) => {
    if (state.mode === mode) {
      return;
    }
    persistEditorContent();
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

  // ---- Save / export --------------------------------------------------------

  const persistFile = async (file: ShaderFile) => {
    const projectId = state.project.id ?? projectFallbackId(state.project.name);
    try {
      const saved = await invoke<ShaderFile>("save_shader_file", {
        projectId,
        fileId: file.id,
        contents: file.contents,
      });
      Object.assign(file, normalizeFile(saved));
    } catch (error) {
      if (isTauriRuntime()) {
        throw error;
      }
      writePreviewFile(projectId, file);
      file.saved = true;
    }
  };

  const saveAll = async () => {
    persistEditorContent();
    const pending = state.files.filter((file) => !file.saved);

    if (!pending.length) {
      setStatus("Everything is already saved.");
      return;
    }

    try {
      for (const file of pending) {
        await persistFile(file);
      }
      setStatus(`Saved ${pending.length} file${pending.length === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error("Failed to save shader files.", error);
      setStatus("Could not save shader files.");
    }

    renderTree();
    refreshEditorBar();
    updateCounts();
  };

  const exportShaderPack = async () => {
    await saveAll();

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
      reply:
        "Done — I warmed the sunlight, lifted exposure and bloom, and pushed the sky toward a golden tone. Open the Code editor to see the regenerated final.fsh.",
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
      reply:
        "Got it — dropped exposure, thickened the fog, desaturated a touch, and tinted the light a smoky orange for a moody nether feel.",
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
      reply:
        "Sharp and punchy it is — neutral white sunlight, boosted saturation and contrast, and the sharpen pass turned on for crisp textures.",
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
    reply:
      "I gave it a balanced cinematic grade — gentle exposure lift, a soft bloom, and a cool sky tint. Tweak it further in the Visual builder or ask me for a specific mood.",
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

  const appendUserMessage = (text: string) => {
    if (!aiThread) {
      return;
    }
    const message = document.createElement("div");
    message.className = "ai-message ai-message--user";
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    bubble.append(paragraph);
    message.append(bubble);
    aiThread.append(message);
    scrollThread();
  };

  const appendTyping = () => {
    if (!aiThread) {
      return null;
    }
    const message = document.createElement("div");
    message.className = "ai-message ai-message--assistant";
    const avatar = document.createElement("span");
    avatar.className = "ai-avatar";
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    const typing = document.createElement("div");
    typing.className = "ai-typing";
    typing.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    bubble.append(typing);
    message.append(avatar, bubble);
    aiThread.append(message);
    scrollThread();
    return message;
  };

  const appendAssistantReply = (preset: AiPreset, node: HTMLElement | null) => {
    if (!aiThread) {
      return;
    }
    const message = node ?? document.createElement("div");
    message.className = "ai-message ai-message--assistant";
    message.textContent = "";

    const avatar = document.createElement("span");
    avatar.className = "ai-avatar";

    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    const paragraph = document.createElement("p");
    paragraph.textContent = preset.reply;
    bubble.append(paragraph);

    const card = document.createElement("div");
    card.className = "ai-code-card";
    const head = document.createElement("div");
    head.className = "ai-code-card-head";
    const fileLabel = document.createElement("span");
    fileLabel.textContent = "shaders/final.fsh";
    const tag = document.createElement("span");
    tag.className = "ai-code-card-tag";
    tag.textContent = "Updated";
    head.append(fileLabel, tag);
    const pre = document.createElement("pre");
    pre.textContent = generateFinal(state.settings).split("\n").slice(0, 14).join("\n");
    card.append(head, pre);
    bubble.append(card);

    message.append(avatar, bubble);
    if (!node) {
      aiThread.append(message);
    }
    scrollThread();
  };

  const submitAiPrompt = (prompt: string) => {
    const text = prompt.trim();
    if (!text) {
      return;
    }
    appendUserMessage(text);
    if (aiInput) {
      aiInput.value = "";
      aiInput.style.height = "auto";
    }
    const preset = pickPreset(text);
    const typing = appendTyping();
    setStatus("Assistant is writing shader code…");

    window.setTimeout(() => {
      applyPreset(preset);
      appendAssistantReply(preset, typing);
      setStatus("Assistant updated final.fsh and shaders.properties.");
    }, 750);
  };

  // ---- Event wiring ---------------------------------------------------------

  bindVisualControls();

  document.querySelectorAll<HTMLButtonElement>("[data-shader-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode((button.dataset.shaderMode ?? "visual") as ShaderMode));
  });

  document.querySelectorAll<HTMLButtonElement>("[data-code-tab]").forEach((button) => {
    button.addEventListener("click", () => setCodeTab((button.dataset.codeTab ?? "explorer") as CodeTab));
  });

  document.getElementById("code-editor-back")?.addEventListener("click", () => setCodeTab("explorer"));
  document.getElementById("code-new-file")?.addEventListener("click", createFile);
  document.getElementById("code-new-folder")?.addEventListener("click", createFolder);

  code?.addEventListener("input", () => {
    const file = fileById(state.activeFileId);
    if (!file) {
      return;
    }
    file.contents = code.value;
    file.saved = false;
    if (editorDirty) {
      editorDirty.hidden = false;
    }
    setStatus("Unsaved shader changes.");
  });

  document.getElementById("shader-save-file")?.addEventListener("click", () => {
    void saveAll();
  });
  document.getElementById("shader-export-pack")?.addEventListener("click", () => {
    void exportShaderPack();
  });
  document.getElementById("shader-return-main-menu")?.addEventListener("click", () => {
    shaderWorkspace?.setAttribute("hidden", "");
    homeScreen?.removeAttribute("hidden");
  });

  document.querySelectorAll<HTMLButtonElement>("[data-ai-prompt]").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (aiInput) {
        aiInput.value = chip.dataset.aiPrompt ?? "";
        aiInput.focus();
      }
    });
  });

  document.getElementById("ai-composer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAiPrompt(aiInput?.value ?? "");
  });

  aiInput?.addEventListener("input", () => {
    aiInput.style.height = "auto";
    aiInput.style.height = `${Math.min(aiInput.scrollHeight, 140)}px`;
    if (aiSend) {
      aiSend.disabled = !aiInput.value.trim();
    }
  });

  aiInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitAiPrompt(aiInput.value);
    }
  });

  if (aiSend) {
    aiSend.disabled = true;
  }

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
    state.selectedPath = null;
    state.activeFileId = null;
    updateCounts();
    renderTree();
    refreshEditorBar();
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

      homeScreen?.setAttribute("hidden", "");
      textureWorkspace?.setAttribute("hidden", "");
      shaderWorkspace?.removeAttribute("hidden");
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
