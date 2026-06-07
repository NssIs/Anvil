use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read, Seek, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use zip::ZipArchive;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum AssetKind {
    Block,
    Item,
    Entity,
    Other,
}

impl AssetKind {
    fn as_path(self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::Item => "item",
            Self::Entity => "entity",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Copy)]
struct CatalogAsset {
    kind: AssetKind,
    name: &'static str,
    display_name: &'static str,
    description: &'static str,
}

#[derive(Serialize)]
struct AssetMetadata {
    id: String,
    kind: AssetKind,
    name: String,
    display_name: String,
    description: String,
    saved: bool,
    texture_path: Option<String>,
    preview_path: Option<String>,
}

#[derive(Serialize)]
struct SavedTexture {
    asset_id: String,
    path: String,
    bytes: usize,
}

#[derive(Serialize)]
struct LoadedTexture {
    asset_id: String,
    png_base64: String,
}

#[derive(Serialize)]
struct ExportedPack {
    path: String,
    texture_count: usize,
    pack_format: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureProject {
    id: String,
    name: String,
    minecraft_version: String,
    pack_version: String,
    author: String,
    description: String,
    icon_base64: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Serialize)]
struct TextureCacheProgress {
    progress: f32,
    stage: String,
    message: String,
    current: usize,
    total: usize,
}

#[derive(Clone)]
struct ParsedAssetId {
    kind: AssetKind,
    name: String,
}

#[derive(Clone)]
struct DynamicAsset {
    kind: AssetKind,
    name: String,
    saved_path: Option<PathBuf>,
    vanilla_path: Option<PathBuf>,
}

#[derive(Deserialize)]
struct VersionManifest {
    versions: Vec<ManifestVersion>,
}

#[derive(Deserialize)]
struct ManifestVersion {
    id: String,
    url: String,
}

#[derive(Deserialize)]
struct VersionDetails {
    downloads: VersionDownloads,
}

#[derive(Deserialize)]
struct VersionDownloads {
    client: VersionDownload,
}

#[derive(Deserialize)]
struct VersionDownload {
    url: String,
}

struct ZipEntry {
    name: String,
    crc32: u32,
    size: u32,
    local_header_offset: u32,
}

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_TEXTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROJECT_ICON_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROJECT_DESCRIPTION_CHARS: usize = 160;
const ZIP_DOS_DATE_1980_01_01: u16 = 33;
const ASSET_CATALOG: &[CatalogAsset] = &[
    CatalogAsset {
        kind: AssetKind::Block,
        name: "stone",
        display_name: "Stone",
        description: "The default overworld stone block texture.",
    },
    CatalogAsset {
        kind: AssetKind::Block,
        name: "dirt",
        display_name: "Dirt",
        description: "A common earthy block used across terrain.",
    },
    CatalogAsset {
        kind: AssetKind::Block,
        name: "grass_block_top",
        display_name: "Grass Block Top",
        description: "The top face of an overworld grass block.",
    },
    CatalogAsset {
        kind: AssetKind::Block,
        name: "grass_block_side",
        display_name: "Grass Block Side",
        description: "The side face used by grass blocks.",
    },
    CatalogAsset {
        kind: AssetKind::Block,
        name: "diamond_block",
        display_name: "Diamond Block",
        description: "The solid diamond storage block texture.",
    },
    CatalogAsset {
        kind: AssetKind::Block,
        name: "oak_planks",
        display_name: "Oak Planks",
        description: "A warm wooden plank block texture.",
    },
    CatalogAsset {
        kind: AssetKind::Block,
        name: "cobblestone",
        display_name: "Cobblestone",
        description: "The rough stone block texture.",
    },
    CatalogAsset {
        kind: AssetKind::Block,
        name: "diamond_ore",
        display_name: "Diamond Ore",
        description: "Stone with embedded diamond ore details.",
    },
    CatalogAsset {
        kind: AssetKind::Item,
        name: "diamond_sword",
        display_name: "Diamond Sword",
        description: "The classic diamond sword item sprite.",
    },
    CatalogAsset {
        kind: AssetKind::Item,
        name: "iron_pickaxe",
        display_name: "Iron Pickaxe",
        description: "A durable pickaxe item sprite.",
    },
    CatalogAsset {
        kind: AssetKind::Item,
        name: "apple",
        display_name: "Apple",
        description: "A simple food item sprite.",
    },
    CatalogAsset {
        kind: AssetKind::Item,
        name: "bow",
        display_name: "Bow",
        description: "The base bow item sprite.",
    },
    CatalogAsset {
        kind: AssetKind::Item,
        name: "bucket",
        display_name: "Bucket",
        description: "The empty bucket item sprite.",
    },
    CatalogAsset {
        kind: AssetKind::Item,
        name: "ender_pearl",
        display_name: "Ender Pearl",
        description: "The throwable ender pearl sprite.",
    },
    CatalogAsset {
        kind: AssetKind::Entity,
        name: "creeper/creeper",
        display_name: "Creeper",
        description: "The creeper entity texture sheet.",
    },
    CatalogAsset {
        kind: AssetKind::Entity,
        name: "zombie/zombie",
        display_name: "Zombie",
        description: "The zombie entity texture sheet.",
    },
    CatalogAsset {
        kind: AssetKind::Entity,
        name: "skeleton/skeleton",
        display_name: "Skeleton",
        description: "The skeleton entity texture sheet.",
    },
    CatalogAsset {
        kind: AssetKind::Entity,
        name: "enderman/enderman",
        display_name: "Enderman",
        description: "The enderman entity texture sheet.",
    },
];

