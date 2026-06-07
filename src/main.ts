import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { initShaderWorkspace } from "./shaderWorkspace";
import { initWorkspace } from "./workspace";

function bindWindowControl(id: string, action: () => Promise<void>) {
  document.getElementById(id)?.addEventListener("click", (event) => {
    event.stopPropagation();
    void action().catch((error) => console.error(error));
  });
}

function withCurrentWindow(action: (appWindow: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  try {
    return action(getCurrentWindow());
  } catch (error) {
    console.warn("Window controls are available inside the Tauri shell only.", error);
    return Promise.resolve();
  }
}

const minecraftColors: Record<string, string> = {
  "§0": "#000000",
  "§1": "#0000aa",
  "§2": "#00aa00",
  "§4": "#aa0000",
  "§6": "#ffaa00",
  "§b": "#55ffff",
  "§d": "#ff55ff",
  "§f": "#ffffff",
};

const DESCRIPTION_LIMIT = 160;
const PROJECTS_STORAGE_KEY = "anvil.projects.preview";
const latestMinecraftVersion = "26.1.2";
const minecraftVersions = [
  "26.1.2",
  "26.1.1",
  "26.1",
  "1.21.11",
  "1.21.10",
  "1.21.9",
  "1.21.8",
  "1.21.7",
  "1.21.6",
  "1.21.5",
  "1.21.4",
  "1.21.3",
  "1.21.2",
  "1.21.1",
  "1.21",
  "1.20.6",
  "1.20.5",
  "1.20.4",
  "1.20.3",
  "1.20.2",
  "1.20.1",
  "1.20",
  "1.19.4",
  "1.19.3",
  "1.19.2",
  "1.19.1",
  "1.19",
  "1.18.2",
  "1.18.1",
  "1.18",
  "1.17.1",
  "1.17",
  "1.16.5",
  "1.16.4",
  "1.16.3",
  "1.16.2",
  "1.16.1",
  "1.16",
  "1.15.2",
  "1.15.1",
  "1.15",
  "1.14.4",
  "1.14.3",
  "1.14.2",
  "1.14.1",
  "1.14",
  "1.13.2",
  "1.13.1",
  "1.13",
  "1.12.2",
  "1.12.1",
  "1.12",
  "1.11.2",
  "1.11.1",
  "1.11",
  "1.10.2",
  "1.10.1",
  "1.10",
  "1.9.4",
  "1.9.3",
  "1.9.2",
  "1.9.1",
  "1.9",
  "1.8.9",
  "1.8.8",
  "1.8.7",
  "1.8.6",
  "1.8.5",
  "1.8.4",
  "1.8.3",
  "1.8.2",
  "1.8.1",
  "1.8",
  "1.7.10",
  "1.7.9",
  "1.7.8",
  "1.7.7",
  "1.7.6",
  "1.7.5",
  "1.7.4",
  "1.7.3",
  "1.7.2",
  "1.6.4",
  "1.6.2",
  "1.6.1",
  "1.5.2",
  "1.5.1",
  "1.4.7",
  "1.4.6",
  "1.4.5",
  "1.4.4",
  "1.4.2",
  "1.3.2",
  "1.3.1",
  "1.2.5",
  "1.2.4",
  "1.2.3",
  "1.2.2",
  "1.2.1",
  "1.1",
  "1.0",
];

type PersistedProject = {
  id: string;
  projectType: ProjectType;
  name: string;
  minecraftVersion: string;
  packVersion: string;
  author: string;
  description: string;
  iconBase64: string;
  createdAt: number;
  updatedAt: number;
  minecraft_version?: string;
  pack_version?: string;
  icon_base64?: string;
  created_at?: number;
  updated_at?: number;
  project_type?: ProjectType;
};

type ProjectType = "texture" | "shader";

type ProjectInput = {
  id?: string;
  projectType: ProjectType;
  name: string;
  minecraftVersion: string;
  packVersion: string;
  author: string;
  description: string;
  iconBase64: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };

    return replacements[character] ?? character;
  });
}