#[tauri::command]
fn list_assets(app: AppHandle, project_id: String) -> Result<Vec<AssetMetadata>, String> {
    let texture_root = texture_root(&app, &project_id)?;

    ASSET_CATALOG
        .iter()
        .map(|asset| {
            let id = format!("{}/{}", asset.kind.as_path(), asset.name);
            let path = asset_png_path(&texture_root, asset.kind, asset.name);
            let saved = path.is_file();

            Ok(AssetMetadata {
                id,
                kind: asset.kind,
                name: asset.name.to_string(),
                display_name: asset.display_name.to_string(),
                description: asset.description.to_string(),
                saved,
                texture_path: Some(format!("{}/{}.png", asset.kind.as_path(), asset.name)),
                preview_path: saved.then(|| path.to_string_lossy().into_owned()),
            })
        })
        .collect()
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<Vec<TextureProject>, String> {
    let mut projects = read_projects(&app)?;
    projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(projects)
}

#[tauri::command]
fn get_project(app: AppHandle, id: String) -> Result<TextureProject, String> {
    let clean_id = sanitize_project_id(&id)?;
    read_projects(&app)?
        .into_iter()
        .find(|project| project.id == clean_id)
        .ok_or_else(|| "Project was not found.".to_string())
}

#[tauri::command]
fn save_project(
    app: AppHandle,
    id: Option<String>,
    name: String,
    minecraft_version: String,
    pack_version: String,
    author: String,
    description: String,
    icon_base64: String,
) -> Result<TextureProject, String> {
    let name = sanitize_project_name(&name)?;
    let minecraft_version = sanitize_minecraft_version(
        option_text(&minecraft_version)
            .as_deref()
            .unwrap_or("1.21.6"),
    )?;
    let pack_version = option_text(&pack_version).unwrap_or_else(|| "1.0".to_string());
    let author = option_text(&author).unwrap_or_else(|| "Me!".to_string());
    let description = description
        .chars()
        .take(MAX_PROJECT_DESCRIPTION_CHARS)
        .collect();
    let icon_base64 = sanitize_project_icon(&icon_base64)?;
    let now = current_timestamp();
    let mut projects = read_projects(&app)?;

    let project = if let Some(existing_id) = id.and_then(|value| option_text(&value)) {
        let clean_id = sanitize_project_id(&existing_id)?;

        if let Some(existing) = projects.iter_mut().find(|project| project.id == clean_id) {
            existing.name = name;
            existing.minecraft_version = minecraft_version;
            existing.pack_version = pack_version;
            existing.author = author;
            existing.description = description;
            existing.icon_base64 = icon_base64;
            existing.updated_at = now;
            existing.clone()
        } else {
            let project = TextureProject {
                id: clean_id,
                name,
                minecraft_version,
                pack_version,
                author,
                description,
                icon_base64,
                created_at: now,
                updated_at: now,
            };
            projects.push(project.clone());
            project
        }
    } else {
        let project = TextureProject {
            id: create_project_id(&name, now, &projects),
            name,
            minecraft_version,
            pack_version,
            author,
            description,
            icon_base64,
            created_at: now,
            updated_at: now,
        };
        projects.push(project.clone());
        project
    };

    write_projects(&app, &projects)?;
    Ok(project)
}

#[tauri::command]
async fn cache_vanilla_textures(
    app: AppHandle,
    project_id: String,
    version: String,
) -> Result<Vec<AssetMetadata>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cache_vanilla_textures_inner(app, project_id, version)
    })
    .await
    .map_err(|err| format!("Texture cache worker failed: {err}"))?
}

fn cache_vanilla_textures_inner(
    app: AppHandle,
    project_id: String,
    version: String,
) -> Result<Vec<AssetMetadata>, String> {
    let clean_version = sanitize_minecraft_version(&version)?;
    let jar_path = cached_client_jar_path(&app, &clean_version)?;

    emit_cache_progress(
        &app,
        0.02,
        "Preparing",
        format!("Preparing Minecraft {clean_version} textures."),
        0,
        0,
    );

    if !jar_path.is_file() {
        download_client_jar(&app, &clean_version, &jar_path)?;
    } else {
        emit_cache_progress(
            &app,
            0.55,
            "Using cache",
            "Client jar already exists. Checking extracted textures.",
            1,
            1,
        );
    }

    extract_vanilla_textures(&app, &clean_version, &jar_path)?;
    emit_cache_progress(&app, 0.96, "Indexing", "Building the texture list.", 0, 0);
    let assets = list_assets_for_version(&app, &project_id, &clean_version)?;
    emit_cache_progress(
        &app,
        1.0,
        "Textures ready",
        format!("Loaded {} textures.", assets.len()),
        assets.len(),
        assets.len(),
    );
    Ok(assets)
}

#[tauri::command]
fn save_texture(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    png_base64: String,
) -> Result<SavedTexture, String> {
    let asset = parse_asset_id(&asset_id)?;
    let png = decode_png_base64(&png_base64)?;

    if png.len() > MAX_TEXTURE_BYTES {
        return Err("Texture PNG is too large. Maximum size is 16 MiB.".to_string());
    }

    if !png.starts_with(PNG_SIGNATURE) {
        return Err("Texture data must be a PNG image.".to_string());
    }

    let path = texture_path(&app, &project_id, &asset)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Failed to create texture dir: {err}"))?;
    }
    fs::write(&path, &png).map_err(|err| format!("Failed to save texture: {err}"))?;

    Ok(SavedTexture {
        asset_id: format!("{}/{}", asset.kind.as_path(), asset.name),
        path: path.to_string_lossy().into_owned(),
        bytes: png.len(),
    })
}

#[tauri::command]
fn load_texture(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    version: String,
) -> Result<LoadedTexture, String> {
    let asset = parse_asset_id(&asset_id)?;
    let clean_version = sanitize_minecraft_version(&version)?;
    let saved_path = texture_path(&app, &project_id, &asset)?;
    let vanilla_path = asset_png_path(
        &vanilla_texture_root(&app, &clean_version)?,
        asset.kind,
        &asset.name,
    );
    let path = if saved_path.is_file() {
        saved_path
    } else if vanilla_path.is_file() {
        vanilla_path
    } else {
        return Err(format!("Texture {asset_id} has not been cached yet."));
    };
    let bytes = fs::read(&path).map_err(|err| format!("Failed to read texture: {err}"))?;

    Ok(LoadedTexture {
        asset_id: format!("{}/{}", asset.kind.as_path(), asset.name),
        png_base64: encode_base64(&bytes),
    })
}

#[tauri::command]
async fn export_pack(
    app: AppHandle,
    project_id: String,
    version: String,
    pack_version: String,
    name: String,
    author: String,
    description: String,
    icon_base64: String,
) -> Result<ExportedPack, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pack_format = pack_format_for_version(&version)?;
        let safe_name = sanitize_pack_name(&name)?;
        let default_file_name = format!(
            "{}-{}.zip",
            safe_name,
            sanitize_pack_version_for_file(&pack_version)
        );
        let Some(mut zip_path) = app
            .dialog()
            .file()
            .set_title("Export resource pack")
            .set_file_name(default_file_name)
            .add_filter("Minecraft resource pack", &["zip"])
            .blocking_save_file()
            .and_then(|path| path.into_path().ok())
        else {
            return Err("Export cancelled.".to_string());
        };

        if zip_path
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("zip")
        {
            zip_path.set_extension("zip");
        }

        let mut writer = StoreZipWriter::create(&zip_path)?;
        let preview_description = format!(
            "{}\n{} ° {}",
            description.trim(),
            author.trim(),
            pack_version.trim()
        );
        let pack_mcmeta = serde_json::json!({
            "pack": {
                "pack_format": pack_format,
                "description": preview_description.trim()
            }
        });
        let pack_mcmeta = serde_json::to_vec_pretty(&pack_mcmeta)
            .map_err(|err| format!("Failed to serialize pack.mcmeta: {err}"))?;

        writer.add_file("pack.mcmeta", &pack_mcmeta)?;

        if !icon_base64.trim().is_empty() {
            let icon = decode_png_base64(&icon_base64)?;

            if !icon.starts_with(PNG_SIGNATURE) {
                return Err("Pack icon must be a PNG image.".to_string());
            }

            writer.add_file("pack.png", &icon)?;
        }

        let textures = collect_saved_textures(&app, &project_id)?;
        for texture in &textures {
            let bytes = fs::read(&texture.source)
                .map_err(|err| format!("Failed to read texture: {err}"))?;
            writer.add_file(&texture.zip_name, &bytes)?;
        }

        writer.finish()?;

        Ok(ExportedPack {
            path: zip_path.to_string_lossy().into_owned(),
            texture_count: textures.len(),
            pack_format,
        })
    })
    .await
    .map_err(|err| format!("Export worker failed: {err}"))?
}