function stripHtml(value = "") {
  const element = document.createElement("div");
  element.innerHTML = value;
  return element.textContent ?? "";
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

let autoUpdateStarted = false;

async function installAvailableUpdate() {
  if (!isTauriRuntime() || autoUpdateStarted) {
    return;
  }

  autoUpdateStarted = true;

  try {
    const update = await check();

    if (!update) {
      return;
    }

    console.info(`Installing Anvil ${update.version} update.`);
    await update.downloadAndInstall();
    await relaunch();
  } catch (error) {
    console.error("Automatic update failed.", error);
  }
}

const GITHUB_REPO_URL = "https://github.com/NssIs/Anvil";
const GITHUB_CONTRIBUTORS_URL = "https://api.github.com/repos/NssIs/Anvil/contributors?per_page=30";

type GithubContributor = {
  login: string;
  avatar_url: string;
  html_url: string;
  contributions: number;
  type?: string;
};

function openExternal(url: string) {
  void (async () => {
    try {
      // In the Tauri shell, hand the URL to the OS browser via the backend.
      await invoke("open_external", { url });
    } catch (error) {
      if (isTauriRuntime()) {
        console.error("Failed to open external link.", error);
        return;
      }

      // Browser preview fallback.
      window.open(url, "_blank", "noopener,noreferrer");
    }
  })();
}

async function loadContributors() {
  const list = document.getElementById("contributors-list");

  if (!list) {
    return;
  }

  const showMessage = (message: string) => {
    const note = document.createElement("p");
    note.className = "contributors-empty";
    note.textContent = message;
    list.textContent = "";
    list.append(note);
  };

  try {
    const response = await fetch(GITHUB_CONTRIBUTORS_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });

    if (!response.ok) {
      throw new Error(`GitHub responded with ${response.status}`);
    }

    const data = (await response.json()) as GithubContributor[];
    const people = Array.isArray(data) ? data.filter((person) => person.type !== "Bot") : [];

    if (!people.length) {
      showMessage("No contributors yet.");
      return;
    }

    list.textContent = "";

    people.forEach((person) => {
      const commits = `${person.contributions} commit${person.contributions === 1 ? "" : "s"}`;
      const card = document.createElement("a");
      card.className = "contributor-card";
      card.href = person.html_url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
      card.title = `${person.login} — ${commits}`;
      card.addEventListener("click", (event) => {
        event.preventDefault();
        openExternal(person.html_url);
      });

      const avatar = document.createElement("img");
      avatar.className = "contributor-avatar";
      avatar.src = `${person.avatar_url}${person.avatar_url.includes("?") ? "&" : "?"}s=80`;
      avatar.alt = person.login;
      avatar.loading = "lazy";

      const meta = document.createElement("span");
      meta.className = "contributor-meta";
      const name = document.createElement("strong");
      name.textContent = person.login;
      const role = document.createElement("small");
      role.textContent = commits;
      meta.append(name, role);

      card.append(avatar, meta);
      list.append(card);
    });
  } catch (error) {
    console.warn("Failed to load contributors.", error);
    showMessage("Couldn't load contributors. Check your connection.");
  }
}

function normalizeProject(raw: PersistedProject): PersistedProject {
  return {
    id: String(raw.id ?? ""),
    projectType: raw.projectType ?? raw.project_type ?? "texture",
    name: String(raw.name ?? "Untitled Pack"),
    minecraftVersion: String(raw.minecraftVersion ?? raw.minecraft_version ?? "1.21.6"),
    packVersion: String(raw.packVersion ?? raw.pack_version ?? "1.0"),
    author: String(raw.author ?? "Me!"),
    description: String(raw.description ?? ""),
    iconBase64: String(raw.iconBase64 ?? raw.icon_base64 ?? ""),
    createdAt: Number(raw.createdAt ?? raw.created_at ?? 0),
    updatedAt: Number(raw.updatedAt ?? raw.updated_at ?? 0),
  };
}

function readPreviewProjects() {
  try {
    const projects = JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) ?? "[]");

    return Array.isArray(projects)
      ? projects.map((project) => normalizeProject(project as PersistedProject))
      : [];
  } catch (error) {
    console.warn("Failed to read preview projects.", error);
    return [];
  }
}

function writePreviewProjects(projects: PersistedProject[]) {
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
}

function createPreviewProjectId(name: string) {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";

  return `${slug}-${Date.now()}`;
}