#[tauri::command]
fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    let clean_id = sanitize_project_id(&id)?;

    // Remove the project entry from the store.
    let projects = read_projects(&app)?
        .into_iter()
        .filter(|project| project.id != clean_id)
        .collect::<Vec<_>>();
    write_projects(&app, &projects)?;

    // Delete the whole on-disk project directory (textures + anything else), if present.
    let project_dir = app_data_root(&app)?.join("projects").join(&clean_id);
    if project_dir.exists() {
        fs::remove_dir_all(&project_dir)
            .map_err(|err| format!("Failed to delete project files: {err}"))?;
    }

    Ok(())
}

#[tauri::command]
fn clear_project_textures(app: AppHandle, id: String) -> Result<(), String> {
    let textures_dir = texture_root(&app, &id)?; // already sanitizes the id internally
    if textures_dir.exists() {
        fs::remove_dir_all(&textures_dir)
            .map_err(|err| format!("Failed to clear project textures: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("Only http(s) links can be opened.".to_string());
    }

    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();

    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();

    spawned
        .map(|_| ())
        .map_err(|err| format!("Failed to open link: {err}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_projects,
            get_project,
            save_project,
            list_assets,
            cache_vanilla_textures,
            load_texture,
            save_texture,
            export_pack,
            delete_project,
            clear_project_textures,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data directory: {err}"))
}

fn projects_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?.join("projects.json"))
}

fn read_projects(app: &AppHandle) -> Result<Vec<TextureProject>, String> {
    let path = projects_store_path(app)?;

    if !path.is_file() {
        return Ok(Vec::new());
    }

    let contents =
        fs::read_to_string(&path).map_err(|err| format!("Failed to read project store: {err}"))?;

    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }

    serde_json::from_str(&contents).map_err(|err| format!("Failed to parse project store: {err}"))
}

fn write_projects(app: &AppHandle, projects: &[TextureProject]) -> Result<(), String> {
    let path = projects_store_path(app)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Failed to create project dir: {err}"))?;
    }

    let contents = serde_json::to_string_pretty(projects)
        .map_err(|err| format!("Failed to serialize project store: {err}"))?;
    fs::write(path, contents).map_err(|err| format!("Failed to write project store: {err}"))
}

fn sanitize_project_name(name: &str) -> Result<String, String> {
    let name = name.trim();

    if name.is_empty() {
        return Err("Project name is required.".to_string());
    }

    Ok(name.chars().take(32).collect())
}

fn sanitize_project_id(id: &str) -> Result<String, String> {
    let id = id.trim();

    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Project id is invalid.".to_string());
    }

    Ok(id.to_string())
}

fn sanitize_project_icon(icon_base64: &str) -> Result<String, String> {
    let icon_base64 = icon_base64.trim();

    if icon_base64.len() > MAX_PROJECT_ICON_BYTES {
        return Err("Project icon is too large.".to_string());
    }

    Ok(icon_base64.to_string())
}

fn create_project_id(name: &str, timestamp: u64, projects: &[TextureProject]) -> String {
    let mut slug = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }

    let slug = slug.trim_matches('-');
    let base = if slug.is_empty() { "project" } else { slug };
    let mut id = format!("{base}-{timestamp}");
    let mut suffix = 2usize;

    while projects.iter().any(|project| project.id == id) {
        id = format!("{base}-{timestamp}-{suffix}");
        suffix += 1;
    }

    id
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn option_text(value: &str) -> Option<String> {
    let value = value.trim();

    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn emit_cache_progress(
    app: &AppHandle,
    progress: f32,
    stage: impl Into<String>,
    message: impl Into<String>,
    current: usize,
    total: usize,
) {
    let _ = app.emit(
        "texture-cache-progress",
        TextureCacheProgress {
            progress: progress.clamp(0.0, 1.0),
            stage: stage.into(),
            message: message.into(),
            current,
            total,
        },
    );
}

fn texture_root(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let clean_id = sanitize_project_id(project_id)?;
    Ok(app_data_root(app)?
        .join("projects")
        .join(clean_id)
        .join("textures"))
}

fn vanilla_texture_root(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?
        .join("vanilla")
        .join(version)
        .join("textures"))
}

fn cached_client_jar_path(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?
        .join("vanilla")
        .join(version)
        .join("client.jar"))
}

fn texture_path(
    app: &AppHandle,
    project_id: &str,
    asset: &ParsedAssetId,
) -> Result<PathBuf, String> {
    Ok(asset_png_path(
        &texture_root(app, project_id)?,
        asset.kind,
        &asset.name,
    ))
}

fn list_assets_for_version(
    app: &AppHandle,
    project_id: &str,
    version: &str,
) -> Result<Vec<AssetMetadata>, String> {
    let texture_root = texture_root(app, project_id)?;
    let vanilla_root = vanilla_texture_root(app, version)?;
    let mut assets = BTreeMap::<String, DynamicAsset>::new();

    collect_dynamic_assets(&mut assets, &vanilla_root, false)?;
    collect_dynamic_assets(&mut assets, &texture_root, true)?;

    if assets.is_empty() {
        return list_assets(app.clone(), project_id.to_string());
    }

    Ok(assets
        .into_iter()
        .map(|(id, asset)| {
            let saved = asset.saved_path.is_some();
            let preview_path = asset
                .saved_path
                .or(asset.vanilla_path)
                .map(|path| path.to_string_lossy().into_owned());

            AssetMetadata {
                id,
                kind: asset.kind,
                name: asset.name.clone(),
                display_name: display_name_from_asset_name(&asset.name),
                description: format!(
                    "{} texture from the selected Minecraft version.",
                    asset.kind.as_path()
                ),
                saved,
                texture_path: Some(format!("{}/{}.png", asset.kind.as_path(), asset.name)),
                preview_path,
            }
        })
        .collect())
}

fn collect_dynamic_assets(
    assets: &mut BTreeMap<String, DynamicAsset>,
    texture_root: &Path,
    saved: bool,
) -> Result<(), String> {
    for kind in [
        AssetKind::Block,
        AssetKind::Item,
        AssetKind::Entity,
        AssetKind::Other,
    ] {
        let dir = texture_root.join(kind.as_path());

        if !dir.is_dir() {
            continue;
        }

        collect_dynamic_assets_in_dir(assets, &dir, &dir, kind, saved)?;
    }

    Ok(())
}

fn collect_dynamic_assets_in_dir(
    assets: &mut BTreeMap<String, DynamicAsset>,
    root: &Path,
    dir: &Path,
    kind: AssetKind,
    saved: bool,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read texture dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read texture entry: {err}"))?;
        let path = entry.path();

        if path.is_dir() {
            collect_dynamic_assets_in_dir(assets, root, &path, kind, saved)?;
            continue;
        }

        if path.extension().and_then(|extension| extension.to_str()) != Some("png") {
            continue;
        }

        let Some(relative) = path.strip_prefix(root).ok().and_then(|path| {
            path.with_extension("")
                .to_str()
                .map(|name| name.replace('\\', "/"))
        }) else {
            continue;
        };

        if !is_valid_asset_name(&relative) {
            continue;
        }

        let id = format!("{}/{}", kind.as_path(), relative);
        let asset = assets.entry(id).or_insert_with(|| DynamicAsset {
            kind,
            name: relative.clone(),
            saved_path: None,
            vanilla_path: None,
        });

        if saved {
            asset.saved_path = Some(path);
        } else {
            asset.vanilla_path = Some(path);
        }
    }

    Ok(())
}

fn display_name_from_asset_name(name: &str) -> String {
    let leaf = name.rsplit('/').next().unwrap_or(name);
    let display = leaf
        .split(['_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    if display.is_empty() {
        name.to_string()
    } else {
        display
    }
}

fn sanitize_minecraft_version(version: &str) -> Result<String, String> {
    let version = version.trim();

    if version.is_empty()
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("Minecraft version must look like 1.16.5.".to_string());
    }

    Ok(version.to_string())
}

fn download_client_jar(app: &AppHandle, version: &str, jar_path: &Path) -> Result<(), String> {
    const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

    emit_cache_progress(
        app,
        0.06,
        "Manifest",
        "Fetching Mojang's version manifest.",
        0,
        0,
    );
    let manifest: VersionManifest = ureq::get(MANIFEST_URL)
        .call()
        .map_err(|err| format!("Failed to fetch Minecraft version manifest: {err}"))?
        .into_json()
        .map_err(|err| format!("Failed to parse Minecraft version manifest: {err}"))?;
    let Some(version_entry) = manifest
        .versions
        .into_iter()
        .find(|entry| entry.id == version)
    else {
        return Err(format!(
            "Minecraft version {version} was not found in Mojang's manifest."
        ));
    };
    emit_cache_progress(
        app,
        0.12,
        "Manifest",
        format!("Fetching Minecraft {version} download metadata."),
        0,
        0,
    );
    let details: VersionDetails = ureq::get(&version_entry.url)
        .call()
        .map_err(|err| format!("Failed to fetch Minecraft version details: {err}"))?
        .into_json()
        .map_err(|err| format!("Failed to parse Minecraft version details: {err}"))?;
    emit_cache_progress(
        app,
        0.18,
        "Download",
        "Downloading the vanilla client jar.",
        0,
        0,
    );
    let response = ureq::get(&details.downloads.client.url)
        .call()
        .map_err(|err| format!("Failed to download Minecraft client jar: {err}"))?;
    let total_bytes = response
        .header("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut bytes = Vec::new();
    let mut reader = response.into_reader();
    let mut buffer = [0u8; 64 * 1024];
    let mut downloaded = 0usize;

    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|err| format!("Failed to read Minecraft client jar: {err}"))?;

        if count == 0 {
            break;
        }

        bytes.extend_from_slice(&buffer[..count]);
        downloaded += count;

        if total_bytes > 0 {
            let ratio = downloaded as f32 / total_bytes as f32;
            emit_cache_progress(
                app,
                0.18 + ratio * 0.34,
                "Download",
                format!(
                    "Downloading client jar: {} / {} MB.",
                    downloaded / 1_048_576,
                    total_bytes / 1_048_576
                ),
                downloaded,
                total_bytes,
            );
        } else if downloaded % (1024 * 1024) < count {
            emit_cache_progress(
                app,
                0.32,
                "Download",
                format!("Downloading client jar: {} MB.", downloaded / 1_048_576),
                downloaded,
                total_bytes,
            );
        }
    }

    if let Some(parent) = jar_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create Minecraft cache dir: {err}"))?;
    }

    emit_cache_progress(
        app,
        0.54,
        "Download",
        "Caching the client jar.",
        downloaded,
        total_bytes,
    );
    fs::write(jar_path, bytes).map_err(|err| format!("Failed to cache Minecraft client jar: {err}"))
}