function savePreviewProject(input: ProjectInput) {
  const projects = readPreviewProjects();
  const now = Math.floor(Date.now() / 1000);
  const existing = input.id
    ? projects.find((project) => project.id === input.id)
    : undefined;
  const project: PersistedProject = {
    id: existing?.id ?? input.id ?? createPreviewProjectId(input.name),
    projectType: input.projectType,
    name: input.name,
    minecraftVersion: input.minecraftVersion,
    packVersion: input.packVersion,
    author: input.author,
    description: input.description,
    iconBase64: input.iconBase64,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const nextProjects = [project, ...projects.filter((candidate) => candidate.id !== project.id)];
  writePreviewProjects(nextProjects);

  return project;
}

async function listProjects() {
  try {
    return (await invoke<PersistedProject[]>("list_projects")).map(normalizeProject);
  } catch (error) {
    if (isTauriRuntime()) {
      throw error;
    }

    console.warn("Project listing is using the browser preview store.", error);
    return readPreviewProjects().sort((left, right) => right.updatedAt - left.updatedAt);
  }
}

async function saveProject(input: ProjectInput) {
  try {
    const project = await invoke<PersistedProject>("save_project", {
      id: input.id ?? null,
      projectType: input.projectType,
      name: input.name,
      minecraftVersion: input.minecraftVersion,
      packVersion: input.packVersion,
      author: input.author,
      description: input.description,
      iconBase64: input.iconBase64,
    });

    return normalizeProject(project);
  } catch (error) {
    if (isTauriRuntime()) {
      throw error;
    }

    console.warn("Project saving is using the browser preview store.", error);
    return savePreviewProject(input);
  }
}

async function deleteProject(project: PersistedProject) {
  try {
    await invoke("delete_project", { id: project.id });
  } catch (error) {
    if (isTauriRuntime()) {
      throw error;
    }

    console.warn("Project deletion is using the browser preview store.", error);
    writePreviewProjects(readPreviewProjects().filter((candidate) => candidate.id !== project.id));
  }
}


function applyDescriptionFormat(editor: HTMLElement, code: string) {
  editor.focus();

  if (minecraftColors[code]) {
    document.execCommand("foreColor", false, minecraftColors[code]);
    return;
  }

  const commandByCode: Record<string, string> = {
    "§l": "bold",
    "§o": "italic",
    "§n": "underline",
    "§r": "removeFormat",
  };

  const command = commandByCode[code];

  if (command) {
    document.execCommand(command);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void installAvailableUpdate();

  const workspace = initWorkspace();
  const shaderWorkspace = initShaderWorkspace();

  const previewParams = new URLSearchParams(window.location.search);

  if (previewParams.get("workspace") === "1") {
    workspace.open({
      name: "Ancient Blocks",
      minecraftVersion: "1.21.6",
      packVersion: "1.0",
      author: "Me!",
      description: "Preview workspace project.",
    });
  }

  if (previewParams.get("shader") === "1") {
    shaderWorkspace.open({
      name: "Aurora Shade",
      minecraftVersion: "1.21.6",
      packVersion: "1.0",
      author: "Me!",
      description: "Preview shader project.",
    });
  }

  bindWindowControl("window-close", () => withCurrentWindow((appWindow) => appWindow.close()));
  bindWindowControl("window-minimize", () =>
    withCurrentWindow((appWindow) => appWindow.minimize()),
  );
  bindWindowControl("window-expand", () =>
    withCurrentWindow((appWindow) => appWindow.toggleMaximize()),
  );

  document.querySelector(".titlebar")?.addEventListener("dblclick", (event) => {
    if ((event.target as HTMLElement).closest(".window-control")) {
      return;
    }

    void withCurrentWindow((appWindow) => appWindow.toggleMaximize());
  });

  const createProjectButton = document.getElementById("create-project");
  const modal = document.getElementById("project-modal");
  const projectTypeButtons = document.querySelectorAll<HTMLButtonElement>("[data-project-type]");
  const packNameLabel = document.getElementById("pack-name-label");
  const packNameInput = document.getElementById("pack-name") as HTMLInputElement | null;
  const packNameCount = document.getElementById("pack-name-count");
  const packDescription = document.getElementById(
    "pack-description",
  ) as HTMLElement | null;
  const packDescriptionValue = document.getElementById(
    "pack-description-value",
  ) as HTMLInputElement | null;
  const descriptionCount = document.getElementById("description-count");
  const packIcon = document.getElementById("pack-icon") as HTMLInputElement | null;
  const packAuthor = document.getElementById("pack-author") as HTMLInputElement | null;
  const minecraftVersion = document.getElementById(
    "minecraft-version",
  ) as HTMLInputElement | null;
  const versionCombobox = document.getElementById("version-combobox");
  const versionMenu = document.getElementById("version-menu");
  const versionStatus = document.getElementById("version-status");
  const minecraftVersionLabel = document.getElementById("minecraft-version-label");
  const iconPreview = document.getElementById("icon-preview");
  const projectForm = document.querySelector(".project-form");
  let packIconDataUrl = "";
  let projects: PersistedProject[] = [];
  let editingProjectId: string | null = null;
  let selectedProjectType: ProjectType = "texture";
  const recentProjectList = document.getElementById("recent-project-list");
  const showAllProjects = document.getElementById("show-all-projects") as HTMLButtonElement | null;
  const projectLibraryModal = document.getElementById("project-library-modal");
  const projectLibraryList = document.getElementById("project-library-list");
  const deleteModal = document.getElementById("delete-modal");
  const deleteModalBody = document.getElementById("delete-body");
  const confirmDeleteButton = document.getElementById("confirm-delete") as HTMLButtonElement | null;
  const librarySearch = document.getElementById("library-search") as HTMLInputElement | null;
  let libraryQuery = "";

  const openPersistedProject = (project: PersistedProject) => {
    const payload = {
      id: project.id,
      name: project.name,
      minecraftVersion: project.minecraftVersion,
      packVersion: project.packVersion,
      author: project.author,
      description: project.description,
      iconDataUrl: project.iconBase64,
    };

    if (project.projectType === "shader") {
      shaderWorkspace.open(payload);
    } else {
      workspace.open(payload);
    }

    projectLibraryModal?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  };

  // A single floating actions menu, anchored in <body> so it is never clipped
  // by a scrolling/overflow-hidden modal.
  let actionsMenu: HTMLElement | null = null;
  let actionsButton: HTMLElement | null = null;

  const ensureActionsMenu = () => {
    if (!actionsMenu) {
      actionsMenu = document.createElement("div");
      actionsMenu.className = "project-actions-menu";
      actionsMenu.setAttribute("role", "menu");
      actionsMenu.setAttribute("aria-hidden", "true");
      document.body.append(actionsMenu);
    }

    return actionsMenu;
  };

  const closeProjectActions = () => {
    actionsMenu?.setAttribute("aria-hidden", "true");
    actionsButton?.setAttribute("aria-expanded", "false");
    actionsButton = null;
  };

  const projectTypeCopy = (projectType: ProjectType) =>
    projectType === "shader"
      ? {
          title: "Shader pack",
          editTitle: "Edit shader pack",
          nameLabel: "Shader pack name",
          namePlaceholder: "Aurora Shade",
          versionLabel: "Compatibility target",
          versionStatus: "Optional target, example: 1.21.6",
          descriptionPlaceholder: "Soft lighting, colored skies, and water tweaks.",
          empty: "No projects yet.",
        }
      : {
          title: "Texture pack",
          editTitle: "Edit texture pack",
          nameLabel: "Texture pack name",
          namePlaceholder: "Nightfall Tweaks",
          versionLabel: "Minecraft version",
          versionStatus: "Example: 1.16.5",
          descriptionPlaceholder: "A clean texture pack for survival worlds.",
          empty: "No projects yet.",
        };

  const formBody = projectForm as HTMLElement | null;

  // Re-trigger the staggered cross-fade on the form fields. Removing the class,
  // forcing a reflow, then re-adding it restarts the CSS animation every switch.
  const playFormSwap = () => {
    if (!formBody) {
      return;
    }

    formBody.classList.remove("project-form--swap");
    void formBody.offsetWidth;
    formBody.classList.add("project-form--swap");
  };

  const setSelectedProjectType = (projectType: ProjectType) => {
    const isSwitch =
      selectedProjectType !== projectType && modal?.getAttribute("aria-hidden") === "false";
    selectedProjectType = projectType;
    const copy = projectTypeCopy(projectType);
    const title = document.getElementById("project-modal-title");

    if (title) {
      title.textContent = editingProjectId ? copy.editTitle : copy.title;
    }

    if (packNameLabel) {
      packNameLabel.textContent = copy.nameLabel;
    }

    if (packNameInput) {
      packNameInput.placeholder = copy.namePlaceholder;
    }

    if (minecraftVersionLabel) {
      minecraftVersionLabel.textContent = copy.versionLabel;
    }

    if (versionStatus) {
      versionStatus.textContent = copy.versionStatus;
    }

    if (packDescription) {
      packDescription.dataset.placeholder = copy.descriptionPlaceholder;
    }

    projectTypeButtons.forEach((button) => {
      const isActive = button.dataset.projectType === projectType;
      button.classList.toggle("project-type--active", isActive);
    });

    if (isSwitch) {
      playFormSwap();
    }
  };

  const openProjectActions = (project: PersistedProject, button: HTMLElement) => {
    const menu = ensureActionsMenu();
    menu.textContent = "";
    menu.append(
      buildProjectMenuItem("Edit", "project-menu-icon--edit", () => {
        closeProjectActions();
        openProjectEditor(project);
      }),
      buildProjectMenuItem(
        "Delete",
        "project-menu-icon--delete",
        () => {
          closeProjectActions();
          openDeleteModal(project);
        },
        true,
      ),
    );

    menu.setAttribute("aria-hidden", "false");
    actionsButton = button;
    button.setAttribute("aria-expanded", "true");

    // Anchor to the button, flipping above/left if it would overflow the viewport.
    const anchor = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = anchor.bottom + 6;
    let left = anchor.right - menuRect.width;

    if (top + menuRect.height > window.innerHeight - 8) {
      top = anchor.top - menuRect.height - 6;
    }

    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;
  };

  const resetProjectForm = () => {
    editingProjectId = null;
    packIconDataUrl = "";
    setSelectedProjectType("texture");

    if (packNameInput) {
      packNameInput.value = "";
      packNameInput.setCustomValidity("");
    }

    if (packNameCount) {
      packNameCount.textContent = "0";
    }

    if (packAuthor) {
      packAuthor.value = "";
    }

    if (minecraftVersion) {
      minecraftVersion.value = "";
    }

    if (packDescription) {
      packDescription.textContent = "";
    }

    if (iconPreview) {
      iconPreview.style.backgroundImage = "";
      iconPreview.classList.remove("icon-preview--filled");
    }

    syncDescriptionValue();
    validateMinecraftVersion();

    const submit = projectForm?.querySelector<HTMLButtonElement>("button[type='submit']");

    if (submit) {
      submit.textContent = "Create";
    }
  };

  const openProjectEditor = (project: PersistedProject) => {
    editingProjectId = project.id;
    setSelectedProjectType(project.projectType);

    if (packNameInput) {
      packNameInput.value = project.name;
      packNameInput.setCustomValidity("");
    }

    if (packNameCount) {
      packNameCount.textContent = String(project.name.length);
    }

    if (packAuthor) {
      packAuthor.value = project.author;
    }

    if (minecraftVersion) {
      minecraftVersion.value = project.minecraftVersion;
    }

    if (packDescription) {
      packDescription.innerHTML = project.description;
    }

    packIconDataUrl = project.iconBase64 || "";

    if (iconPreview) {
      if (project.iconBase64) {
        iconPreview.style.backgroundImage = `url("${project.iconBase64}")`;
        iconPreview.classList.add("icon-preview--filled");
      } else {
        iconPreview.style.backgroundImage = "";
        iconPreview.classList.remove("icon-preview--filled");
      }
    }

    syncDescriptionValue();
    validateMinecraftVersion();

    const submit = projectForm?.querySelector<HTMLButtonElement>("button[type='submit']");

    if (submit) {
      submit.textContent = "Save changes";
    }

    setModalOpen(true);
  };

  const DELETE_WAIT_SECONDS = 3;
  let deleteTarget: PersistedProject | null = null;
  let deleteCountdownTimer: number | undefined;

  const stopDeleteCountdown = () => {
    if (deleteCountdownTimer !== undefined) {
      window.clearInterval(deleteCountdownTimer);
      deleteCountdownTimer = undefined;
    }
  };

  const closeDeleteModal = () => {
    deleteModal?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    stopDeleteCountdown();
    deleteTarget = null;
  };

  const openDeleteModal = (project: PersistedProject) => {
    deleteTarget = project;

    if (deleteModalBody) {
      const savedData = project.projectType === "shader" ? "saved shader files" : "saved textures";
      deleteModalBody.textContent = `Deleting “${project.name}” erases its ${savedData} and project data from this computer. This action cannot be undone.`;
    }

    deleteModal?.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    // Force the user to wait a few seconds before the destructive button unlocks.
    stopDeleteCountdown();
    let remaining = DELETE_WAIT_SECONDS;

    if (confirmDeleteButton) {
      confirmDeleteButton.disabled = true;
      confirmDeleteButton.textContent = `Delete in ${remaining}…`;
    }

    deleteCountdownTimer = window.setInterval(() => {
      remaining -= 1;

      if (remaining <= 0) {
        stopDeleteCountdown();

        if (confirmDeleteButton) {
          confirmDeleteButton.disabled = false;
          confirmDeleteButton.textContent = "Delete project";
        }
      } else if (confirmDeleteButton) {
        confirmDeleteButton.textContent = `Delete in ${remaining}…`;
      }
    }, 1000);
  };

  const confirmDelete = () => {
    const project = deleteTarget;

    if (!project || confirmDeleteButton?.disabled) {
      return;
    }

    closeDeleteModal();

    void (async () => {
      try {
        await deleteProject(project);
        await refreshProjects();
      } catch (error) {
        console.error("Failed to delete project.", error);
      }
    })();
  };

  const buildProjectMenuItem = (
    label: string,
    iconModifier: string,
    onSelect: () => void,
    danger = false,
  ) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = danger ? "project-menu-item project-menu-item--danger" : "project-menu-item";
    item.setAttribute("role", "menuitem");

    const icon = document.createElement("span");
    icon.className = `project-menu-icon ${iconModifier}`;
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.textContent = label;

    item.append(icon, text);
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect();
    });

    return item;
  };

  const renderProjectCard = (project: PersistedProject) => {
    const card = document.createElement("div");
    card.className = "project-card project-card--menu";
    card.dataset.projectId = project.id;

    const typeLabel = project.projectType === "shader" ? "Shader pack" : "Texture pack";
    const plainDescription = stripHtml(project.description).trim();
    const description =
      plainDescription ||
      (project.projectType === "shader"
        ? `${project.minecraftVersion} shader target by ${project.author}.`
        : `${project.minecraftVersion} texture pack by ${project.author}.`);
    const iconLabel = project.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || (project.projectType === "shader" ? "S" : "TP");

    const launch = document.createElement("button");
    launch.className = "project-card-launch";
    launch.type = "button";
    launch.setAttribute("aria-label", `Open ${project.name}`);
    launch.innerHTML = `
      <span class="project-icon">${escapeHtml(iconLabel)}</span>
      <span class="project-copy">
        <small>${escapeHtml(typeLabel)}</small>
        <h2>${escapeHtml(project.name)}</h2>
        <p>${escapeHtml(description)}</p>
      </span>
    `;

    const icon = launch.querySelector<HTMLElement>(".project-icon");

    if (icon && project.iconBase64) {
      icon.textContent = "";
      icon.classList.add("project-icon--image");
      icon.style.backgroundImage = `url("${project.iconBase64}")`;
    }

    launch.addEventListener("click", () => openPersistedProject(project));

    const menuButton = document.createElement("button");
    menuButton.className = "project-menu";
    menuButton.type = "button";
    menuButton.textContent = "⋯";
    menuButton.setAttribute("aria-haspopup", "true");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", `Options for ${project.name}`);

    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = actionsButton === menuButton;
      closeProjectActions();

      if (!isOpen) {
        openProjectActions(project, menuButton);
      }
    });

    card.append(launch, menuButton);

    return card;
  };

  const renderProjectList = (target: HTMLElement | null, nextProjects: PersistedProject[]) => {
    if (!target) {
      return;
    }

    target.textContent = "";

    if (!nextProjects.length) {
      const empty = document.createElement("p");
      empty.className = "project-empty";
      empty.textContent = "No projects yet.";
      target.append(empty);
      return;
    }

    nextProjects.forEach((project) => target.append(renderProjectCard(project)));
  };

  const renderLibraryList = () => {
    const libraryProjects = libraryQuery
      ? projects.filter((project) => project.name.toLowerCase().includes(libraryQuery))
      : projects;
    renderProjectList(projectLibraryList, libraryProjects);
  };

  const renderProjects = () => {
    closeProjectActions();
    renderProjectList(recentProjectList, projects.slice(0, 3));
    renderLibraryList();

    if (showAllProjects) {
      showAllProjects.hidden = projects.length <= 3;
    }
  };

  const openProjectLibrary = () => {
    libraryQuery = "";

    if (librarySearch) {
      librarySearch.value = "";
    }

    renderProjects();
    projectLibraryModal?.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    requestAnimationFrame(() => librarySearch?.focus());
  };

  // Debounce search so each keystroke doesn't trigger a full synchronous re-render
  // (which janked the whole window on the first keypress), and only re-render the
  // library list — the recent list never changes while searching.
  let librarySearchTimer: number | undefined;
  librarySearch?.addEventListener("input", () => {
    libraryQuery = librarySearch.value.trim().toLowerCase();

    if (librarySearchTimer !== undefined) {
      window.clearTimeout(librarySearchTimer);
    }

    librarySearchTimer = window.setTimeout(renderLibraryList, 120);
  });

  const refreshProjects = async () => {
    try {
      projects = await listProjects();
    } catch (error) {
      console.error("Failed to load projects.", error);
      projects = [];
    }

    renderProjects();
  };

  const syncDescriptionValue = () => {
    if (packDescription && packDescriptionValue) {
      if (packDescription.textContent && packDescription.textContent.length > DESCRIPTION_LIMIT) {
        packDescription.textContent = packDescription.textContent.slice(0, DESCRIPTION_LIMIT);
      }

      packDescriptionValue.value = packDescription.innerHTML;

      if (descriptionCount) {
        descriptionCount.textContent = String(packDescription.textContent?.length ?? 0);
      }
    }
  };

  const setVersionMenuOpen = (isOpen: boolean) => {
    versionMenu?.setAttribute("aria-hidden", String(!isOpen));
    minecraftVersion?.setAttribute("aria-expanded", String(isOpen));
  };

  const renderVersionOptions = (versions: string[]) => {
    if (!versionMenu) {
      return;
    }

    versionMenu.textContent = "";

    versions.slice(0, 9).forEach((version) => {
      const option = document.createElement("button");
      option.className =
        version === latestMinecraftVersion
          ? "version-option version-option--latest"
          : "version-option";
      option.type = "button";
      option.dataset.version = version;
      option.innerHTML =
        version === latestMinecraftVersion ? `${version} <span>Latest</span>` : version;
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => {
        if (minecraftVersion) {
          minecraftVersion.value = version;
          validateMinecraftVersion();
          minecraftVersion.focus();
        }
      });
      versionMenu.append(option);
    });
  };

  const validateMinecraftVersion = () => {
    if (!minecraftVersion || !versionStatus) {
      return;
    }

    const value = minecraftVersion.value.trim();
    const exactMatch = minecraftVersions.includes(value);
    const matches = value
      ? minecraftVersions.filter((version) => version.startsWith(value))
      : [];

    versionCombobox?.classList.toggle("version-combobox--invalid", Boolean(value && !matches.length));
    versionCombobox?.classList.toggle("version-combobox--valid", exactMatch);

    if (!value) {
      versionStatus.textContent =
        selectedProjectType === "shader" ? "Optional target, example: 1.21.6" : "Example: 1.16.5";
      versionStatus.className = "version-status";
      setVersionMenuOpen(false);
      return;
    }

    if (!matches.length) {
      versionStatus.textContent = "Unknown Minecraft version";
      versionStatus.className = "version-status version-status--invalid";
      setVersionMenuOpen(false);
      return;
    }

    if (exactMatch) {
      versionStatus.textContent =
        value === latestMinecraftVersion ? "Latest release" : "Valid Minecraft version";
      versionStatus.className = "version-status version-status--valid";
      setVersionMenuOpen(false);
      return;
    }

    versionStatus.textContent = "Choose a matching version";
    versionStatus.className = "version-status";
    renderVersionOptions(matches);
    setVersionMenuOpen(true);
  };

  const setModalOpen = (isOpen: boolean) => {
    modal?.setAttribute("aria-hidden", String(!isOpen));
    document.body.classList.toggle("modal-open", isOpen);

    if (isOpen) {
      requestAnimationFrame(() => packNameInput?.focus());
    } else {
      createProjectButton?.focus();
    }
  };

  createProjectButton?.addEventListener("click", () => {
    resetProjectForm();
    setModalOpen(true);
  });

  projectTypeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) {
        return;
      }

      setSelectedProjectType((button.dataset.projectType ?? "shader") as ProjectType);
      validateMinecraftVersion();
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    if (!target.closest(".project-menu") && !target.closest(".project-actions-menu")) {
      closeProjectActions();
    }
  });
  window.addEventListener("scroll", () => closeProjectActions(), true);
  window.addEventListener("resize", () => closeProjectActions());
  document.getElementById("open-project")?.addEventListener("click", () => {
    if (!projects.length) {
      setModalOpen(true);
      return;
    }

    openProjectLibrary();
  });
  showAllProjects?.addEventListener("click", openProjectLibrary);
  document.getElementById("close-project-library")?.addEventListener("click", () => {
    projectLibraryModal?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  });

  document.getElementById("confirm-delete")?.addEventListener("click", confirmDelete);
  document.getElementById("cancel-delete")?.addEventListener("click", closeDeleteModal);
  document.getElementById("close-delete")?.addEventListener("click", closeDeleteModal);
  deleteModal?.addEventListener("mousedown", (event) => {
    if (event.target === deleteModal) {
      closeDeleteModal();
    }
  });

  document.getElementById("report-issue")?.addEventListener("click", () => {
    openExternal(`${GITHUB_REPO_URL}/issues`);
  });
  document.getElementById("repo-card")?.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(GITHUB_REPO_URL);
  });
  void loadContributors();

  document.getElementById("cancel-project")?.addEventListener("click", () => {
    setModalOpen(false);
  });
  document.getElementById("modal-x")?.addEventListener("click", () => {
    setModalOpen(false);
  });

  modal?.addEventListener("mousedown", (event) => {
    if (event.target === modal) {
      setModalOpen(false);
    }
  });
  projectLibraryModal?.addEventListener("mousedown", (event) => {
    if (event.target === projectLibraryModal) {
      projectLibraryModal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal?.getAttribute("aria-hidden") === "false") {
      setModalOpen(false);
    }
    if (
      event.key === "Escape" &&
      projectLibraryModal?.getAttribute("aria-hidden") === "false"
    ) {
      projectLibraryModal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("modal-open");
    }
    if (event.key === "Escape" && deleteModal?.getAttribute("aria-hidden") === "false") {
      closeDeleteModal();
    }
    if (event.key === "Escape") {
      closeProjectActions();
    }
  });

  packNameInput?.addEventListener("input", () => {
    packNameInput.setCustomValidity("");

    if (packNameCount) {
      packNameCount.textContent = String(packNameInput.value.length);
    }
  });

  packIcon?.addEventListener("change", () => {
    const file = packIcon.files?.[0];

    if (!file || !iconPreview) {
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      packIconDataUrl = typeof reader.result === "string" ? reader.result : "";
      iconPreview.textContent = "";
      iconPreview.style.backgroundImage = `url("${packIconDataUrl}")`;
      iconPreview.classList.add("icon-preview--filled");
    });
    reader.readAsDataURL(file);
  });

  minecraftVersion?.addEventListener("input", validateMinecraftVersion);
  minecraftVersion?.addEventListener("focus", validateMinecraftVersion);
  minecraftVersion?.addEventListener("click", validateMinecraftVersion);
  document.getElementById("version-toggle")?.addEventListener("click", () => {
    validateMinecraftVersion();
    minecraftVersion?.focus();
  });

  document.addEventListener("mousedown", (event) => {
    if (!versionCombobox?.contains(event.target as Node)) {
      setVersionMenuOpen(false);
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-code]").forEach((button) => {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });

    button.addEventListener("click", () => {
      if (!packDescription) {
        return;
      }

      if (button.dataset.code && minecraftColors[button.dataset.code]) {
        document
          .querySelectorAll<HTMLButtonElement>(".swatch.is-active")
          .forEach((swatch) => swatch.classList.remove("is-active"));
        button.classList.add("is-active");
      }

      if (button.dataset.code === "§r") {
        document
          .querySelectorAll<HTMLButtonElement>(".swatch.is-active")
          .forEach((swatch) => swatch.classList.remove("is-active"));
      }

      applyDescriptionFormat(packDescription, button.dataset.code ?? "");
      syncDescriptionValue();
    });
  });

  packDescription?.addEventListener("beforeinput", (event) => {
    const inputEvent = event as InputEvent;
    const nextLength =
      (packDescription.textContent?.length ?? 0) + (inputEvent.data?.length ?? 0);

    if (
      inputEvent.inputType.startsWith("insert") &&
      nextLength > DESCRIPTION_LIMIT &&
      !window.getSelection()?.toString()
    ) {
      event.preventDefault();
    }
  });

  packDescription?.addEventListener("input", syncDescriptionValue);

  projectForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    syncDescriptionValue();
    const projectName = packNameInput?.value.trim() ?? "";

    if (!projectName) {
      packNameInput?.setCustomValidity("Project name is required.");
      packNameInput?.reportValidity();
      packNameInput?.focus();
      return;
    }

    const isEditing = Boolean(editingProjectId);

    void (async () => {
      try {
        const project = await saveProject({
          id: editingProjectId ?? undefined,
          projectType: selectedProjectType,
          name: projectName,
          minecraftVersion: minecraftVersion?.value || "1.21.6",
          packVersion: "1.0",
          author: packAuthor?.value || "Me!",
          description: packDescriptionValue?.value || packDescription?.textContent || "",
          iconBase64: packIconDataUrl,
        });

        await refreshProjects();
        setModalOpen(false);

        if (isEditing) {
          // Editing only updates pack details — don't yank the user into the workspace.
          resetProjectForm();
        } else {
          openPersistedProject(project);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        packNameInput?.setCustomValidity(message);
        packNameInput?.reportValidity();
        packNameInput?.setCustomValidity("");
      }
    })();
  });

  void refreshProjects();
});