fn extract_vanilla_textures(app: &AppHandle, version: &str, jar_path: &Path) -> Result<(), String> {
    let bytes =
        fs::read(jar_path).map_err(|err| format!("Failed to read cached client jar: {err}"))?;
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|err| format!("Failed to open Minecraft client jar: {err}"))?;
    let vanilla_root = vanilla_texture_root(app, version)?;
    let total = archive.len();
    let mut extracted = 0usize;

    emit_cache_progress(
        app,
        0.56,
        "Extracting",
        "Extracting vanilla block, item, and entity textures.",
        0,
        total,
    );

    for index in 0..total {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("Failed to inspect Minecraft client jar: {err}"))?;
        let jar_name = file.name().to_string();

        if !jar_name.starts_with("assets/minecraft/textures/") || !jar_name.ends_with(".png") {
            continue;
        }

        let relative = jar_name
            .trim_start_matches("assets/minecraft/textures/")
            .trim_end_matches(".png");
        let mut parts = relative.split('/');
        let Some(kind_part) = parts.next() else {
            continue;
        };
        let (kind, name) = match kind_part {
            "block" => (AssetKind::Block, parts.collect::<Vec<_>>().join("/")),
            "item" => (AssetKind::Item, parts.collect::<Vec<_>>().join("/")),
            "entity" => (AssetKind::Entity, parts.collect::<Vec<_>>().join("/")),
            _ => (AssetKind::Other, relative.to_string()),
        };

        if !is_valid_asset_name(&name) {
            continue;
        }

        let path = asset_png_path(&vanilla_root, kind, &name);

        if path.is_file() {
            continue;
        }

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create vanilla texture dir: {err}"))?;
        }

        let mut output = fs::File::create(&path)
            .map_err(|err| format!("Failed to cache vanilla texture: {err}"))?;
        std::io::copy(&mut file, &mut output)
            .map_err(|err| format!("Failed to extract vanilla texture: {err}"))?;
        extracted += 1;

        if index % 64 == 0 {
            emit_cache_progress(
                app,
                0.56 + (index as f32 / total.max(1) as f32) * 0.38,
                "Extracting",
                format!("Extracted {extracted} textures."),
                index,
                total,
            );
        }
    }

    emit_cache_progress(
        app,
        0.94,
        "Extracting",
        format!("Extracted {extracted} textures."),
        total,
        total,
    );

    Ok(())
}

fn parse_asset_id(asset_id: &str) -> Result<ParsedAssetId, String> {
    let normalized = asset_id
        .trim()
        .strip_prefix("minecraft:")
        .unwrap_or_else(|| asset_id.trim());
    let mut parts = normalized.split('/');
    let kind = match parts.next() {
        Some("block") | Some("blocks") => AssetKind::Block,
        Some("item") | Some("items") => AssetKind::Item,
        Some("entity") | Some("entities") => AssetKind::Entity,
        Some("other") | Some("others") => AssetKind::Other,
        _ => return Err("Asset id must start with block/, item/, or entity/.".to_string()),
    };
    let name = parts.collect::<Vec<_>>().join("/");
    if name.is_empty() {
        return Err("Asset id must include a texture name.".to_string());
    }
    if !is_valid_asset_name(&name) {
        return Err(
            "Asset name may only contain lowercase letters, numbers, underscores, hyphens, and slashes."
                .to_string(),
        );
    }

    Ok(ParsedAssetId { kind, name })
}

fn is_valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'/')
        })
        && !name.contains("//")
        && !name.starts_with('/')
        && !name.ends_with('/')
}

fn asset_png_path(root: &Path, kind: AssetKind, name: &str) -> PathBuf {
    name.split('/')
        .fold(root.join(kind.as_path()), |path, part| path.join(part))
        .with_extension("png")
}

fn decode_png_base64(input: &str) -> Result<Vec<u8>, String> {
    let payload = input
        .split_once(',')
        .filter(|(prefix, _)| prefix.contains(";base64"))
        .map(|(_, payload)| payload)
        .unwrap_or(input);
    decode_base64(payload)
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);

        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);

        if chunk.len() > 1 {
            output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }

        if chunk.len() > 2 {
            output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }

    output
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut chunk = [0u8; 4];
    let mut chunk_len = 0;
    let mut saw_padding = false;

    for byte in input.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                saw_padding = true;
                64
            }
            _ => return Err("Texture data is not valid base64.".to_string()),
        };

        if saw_padding && value != 64 {
            return Err("Texture data has invalid base64 padding.".to_string());
        }

        chunk[chunk_len] = value;
        chunk_len += 1;

        if chunk_len == 4 {
            push_base64_chunk(&chunk, &mut output)?;
            chunk_len = 0;
        }
    }

    match chunk_len {
        0 => Ok(output),
        2 => {
            if saw_padding {
                return Err("Texture data has invalid base64 padding.".to_string());
            }
            output.push((chunk[0] << 2) | (chunk[1] >> 4));
            Ok(output)
        }
        3 => {
            if saw_padding {
                return Err("Texture data has invalid base64 padding.".to_string());
            }
            output.push((chunk[0] << 2) | (chunk[1] >> 4));
            output.push((chunk[1] << 4) | (chunk[2] >> 2));
            Ok(output)
        }
        _ => Err("Texture data has invalid base64 length.".to_string()),
    }
}

fn push_base64_chunk(chunk: &[u8; 4], output: &mut Vec<u8>) -> Result<(), String> {
    if chunk[0] == 64 || chunk[1] == 64 {
        return Err("Texture data has invalid base64 padding.".to_string());
    }

    output.push((chunk[0] << 2) | (chunk[1] >> 4));
    if chunk[2] != 64 {
        output.push((chunk[1] << 4) | (chunk[2] >> 2));
    }
    if chunk[3] != 64 {
        output.push((chunk[2] << 6) | chunk[3]);
    }
    Ok(())
}

fn sanitize_pack_name(name: &str) -> Result<String, String> {
    let sanitized = name
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character.to_ascii_lowercase()
            } else if character.is_whitespace() {
                '-'
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    if sanitized.is_empty() {
        Err("Pack name is required.".to_string())
    } else {
        Ok(sanitized)
    }
}

fn sanitize_pack_version_for_file(version: &str) -> String {
    let sanitized = version
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    if sanitized.is_empty() {
        "1.0".to_string()
    } else {
        sanitized
    }
}

fn pack_format_for_version(version: &str) -> Result<u32, String> {
    let parts = version
        .trim()
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Minecraft version must look like 1.16.5.".to_string())?;

    if parts.len() < 2 {
        return Err("Minecraft version must look like 1.16.5 or 26.1.2.".to_string());
    }

    if parts[0] >= 22 {
        return Ok(63);
    }

    if parts[0] != 1 {
        return Err("Only Java Edition 1.x or calendar-style versions are supported.".to_string());
    }

    let minor = parts[1];
    let patch = parts.get(2).copied().unwrap_or(0);
    let format = match minor {
        0..=8 => 1,
        9..=10 => 2,
        11..=12 => 3,
        13..=14 => 4,
        15 => 5,
        16 if patch <= 1 => 5,
        16 => 6,
        17 => 7,
        18 => 8,
        19 if patch <= 2 => 9,
        19 if patch == 3 => 12,
        19 => 13,
        20 if patch <= 1 => 15,
        20 if patch == 2 => 18,
        20 if patch <= 4 => 22,
        20 => 32,
        21 if patch <= 1 => 34,
        21 if patch <= 3 => 42,
        21 if patch == 4 => 46,
        21 if patch == 5 => 55,
        21 => 63,
        22.. => 63,
    };

    Ok(format)
}

struct SavedTextureForExport {
    source: PathBuf,
    zip_name: String,
}

fn collect_saved_textures(
    app: &AppHandle,
    project_id: &str,
) -> Result<Vec<SavedTextureForExport>, String> {
    let root = texture_root(app, project_id)?;
    let mut textures = Vec::new();

    for kind in [
        AssetKind::Block,
        AssetKind::Item,
        AssetKind::Entity,
        AssetKind::Other,
    ] {
        let dir = root.join(kind.as_path());
        if !dir.is_dir() {
            continue;
        }

        collect_saved_textures_in_dir(&dir, &dir, kind, &mut textures)?;
    }

    Ok(textures)
}

fn collect_saved_textures_in_dir(
    root: &Path,
    dir: &Path,
    kind: AssetKind,
    textures: &mut Vec<SavedTextureForExport>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read textures: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read texture entry: {err}"))?;
        let path = entry.path();

        if path.is_dir() {
            collect_saved_textures_in_dir(root, &path, kind, textures)?;
            continue;
        }

        if path.extension().and_then(|extension| extension.to_str()) != Some("png") {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .map_err(|err| format!("Failed to resolve texture path: {err}"))?
            .to_string_lossy()
            .replace('\\', "/");

        let zip_name = match kind {
            AssetKind::Other => format!("assets/minecraft/textures/{}", relative),
            _ => format!("assets/minecraft/textures/{}/{}", kind.as_path(), relative),
        };

        textures.push(SavedTextureForExport {
            source: path,
            zip_name,
        });
    }

    Ok(())
}

struct StoreZipWriter {
    file: fs::File,
    entries: Vec<ZipEntry>,
}

impl StoreZipWriter {
    fn create(path: &Path) -> Result<Self, String> {
        let file = fs::File::create(path).map_err(|err| format!("Failed to create zip: {err}"))?;
        Ok(Self {
            file,
            entries: Vec::new(),
        })
    }

    fn add_file(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let size = u32::try_from(bytes.len()).map_err(|_| "Zip entry is too large.".to_string())?;
        let name_bytes = name.as_bytes();
        let name_len = u16::try_from(name_bytes.len())
            .map_err(|_| "Zip entry name is too long.".to_string())?;
        let offset = u32::try_from(
            self.file
                .stream_position()
                .map_err(|err| format!("Failed to write zip: {err}"))?,
        )
        .map_err(|_| "Zip file is too large.".to_string())?;
        let crc32 = crc32(bytes);

        write_u32(&mut self.file, 0x0403_4b50)?;
        write_u16(&mut self.file, 20)?;
        write_u16(&mut self.file, 0)?;
        write_u16(&mut self.file, 0)?;
        write_u16(&mut self.file, 0)?;
        write_u16(&mut self.file, ZIP_DOS_DATE_1980_01_01)?;
        write_u32(&mut self.file, crc32)?;
        write_u32(&mut self.file, size)?;
        write_u32(&mut self.file, size)?;
        write_u16(&mut self.file, name_len)?;
        write_u16(&mut self.file, 0)?;
        self.file
            .write_all(name_bytes)
            .map_err(|err| format!("Failed to write zip: {err}"))?;
        self.file
            .write_all(bytes)
            .map_err(|err| format!("Failed to write zip: {err}"))?;

        self.entries.push(ZipEntry {
            name: name.to_string(),
            crc32,
            size,
            local_header_offset: offset,
        });
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        let central_directory_offset = u32::try_from(
            self.file
                .stream_position()
                .map_err(|err| format!("Failed to write zip: {err}"))?,
        )
        .map_err(|_| "Zip file is too large.".to_string())?;

        for entry in &self.entries {
            let name_bytes = entry.name.as_bytes();
            let name_len = u16::try_from(name_bytes.len())
                .map_err(|_| "Zip entry name is too long.".to_string())?;

            write_u32(&mut self.file, 0x0201_4b50)?;
            write_u16(&mut self.file, 20)?;
            write_u16(&mut self.file, 20)?;
            write_u16(&mut self.file, 0)?;
            write_u16(&mut self.file, 0)?;
            write_u16(&mut self.file, 0)?;
            write_u16(&mut self.file, ZIP_DOS_DATE_1980_01_01)?;
            write_u32(&mut self.file, entry.crc32)?;
            write_u32(&mut self.file, entry.size)?;
            write_u32(&mut self.file, entry.size)?;
            write_u16(&mut self.file, name_len)?;
            write_u16(&mut self.file, 0)?;
            write_u16(&mut self.file, 0)?;
            write_u16(&mut self.file, 0)?;
            write_u16(&mut self.file, 0)?;
            write_u32(&mut self.file, 0)?;
            write_u32(&mut self.file, entry.local_header_offset)?;
            self.file
                .write_all(name_bytes)
                .map_err(|err| format!("Failed to write zip: {err}"))?;
        }

        let central_directory_size = u32::try_from(
            self.file
                .stream_position()
                .map_err(|err| format!("Failed to write zip: {err}"))?
                - u64::from(central_directory_offset),
        )
        .map_err(|_| "Zip file is too large.".to_string())?;
        let entry_count = u16::try_from(self.entries.len())
            .map_err(|_| "Too many files for this zip writer.".to_string())?;

        write_u32(&mut self.file, 0x0605_4b50)?;
        write_u16(&mut self.file, 0)?;
        write_u16(&mut self.file, 0)?;
        write_u16(&mut self.file, entry_count)?;
        write_u16(&mut self.file, entry_count)?;
        write_u32(&mut self.file, central_directory_size)?;
        write_u32(&mut self.file, central_directory_offset)?;
        write_u16(&mut self.file, 0)?;
        self.file
            .flush()
            .map_err(|err| format!("Failed to finish zip: {err}"))
    }
}

fn write_u16(writer: &mut impl Write, value: u16) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|err| format!("Failed to write zip: {err}"))
}

fn write_u32(writer: &mut impl Write, value: u32) -> Result<(), String> {
    writer
        .write_all(&value.to_le_bytes())
        .map_err(|err| format!("Failed to write zip: {err}"))
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}
