use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Cursor, Read, Seek, Write},
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiProviderConfig {
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureAiAssetContext {
    id: String,
    name: String,
    texture_path: String,
    edited: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureAiImageContext {
    name: String,
    mime_type: String,
    data_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureAiRequest {
    prompt: String,
    project_name: String,
    grid_size: usize,
    selected_asset_id: Option<String>,
    selected_asset_name: Option<String>,
    /// A few example assets (across kinds) so the model learns the id format. It
    /// is NOT the list to choose from — the model must filter/search instead.
    assets: Vec<TextureAiAssetContext>,
    /// Total number of textures in the project.
    #[serde(default)]
    total_assets: Option<usize>,
    /// Per-kind counts, e.g. "block ×700, item ×200" — so the model knows what
    /// categories exist without seeing the whole list.
    #[serde(default)]
    asset_summary: Option<String>,
    images: Vec<TextureAiImageContext>,
    /// Compact pixel dump of the texture currently open in the editor, if any.
    #[serde(default)]
    open_asset_pixels: Option<String>,
    /// Data the app fulfilled for the model's previous "requests" (block list,
    /// pixel dumps). Carried back so the model can act on it next round.
    #[serde(default)]
    tool_results: Option<String>,
    /// When set, raw response deltas are emitted as `ai-stream` events tagged
    /// with this id so the UI can show the model working in real time.
    #[serde(default)]
    stream_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShaderAiRequest {
    prompt: String,
    project_name: String,
    minecraft_version: String,
    /// Compact catalog of every option: id, kind, current value, bounds.
    options_doc: String,
    /// Current quick visual-builder settings (exposure, tints, effects).
    quick_settings: String,
    /// Recent conversation turns so follow-up requests have context.
    #[serde(default)]
    history: Option<String>,
    images: Vec<TextureAiImageContext>,
    /// When set, raw response deltas are emitted as `ai-stream` events tagged
    /// with this id so the UI can show the model working in real time.
    #[serde(default)]
    stream_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TextureAiResponse {
    text: String,
    /// Exact prompt (input) tokens reported by the provider, if available.
    prompt_tokens: Option<u64>,
    /// Exact total tokens (prompt + completion) reported by the provider.
    total_tokens: Option<u64>,
}

#[derive(Serialize)]
struct ExportedPack {
    path: String,
    texture_count: usize,
    pack_format: u32,
}

#[derive(Serialize)]
struct ExportedShaderPack {
    path: String,
    file_count: usize,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ProjectType {
    Texture,
    Shader,
}

impl Default for ProjectType {
    fn default() -> Self {
        Self::Texture
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextureProject {
    id: String,
    #[serde(default)]
    project_type: ProjectType,
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
#[serde(rename_all = "camelCase")]
struct ShaderFile {
    id: String,
    name: String,
    path: String,
    language: String,
    description: String,
    contents: String,
    saved: bool,
}

#[derive(Clone, Copy)]
struct ShaderTemplate {
    id: &'static str,
    name: &'static str,
    path: &'static str,
    language: &'static str,
    description: &'static str,
    contents: &'static str,
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
const MAX_SHADER_FILE_BYTES: usize = 256 * 1024;
const MAX_PROJECT_ICON_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROJECT_DESCRIPTION_CHARS: usize = 4096;
const ZIP_DOS_DATE_1980_01_01: u16 = 33;
const SHADER_TEMPLATES: &[ShaderTemplate] = &[
    ShaderTemplate {
        id: "settings",
        name: "Shader settings",
        path: "shaders.properties",
        language: "Properties",
        description: "Generated Iris menu layout. Sliders/screens reference the options in anvil_options.glsl.",
        contents: include_str!("../shaderpack/shaders/shaders.properties"),
    },
    ShaderTemplate {
        id: "block_properties",
        name: "Block mappings",
        path: "block.properties",
        language: "Properties",
        description: "Maps blocks to material flags (plants, leaves, lava, ores, water, glass, portals).",
        contents: include_str!("../shaderpack/shaders/block.properties"),
    },
    ShaderTemplate {
        id: "anvil_options",
        name: "Block options",
        path: "anvil_options.glsl",
        language: "GLSL",
        description: "Generated #defines for every visual option. The passes #include this.",
        contents: include_str!("../shaderpack/shaders/anvil_options.glsl"),
    },
    ShaderTemplate {
        id: "lang_en_us",
        name: "Menu labels",
        path: "lang/en_us.lang",
        language: "Properties",
        description: "Generated readable names for the in-game shader option menu.",
        contents: include_str!("../shaderpack/shaders/lang/en_us.lang"),
    },
    ShaderTemplate {
        id: "lib_common",
        name: "Shared helpers",
        path: "lib/common.glsl",
        language: "GLSL",
        description: "Noise, color, time-of-day and tonemapping helpers shared by every pass.",
        contents: include_str!("../shaderpack/shaders/lib/common.glsl"),
    },
    ShaderTemplate {
        id: "lib_terrain_vsh",
        name: "Terrain vertex body",
        path: "lib/gbuffers_terrain.vsh.glsl",
        language: "GLSL",
        description: "Terrain vertex logic: material flags and wind-driven foliage waving.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_terrain.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_terrain_fsh",
        name: "Terrain fragment body",
        path: "lib/gbuffers_terrain.fsh.glsl",
        language: "GLSL",
        description: "Terrain lighting: sun/moon/block light, foliage, wetness, relief, PBR, emissives.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_terrain.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_deferred",
        name: "Deferred pass body",
        path: "lib/deferred.fsh.glsl",
        language: "GLSL",
        description: "Shadows, AO/GI apply, water SSR/refraction, clouds, stars, aurora, fog, weather and time-of-day moods.",
        contents: include_str!("../shaderpack/shaders/lib/deferred.fsh.glsl"),
    },
    ShaderTemplate {
        id: "shadow_vsh",
        name: "Shadow vertex",
        path: "shadow.vsh",
        language: "GLSL",
        description: "Shadow map pass with the Shadow focus distortion.",
        contents: include_str!("../shaderpack/shaders/shadow.vsh"),
    },
    ShaderTemplate {
        id: "shadow_fsh",
        name: "Shadow fragment",
        path: "shadow.fsh",
        language: "GLSL",
        description: "Shadow map alpha cutout.",
        contents: include_str!("../shaderpack/shaders/shadow.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_terrain_vsh",
        name: "Terrain vertex",
        path: "gbuffers_terrain.vsh",
        language: "GLSL",
        description: "Overworld terrain vertex wrapper.",
        contents: include_str!("../shaderpack/shaders/gbuffers_terrain.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_terrain_fsh",
        name: "Terrain fragment",
        path: "gbuffers_terrain.fsh",
        language: "GLSL",
        description: "Overworld terrain fragment wrapper.",
        contents: include_str!("../shaderpack/shaders/gbuffers_terrain.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_water_vsh",
        name: "Water vertex",
        path: "gbuffers_water.vsh",
        language: "GLSL",
        description: "Translucents vertex pass: water waves and material flags.",
        contents: include_str!("../shaderpack/shaders/gbuffers_water.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_water_fsh",
        name: "Water fragment",
        path: "gbuffers_water.fsh",
        language: "GLSL",
        description: "Water tint/clarity/reflections, glass, ice and portal shimmer.",
        contents: include_str!("../shaderpack/shaders/gbuffers_water.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_skybasic_vsh",
        name: "Sky vertex",
        path: "gbuffers_skybasic.vsh",
        language: "GLSL",
        description: "Sky dome vertex pass.",
        contents: include_str!("../shaderpack/shaders/gbuffers_skybasic.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_skybasic_fsh",
        name: "Sky fragment",
        path: "gbuffers_skybasic.fsh",
        language: "GLSL",
        description: "Sky gradient driven by the Sky and Sunlight options.",
        contents: include_str!("../shaderpack/shaders/gbuffers_skybasic.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_skytextured_vsh",
        name: "Celestial vertex",
        path: "gbuffers_skytextured.vsh",
        language: "GLSL",
        description: "Sun/moon quad scaled by the Sun size option.",
        contents: include_str!("../shaderpack/shaders/gbuffers_skytextured.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_skytextured_fsh",
        name: "Celestial fragment",
        path: "gbuffers_skytextured.fsh",
        language: "GLSL",
        description: "Sun/moon appearance: celestial style, glow, moon brightness.",
        contents: include_str!("../shaderpack/shaders/gbuffers_skytextured.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_clouds_vsh",
        name: "Clouds vertex",
        path: "gbuffers_clouds.vsh",
        language: "GLSL",
        description: "Vanilla cloud geometry vertex pass.",
        contents: include_str!("../shaderpack/shaders/gbuffers_clouds.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_clouds_fsh",
        name: "Clouds fragment",
        path: "gbuffers_clouds.fsh",
        language: "GLSL",
        description: "Vanilla clouds (only for the vanilla flat style).",
        contents: include_str!("../shaderpack/shaders/gbuffers_clouds.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_weather_vsh",
        name: "Weather vertex",
        path: "gbuffers_weather.vsh",
        language: "GLSL",
        description: "Rain/snow streaks with angle shear and snow drift.",
        contents: include_str!("../shaderpack/shaders/gbuffers_weather.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_weather_fsh",
        name: "Weather fragment",
        path: "gbuffers_weather.fsh",
        language: "GLSL",
        description: "Rain opacity, streak styles, snow density and softening.",
        contents: include_str!("../shaderpack/shaders/gbuffers_weather.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_entities_vsh",
        name: "Entities vertex",
        path: "gbuffers_entities.vsh",
        language: "GLSL",
        description: "Entity vertex pass.",
        contents: include_str!("../shaderpack/shaders/gbuffers_entities.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_entities_fsh",
        name: "Entities fragment",
        path: "gbuffers_entities.fsh",
        language: "GLSL",
        description: "Entity brightness, rim light, hurt flash and eye glow.",
        contents: include_str!("../shaderpack/shaders/gbuffers_entities.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_hand_vsh",
        name: "Hand vertex",
        path: "gbuffers_hand.vsh",
        language: "GLSL",
        description: "First-person hand vertex pass.",
        contents: include_str!("../shaderpack/shaders/gbuffers_hand.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_hand_fsh",
        name: "Hand fragment",
        path: "gbuffers_hand.fsh",
        language: "GLSL",
        description: "Held item brightness and held-light glow.",
        contents: include_str!("../shaderpack/shaders/gbuffers_hand.fsh"),
    },
    ShaderTemplate {
        id: "gbuffers_textured_vsh",
        name: "Particles vertex",
        path: "gbuffers_textured.vsh",
        language: "GLSL",
        description: "Particles vertex pass.",
        contents: include_str!("../shaderpack/shaders/gbuffers_textured.vsh"),
    },
    ShaderTemplate {
        id: "gbuffers_textured_fsh",
        name: "Particles fragment",
        path: "gbuffers_textured.fsh",
        language: "GLSL",
        description: "Particle brightness, emissive boost and saturation.",
        contents: include_str!("../shaderpack/shaders/gbuffers_textured.fsh"),
    },
    ShaderTemplate {
        id: "composite_vsh",
        name: "AO/GI vertex",
        path: "composite.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/composite.vsh"),
    },
    ShaderTemplate {
        id: "composite_fsh",
        name: "AO/GI fragment",
        path: "composite.fsh",
        language: "GLSL",
        description: "Ambient occlusion and bounce-light gather into colortex2.",
        contents: include_str!("../shaderpack/shaders/composite.fsh"),
    },
    ShaderTemplate {
        id: "composite1_vsh",
        name: "Deferred vertex",
        path: "composite1.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/composite1.vsh"),
    },
    ShaderTemplate {
        id: "composite1_fsh",
        name: "Deferred fragment",
        path: "composite1.fsh",
        language: "GLSL",
        description: "Overworld deferred wrapper around lib/deferred.fsh.glsl.",
        contents: include_str!("../shaderpack/shaders/composite1.fsh"),
    },
    ShaderTemplate {
        id: "composite2_vsh",
        name: "Bloom H vertex",
        path: "composite2.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/composite2.vsh"),
    },
    ShaderTemplate {
        id: "composite2_fsh",
        name: "Bloom H fragment",
        path: "composite2.fsh",
        language: "GLSL",
        description: "Bloom threshold extraction + horizontal blur.",
        contents: include_str!("../shaderpack/shaders/composite2.fsh"),
    },
    ShaderTemplate {
        id: "composite3_vsh",
        name: "Bloom V vertex",
        path: "composite3.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/composite3.vsh"),
    },
    ShaderTemplate {
        id: "composite3_fsh",
        name: "Bloom V fragment",
        path: "composite3.fsh",
        language: "GLSL",
        description: "Bloom vertical blur with ghosting suppression.",
        contents: include_str!("../shaderpack/shaders/composite3.fsh"),
    },
    ShaderTemplate {
        id: "composite4_vsh",
        name: "Camera FX vertex",
        path: "composite4.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/composite4.vsh"),
    },
    ShaderTemplate {
        id: "composite4_fsh",
        name: "Camera FX fragment",
        path: "composite4.fsh",
        language: "GLSL",
        description: "Depth of field and motion blur.",
        contents: include_str!("../shaderpack/shaders/composite4.fsh"),
    },
    ShaderTemplate {
        id: "final_vsh",
        name: "Final vertex",
        path: "final.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/final.vsh"),
    },
    ShaderTemplate {
        id: "final_fsh",
        name: "Final fragment",
        path: "final.fsh",
        language: "GLSL",
        description: "Bloom combine, tonemap, color grade, lens effects, sharpening, debug views.",
        contents: include_str!("../shaderpack/shaders/final.fsh"),
    },
    ShaderTemplate {
        id: "nether_terrain_vsh",
        name: "Nether terrain vertex",
        path: "world-1/gbuffers_terrain.vsh",
        language: "GLSL",
        description: "Nether terrain wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_terrain.vsh"),
    },
    ShaderTemplate {
        id: "nether_terrain_fsh",
        name: "Nether terrain fragment",
        path: "world-1/gbuffers_terrain.fsh",
        language: "GLSL",
        description: "Nether terrain wrapper (soul-tinted light, nether glow).",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_terrain.fsh"),
    },
    ShaderTemplate {
        id: "nether_composite1_vsh",
        name: "Nether deferred vertex",
        path: "world-1/composite1.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world-1/composite1.vsh"),
    },
    ShaderTemplate {
        id: "nether_composite1_fsh",
        name: "Nether deferred fragment",
        path: "world-1/composite1.fsh",
        language: "GLSL",
        description: "Nether deferred wrapper (haze, air color, basalt ash).",
        contents: include_str!("../shaderpack/shaders/world-1/composite1.fsh"),
    },
    ShaderTemplate {
        id: "end_terrain_vsh",
        name: "End terrain vertex",
        path: "world1/gbuffers_terrain.vsh",
        language: "GLSL",
        description: "End terrain wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_terrain.vsh"),
    },
    ShaderTemplate {
        id: "end_terrain_fsh",
        name: "End terrain fragment",
        path: "world1/gbuffers_terrain.fsh",
        language: "GLSL",
        description: "End terrain wrapper (end-tinted light).",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_terrain.fsh"),
    },
    ShaderTemplate {
        id: "end_composite1_vsh",
        name: "End deferred vertex",
        path: "world1/composite1.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world1/composite1.vsh"),
    },
    ShaderTemplate {
        id: "end_composite1_fsh",
        name: "End deferred fragment",
        path: "world1/composite1.fsh",
        language: "GLSL",
        description: "End deferred wrapper (void tint, end fog, starfield, mood).",
        contents: include_str!("../shaderpack/shaders/world1/composite1.fsh"),
    },
    ShaderTemplate {
        id: "lib_composite_fsh",
        name: "AO + bounce gather fragment body",
        path: "lib/composite.fsh.glsl",
        language: "GLSL",
        description: "Shared ao + bounce gather fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/composite.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_composite2_fsh",
        name: "Bloom extract fragment body",
        path: "lib/composite2.fsh.glsl",
        language: "GLSL",
        description: "Shared bloom extract fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/composite2.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_composite3_fsh",
        name: "Bloom combine fragment body",
        path: "lib/composite3.fsh.glsl",
        language: "GLSL",
        description: "Shared bloom combine fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/composite3.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_composite4_fsh",
        name: "Camera effects fragment body",
        path: "lib/composite4.fsh.glsl",
        language: "GLSL",
        description: "Shared camera effects fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/composite4.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_final_fsh",
        name: "Final grade fragment body",
        path: "lib/final.fsh.glsl",
        language: "GLSL",
        description: "Shared final grade fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/final.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_water_vsh",
        name: "Translucents vertex body",
        path: "lib/gbuffers_water.vsh.glsl",
        language: "GLSL",
        description: "Shared translucents vertex logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_water.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_water_fsh",
        name: "Translucents fragment body",
        path: "lib/gbuffers_water.fsh.glsl",
        language: "GLSL",
        description: "Shared translucents fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_water.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_skybasic_vsh",
        name: "Sky gradient vertex body",
        path: "lib/gbuffers_skybasic.vsh.glsl",
        language: "GLSL",
        description: "Shared sky gradient vertex logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_skybasic.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_skybasic_fsh",
        name: "Sky gradient fragment body",
        path: "lib/gbuffers_skybasic.fsh.glsl",
        language: "GLSL",
        description: "Shared sky gradient fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_skybasic.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_skytextured_vsh",
        name: "Sun and moon vertex body",
        path: "lib/gbuffers_skytextured.vsh.glsl",
        language: "GLSL",
        description: "Shared sun and moon vertex logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_skytextured.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_skytextured_fsh",
        name: "Sun and moon fragment body",
        path: "lib/gbuffers_skytextured.fsh.glsl",
        language: "GLSL",
        description: "Shared sun and moon fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_skytextured.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_clouds_vsh",
        name: "Vanilla clouds vertex body",
        path: "lib/gbuffers_clouds.vsh.glsl",
        language: "GLSL",
        description: "Shared vanilla clouds vertex logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_clouds.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_clouds_fsh",
        name: "Vanilla clouds fragment body",
        path: "lib/gbuffers_clouds.fsh.glsl",
        language: "GLSL",
        description: "Shared vanilla clouds fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_clouds.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_weather_vsh",
        name: "Rain and snow vertex body",
        path: "lib/gbuffers_weather.vsh.glsl",
        language: "GLSL",
        description: "Shared rain and snow vertex logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_weather.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_weather_fsh",
        name: "Rain and snow fragment body",
        path: "lib/gbuffers_weather.fsh.glsl",
        language: "GLSL",
        description: "Shared rain and snow fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_weather.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_entities_vsh",
        name: "Entities vertex body",
        path: "lib/gbuffers_entities.vsh.glsl",
        language: "GLSL",
        description: "Shared entities vertex logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_entities.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_entities_fsh",
        name: "Entities fragment body",
        path: "lib/gbuffers_entities.fsh.glsl",
        language: "GLSL",
        description: "Shared entities fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_entities.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_hand_vsh",
        name: "Held items vertex body",
        path: "lib/gbuffers_hand.vsh.glsl",
        language: "GLSL",
        description: "Shared held items vertex logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_hand.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_hand_fsh",
        name: "Held items fragment body",
        path: "lib/gbuffers_hand.fsh.glsl",
        language: "GLSL",
        description: "Shared held items fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_hand.fsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_textured_vsh",
        name: "Particles vertex body",
        path: "lib/gbuffers_textured.vsh.glsl",
        language: "GLSL",
        description: "Shared particles vertex logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_textured.vsh.glsl"),
    },
    ShaderTemplate {
        id: "lib_gbuffers_textured_fsh",
        name: "Particles fragment body",
        path: "lib/gbuffers_textured.fsh.glsl",
        language: "GLSL",
        description: "Shared particles fragment logic included by the overworld, Nether, and End wrappers.",
        contents: include_str!("../shaderpack/shaders/lib/gbuffers_textured.fsh.glsl"),
    },
    ShaderTemplate {
        id: "nether_composite_vsh",
        name: "Nether ao + bounce gather vertex",
        path: "world-1/composite.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world-1/composite.vsh"),
    },
    ShaderTemplate {
        id: "end_composite_vsh",
        name: "End ao + bounce gather vertex",
        path: "world1/composite.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world1/composite.vsh"),
    },
    ShaderTemplate {
        id: "nether_composite_fsh",
        name: "Nether ao + bounce gather fragment",
        path: "world-1/composite.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/composite.fsh"),
    },
    ShaderTemplate {
        id: "end_composite_fsh",
        name: "End ao + bounce gather fragment",
        path: "world1/composite.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/composite.fsh"),
    },
    ShaderTemplate {
        id: "nether_composite2_vsh",
        name: "Nether bloom extract vertex",
        path: "world-1/composite2.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world-1/composite2.vsh"),
    },
    ShaderTemplate {
        id: "end_composite2_vsh",
        name: "End bloom extract vertex",
        path: "world1/composite2.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world1/composite2.vsh"),
    },
    ShaderTemplate {
        id: "nether_composite2_fsh",
        name: "Nether bloom extract fragment",
        path: "world-1/composite2.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/composite2.fsh"),
    },
    ShaderTemplate {
        id: "end_composite2_fsh",
        name: "End bloom extract fragment",
        path: "world1/composite2.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/composite2.fsh"),
    },
    ShaderTemplate {
        id: "nether_composite3_vsh",
        name: "Nether bloom combine vertex",
        path: "world-1/composite3.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world-1/composite3.vsh"),
    },
    ShaderTemplate {
        id: "end_composite3_vsh",
        name: "End bloom combine vertex",
        path: "world1/composite3.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world1/composite3.vsh"),
    },
    ShaderTemplate {
        id: "nether_composite3_fsh",
        name: "Nether bloom combine fragment",
        path: "world-1/composite3.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/composite3.fsh"),
    },
    ShaderTemplate {
        id: "end_composite3_fsh",
        name: "End bloom combine fragment",
        path: "world1/composite3.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/composite3.fsh"),
    },
    ShaderTemplate {
        id: "nether_composite4_vsh",
        name: "Nether camera effects vertex",
        path: "world-1/composite4.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world-1/composite4.vsh"),
    },
    ShaderTemplate {
        id: "end_composite4_vsh",
        name: "End camera effects vertex",
        path: "world1/composite4.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world1/composite4.vsh"),
    },
    ShaderTemplate {
        id: "nether_composite4_fsh",
        name: "Nether camera effects fragment",
        path: "world-1/composite4.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/composite4.fsh"),
    },
    ShaderTemplate {
        id: "end_composite4_fsh",
        name: "End camera effects fragment",
        path: "world1/composite4.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/composite4.fsh"),
    },
    ShaderTemplate {
        id: "nether_final_vsh",
        name: "Nether final grade vertex",
        path: "world-1/final.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world-1/final.vsh"),
    },
    ShaderTemplate {
        id: "end_final_vsh",
        name: "End final grade vertex",
        path: "world1/final.vsh",
        language: "GLSL",
        description: "Full-screen pass vertex shader.",
        contents: include_str!("../shaderpack/shaders/world1/final.vsh"),
    },
    ShaderTemplate {
        id: "nether_final_fsh",
        name: "Nether final grade fragment",
        path: "world-1/final.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/final.fsh"),
    },
    ShaderTemplate {
        id: "end_final_fsh",
        name: "End final grade fragment",
        path: "world1/final.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/final.fsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_water_vsh",
        name: "Nether translucents vertex",
        path: "world-1/gbuffers_water.vsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_water.vsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_water_vsh",
        name: "End translucents vertex",
        path: "world1/gbuffers_water.vsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_water.vsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_water_fsh",
        name: "Nether translucents fragment",
        path: "world-1/gbuffers_water.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_water.fsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_water_fsh",
        name: "End translucents fragment",
        path: "world1/gbuffers_water.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_water.fsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_skybasic_vsh",
        name: "Nether sky gradient vertex",
        path: "world-1/gbuffers_skybasic.vsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_skybasic.vsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_skybasic_vsh",
        name: "End sky gradient vertex",
        path: "world1/gbuffers_skybasic.vsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_skybasic.vsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_skybasic_fsh",
        name: "Nether sky gradient fragment",
        path: "world-1/gbuffers_skybasic.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_skybasic.fsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_skybasic_fsh",
        name: "End sky gradient fragment",
        path: "world1/gbuffers_skybasic.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_skybasic.fsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_skytextured_vsh",
        name: "Nether sun and moon vertex",
        path: "world-1/gbuffers_skytextured.vsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_skytextured.vsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_skytextured_vsh",
        name: "End sun and moon vertex",
        path: "world1/gbuffers_skytextured.vsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_skytextured.vsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_skytextured_fsh",
        name: "Nether sun and moon fragment",
        path: "world-1/gbuffers_skytextured.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_skytextured.fsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_skytextured_fsh",
        name: "End sun and moon fragment",
        path: "world1/gbuffers_skytextured.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_skytextured.fsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_clouds_vsh",
        name: "Nether vanilla clouds vertex",
        path: "world-1/gbuffers_clouds.vsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_clouds.vsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_clouds_vsh",
        name: "End vanilla clouds vertex",
        path: "world1/gbuffers_clouds.vsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_clouds.vsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_clouds_fsh",
        name: "Nether vanilla clouds fragment",
        path: "world-1/gbuffers_clouds.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_clouds.fsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_clouds_fsh",
        name: "End vanilla clouds fragment",
        path: "world1/gbuffers_clouds.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_clouds.fsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_weather_vsh",
        name: "Nether rain and snow vertex",
        path: "world-1/gbuffers_weather.vsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_weather.vsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_weather_vsh",
        name: "End rain and snow vertex",
        path: "world1/gbuffers_weather.vsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_weather.vsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_weather_fsh",
        name: "Nether rain and snow fragment",
        path: "world-1/gbuffers_weather.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_weather.fsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_weather_fsh",
        name: "End rain and snow fragment",
        path: "world1/gbuffers_weather.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_weather.fsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_entities_vsh",
        name: "Nether entities vertex",
        path: "world-1/gbuffers_entities.vsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_entities.vsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_entities_vsh",
        name: "End entities vertex",
        path: "world1/gbuffers_entities.vsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_entities.vsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_entities_fsh",
        name: "Nether entities fragment",
        path: "world-1/gbuffers_entities.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_entities.fsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_entities_fsh",
        name: "End entities fragment",
        path: "world1/gbuffers_entities.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_entities.fsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_hand_vsh",
        name: "Nether held items vertex",
        path: "world-1/gbuffers_hand.vsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_hand.vsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_hand_vsh",
        name: "End held items vertex",
        path: "world1/gbuffers_hand.vsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_hand.vsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_hand_fsh",
        name: "Nether held items fragment",
        path: "world-1/gbuffers_hand.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_hand.fsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_hand_fsh",
        name: "End held items fragment",
        path: "world1/gbuffers_hand.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_hand.fsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_textured_vsh",
        name: "Nether particles vertex",
        path: "world-1/gbuffers_textured.vsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_textured.vsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_textured_vsh",
        name: "End particles vertex",
        path: "world1/gbuffers_textured.vsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_textured.vsh"),
    },
    ShaderTemplate {
        id: "nether_gbuffers_textured_fsh",
        name: "Nether particles fragment",
        path: "world-1/gbuffers_textured.fsh",
        language: "GLSL",
        description: "Nether wrapper.",
        contents: include_str!("../shaderpack/shaders/world-1/gbuffers_textured.fsh"),
    },
    ShaderTemplate {
        id: "end_gbuffers_textured_fsh",
        name: "End particles fragment",
        path: "world1/gbuffers_textured.fsh",
        language: "GLSL",
        description: "End wrapper.",
        contents: include_str!("../shaderpack/shaders/world1/gbuffers_textured.fsh"),
    },
];
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
    project_type: Option<ProjectType>,
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
    let project_type = project_type.unwrap_or_default();
    let now = current_timestamp();
    let mut projects = read_projects(&app)?;

    let project = if let Some(existing_id) = id.and_then(|value| option_text(&value)) {
        let clean_id = sanitize_project_id(&existing_id)?;

        if let Some(existing) = projects.iter_mut().find(|project| project.id == clean_id) {
            existing.project_type = project_type;
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
                project_type,
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
            project_type,
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
fn list_shader_files(app: AppHandle, project_id: String) -> Result<Vec<ShaderFile>, String> {
    let mut files = SHADER_TEMPLATES
        .iter()
        .map(|template| shader_file_for_template(&app, &project_id, template))
        .collect::<Result<Vec<_>, _>>()?;

    // Include files the user created beyond the template set.
    let root = shader_root(&app, &project_id)?;
    if root.is_dir() {
        for rel_path in extra_shader_paths(&root) {
            files.push(shader_file_for_extra_path(&root, &rel_path)?);
        }
    }

    Ok(files)
}

#[tauri::command]
fn load_shader_file(
    app: AppHandle,
    project_id: String,
    file_id: String,
) -> Result<ShaderFile, String> {
    let template = shader_template(&file_id)?;
    shader_file_for_template(&app, &project_id, template)
}

#[tauri::command]
fn save_shader_file(
    app: AppHandle,
    project_id: String,
    file_id: String,
    file_path: Option<String>,
    contents: String,
) -> Result<ShaderFile, String> {
    if contents.len() > MAX_SHADER_FILE_BYTES {
        return Err("Shader file is too large. Maximum size is 256 KiB.".to_string());
    }

    // Templates save to their fixed path (unless the UI moved them); anything
    // else saves to its sanitized relative path.
    let template = shader_template(&file_id).ok();
    let rel_path = match (&template, &file_path) {
        (Some(template), None) => template.path.to_string(),
        (Some(template), Some(path)) if path == template.path => template.path.to_string(),
        (_, Some(path)) => sanitize_shader_rel_path(path)?,
        (None, None) => return Err("Shader file path is missing.".to_string()),
    };

    let root = shader_root(&app, &project_id)?;
    let path = root.join(&rel_path);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Failed to create shader dir: {err}"))?;
    }

    fs::write(&path, contents).map_err(|err| format!("Failed to save shader file: {err}"))?;

    match template {
        Some(template) if template.path == rel_path => {
            shader_file_for_template(&app, &project_id, template)
        }
        _ => shader_file_for_extra_path(&root, &rel_path),
    }
}

#[tauri::command]
fn delete_shader_file(app: AppHandle, project_id: String, file_path: String) -> Result<(), String> {
    let rel_path = sanitize_shader_rel_path(&file_path)?;
    let root = shader_root(&app, &project_id)?;
    let path = root.join(&rel_path);

    if path.is_file() {
        fs::remove_file(&path).map_err(|err| format!("Failed to delete shader file: {err}"))?;
    }

    // Prune now-empty directories up to the shaders root.
    let mut dir = path.parent().map(Path::to_path_buf);
    while let Some(current) = dir {
        if current == root || fs::remove_dir(&current).is_err() {
            break;
        }
        dir = current.parent().map(Path::to_path_buf);
    }

    Ok(())
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

    let cache_marker = vanilla_texture_cache_marker_path(&app, &clean_version)?;
    if cache_marker.is_file() {
        emit_cache_progress(
            &app,
            0.92,
            "Using cache",
            "Vanilla textures already extracted.",
            1,
            1,
        );
    } else {
        extract_vanilla_textures(&app, &clean_version, &jar_path)?;
        if let Some(parent) = cache_marker.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create texture cache marker dir: {err}"))?;
        }
        fs::write(&cache_marker, b"ok")
            .map_err(|err| format!("Failed to mark texture cache complete: {err}"))?;
    }
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

/// Forwards raw model-output deltas to the webview as `ai-stream` events so
/// the AI panels can show the model working instead of a silent spinner.
#[derive(Clone)]
struct AiStreamEmitter {
    app: AppHandle,
    id: String,
}

impl AiStreamEmitter {
    fn new(app: &AppHandle, id: Option<&str>) -> Option<Self> {
        id.map(|id| Self {
            app: app.clone(),
            id: id.to_string(),
        })
    }

    fn delta(&self, delta: &str) {
        if !delta.is_empty() {
            let _ = self.app.emit(
                "ai-stream",
                serde_json::json!({ "id": self.id, "delta": delta }),
            );
        }
    }
}

fn run_ai_chat(
    config: &AiProviderConfig,
    images: &[TextureAiImageContext],
    prompt: &str,
    emitter: Option<&AiStreamEmitter>,
) -> Result<TextureAiOutput, String> {
    match config.provider.trim().to_lowercase().as_str() {
        "ollama" => run_ollama_chat(config, images, prompt, emitter),
        "openrouter" => run_openrouter_chat(config, images, prompt, emitter),
        "gemini" => run_gemini_chat(config, images, prompt, emitter),
        _ => Err("Unknown AI provider.".to_string()),
    }
}

#[tauri::command]
async fn run_shader_ai(
    app: AppHandle,
    config: AiProviderConfig,
    request: ShaderAiRequest,
) -> Result<TextureAiResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = AiStreamEmitter::new(&app, request.stream_id.as_deref());
        let prompt = build_shader_ai_prompt(&request);
        let (text, prompt_tokens, total_tokens) =
            run_ai_chat(&config, &request.images, &prompt, emitter.as_ref())?;

        Ok(TextureAiResponse {
            text,
            prompt_tokens,
            total_tokens,
        })
    })
    .await
    .map_err(|err| format!("Shader AI worker failed: {err}"))?
}

fn build_shader_ai_prompt(request: &ShaderAiRequest) -> String {
    let history = request
        .history
        .as_deref()
        .filter(|history| !history.trim().is_empty())
        .map(|history| format!("\nCONVERSATION SO FAR (oldest first):\n{history}\n"))
        .unwrap_or_default();

    format!(
        r##"You are Anvil's shader assistant inside a Minecraft shader pack editor.
The pack targets the Iris shader loader on Minecraft {version}. Project: "{name}".

You can read AND change every shader option listed below. The app applies your
edits to the visual builder, regenerates the shader code, and saves it.

Respond with ONLY this JSON shape (no markdown fences, no commentary outside it):
{{"reply": "short friendly message for the user", "edits": [{{"id": "option-id", "value": <new value>}}]}}
If you need to reason step by step first, wrap that reasoning in <thinking></thinking>
tags BEFORE the JSON — never put anything after the JSON object.

Rules for "edits":
- Use option ids EXACTLY as listed below; never invent ids.
- range options: value is a number inside the listed bounds.
- toggle options: value is true or false.
- select options: value is one of the listed choices, as a string.
- color options: value is a "#rrggbb" hex string.
- Leave "edits" empty ([]) when the user only asks a question.
- Change only what the request calls for; mention what you changed in "reply".
- When the user asks about current settings, read them from the list below and
  answer in "reply".

CURRENT SHADER OPTIONS (grouped; format: id | kind | current value | bounds or choices):
{options}

QUICK SETTINGS (legacy visual sliders): {quick}
{history}
USER REQUEST: {prompt}"##,
        version = request.minecraft_version,
        name = request.project_name,
        options = request.options_doc,
        quick = request.quick_settings,
        history = history,
        prompt = request.prompt,
    )
}

#[tauri::command]
async fn run_texture_ai(
    app: AppHandle,
    config: AiProviderConfig,
    request: TextureAiRequest,
) -> Result<TextureAiResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = AiStreamEmitter::new(&app, request.stream_id.as_deref());
        let prompt = build_texture_ai_prompt(&request)?;
        let (text, prompt_tokens, total_tokens) =
            run_ai_chat(&config, &request.images, &prompt, emitter.as_ref())?;

        Ok(TextureAiResponse {
            text,
            prompt_tokens,
            total_tokens,
        })
    })
    .await
    .map_err(|err| format!("Texture AI worker failed: {err}"))?
}

fn build_texture_ai_prompt(request: &TextureAiRequest) -> Result<String, String> {
    let total = request.total_assets.unwrap_or(request.assets.len());
    let asset_examples = request
        .assets
        .iter()
        .take(12)
        .map(|asset| asset.id.clone())
        .collect::<Vec<_>>()
        .join(", ");
    let asset_summary = request
        .asset_summary
        .as_deref()
        .filter(|summary| !summary.trim().is_empty())
        .map(|summary| format!(" ({})", summary.trim()))
        .unwrap_or_default();
    let image_list = request
        .images
        .iter()
        .map(|image| format!("{} ({})", image.name, image.mime_type))
        .collect::<Vec<_>>()
        .join(", ");
    let selected = match (&request.selected_asset_id, &request.selected_asset_name) {
        (Some(id), Some(name)) => format!("{id} ({name})"),
        (Some(id), None) => id.clone(),
        _ => "nothing is open".to_string(),
    };

    let open_pixels_section = match request.open_asset_pixels.as_deref() {
        Some(pixels) if !pixels.trim().is_empty() => {
            format!("Open texture pixels ({selected}):\n{}\n", pixels.trim())
        }
        _ => String::new(),
    };

    let tool_results_section = match request.tool_results.as_deref() {
        Some(data) if !data.trim().is_empty() => {
            format!("Data you requested (use it, do not ask again):\n{}\n", data.trim())
        }
        _ => String::new(),
    };

    Ok(format!(
        r##"You are Anvil's texture-pack assistant. You help edit a Minecraft resource pack's pixel textures, and you can also just chat, brainstorm, and suggest ideas.

Reply with ONE JSON object only — no Markdown, no text outside it. Schema:
{{"reply":"sentence to the user","requests":[{{"type":"pixels","assetId":"block/stone"}}],"edits":[{{"assetId":"block/stone","pixels":[{{"x":0,"y":0,"color":"#7ee787"}}]}}]}}
If you need to reason step by step first, wrap that reasoning in <thinking></thinking> tags BEFORE the JSON — never put anything after the JSON object.

Fields:
- "reply": always include one short, friendly sentence.
- "requests" (optional): ask the app for data BEFORE editing. Types:
    {{"type":"search","query":"apple"}} -> textures whose id or name matches the query.
    {{"type":"blocks"}} -> the full list of available textures.
    {{"type":"pixels","assetId":"<id>"}} -> the exact pixels (x,y -> #RRGGBB) of that texture.
  If you send "requests" with no "edits", the app fulfills them and asks you again with the data.
- "edits" (optional): each entry edits ONE texture by assetId. Include SEVERAL entries to edit MULTIPLE blocks at once.

Rules & abilities:
- You are NOT given the texture list (there are too many). To edit or reference ANY texture other than the one open in the editor, you MUST FIRST find its exact id with a filter:
    {{"type":"search","query":"apple"}}     -> matches id or name (e.g. finds item/apple)
    {{"type":"search","query":"item/a"}}     -> browse by prefix: items starting with "a"
    {{"type":"search","query":"block/red"}}  -> blocks whose id contains "red"
  Never invent an id and never say a texture is missing until a search has returned nothing. {{"type":"blocks"}} returns everything but is large — prefer a narrow filter.
- To recolor precisely, request the target texture's pixels (unless already shown), then return edits.
- Edit only texture pixels (never shader files). Only use assetId values returned by a search/blocks result (or the open texture's id).
- Coordinates are zero-based integers from 0 to {max_xy}. Colors are #RRGGBB. Max 1024 pixels per response.
- "this texture" / "this block" / "the open one" = the texture currently open in the editor (see "Open in editor"). If nothing is open, ask the user which texture they mean.
- Talk and suggest freely. If it isn't an edit request, return an empty "edits" array with a helpful "reply".
- Web search is OFF (disabled in the API request settings) — you cannot browse. If the user asks you to search the web, do NOT say you are forbidden; instead say something like: "Web search is turned off in my settings — how about you describe it to me, or send a picture if my provider supports images?"

Project: {project}
Open in editor: {selected}
Editor grid size: {grid}
Textures: {total} total{asset_summary}. The list is NOT included — use a filter (above) to find ids. Example id format: {asset_examples}.
{open_pixels_section}{tool_results_section}Attached images: {images}
User request: {user_prompt}
"##,
        max_xy = request.grid_size.saturating_sub(1),
        project = request.project_name.trim(),
        selected = selected,
        grid = request.grid_size,
        total = total,
        asset_summary = asset_summary,
        asset_examples = asset_examples,
        open_pixels_section = open_pixels_section,
        tool_results_section = tool_results_section,
        images = if image_list.is_empty() {
            "none"
        } else {
            &image_list
        },
        user_prompt = request.prompt.trim(),
    ))
}

fn ai_base_url(config: &AiProviderConfig, fallback: &str) -> String {
    config
        .base_url
        .as_deref()
        .unwrap_or(fallback)
        .trim()
        .trim_end_matches('/')
        .to_string()
}

fn ai_api_key(config: &AiProviderConfig, provider: &str) -> Result<String, String> {
    let key = config.api_key.as_deref().unwrap_or("").trim();

    if key.is_empty() {
        return Err(format!("{provider} API key is missing."));
    }

    Ok(key.to_string())
}

fn ai_model(config: &AiProviderConfig) -> Result<String, String> {
    let model = config.model.trim();

    if model.is_empty() {
        return Err("AI model is missing.".to_string());
    }

    Ok(model.to_string())
}

fn image_base64(data_url: &str) -> String {
    data_url
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(data_url)
        .to_string()
}

/// Turn a ureq error into a clear, user-facing message. Critically this never
/// echoes the request URL — the Gemini endpoint carries the API key as a query
/// param, and ureq's default error Display would leak it back to the UI.
fn ai_request_error(provider: &str, err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(code, response) => {
            let hint = match code {
                429 => "rate limit or quota exceeded — wait a moment and retry, or check your plan/billing",
                401 | 403 => "the API key was rejected — check that it is correct and active",
                404 => "the model or endpoint was not found — check the model name",
                400 => "the request was rejected as invalid — check the model name and settings",
                500..=599 => "the provider had a server error — try again shortly",
                _ => "the request was rejected",
            };
            let body = response.into_string().unwrap_or_default();
            let detail: String = body.trim().chars().take(280).collect();

            if detail.is_empty() {
                format!("{provider} request failed (HTTP {code}): {hint}.")
            } else {
                format!("{provider} request failed (HTTP {code}): {hint}. Details: {detail}")
            }
        }
        ureq::Error::Transport(transport) => {
            format!(
                "{provider} could not be reached ({}) — check the base URL and your connection.",
                transport.kind()
            )
        }
    }
}

/// Sum of two optional token counts (None unless at least one is present).
fn sum_tokens(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x + y),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

type TextureAiOutput = (String, Option<u64>, Option<u64>);

fn run_ollama_chat(
    config: &AiProviderConfig,
    images: &[TextureAiImageContext],
    prompt: &str,
    emitter: Option<&AiStreamEmitter>,
) -> Result<TextureAiOutput, String> {
    let endpoint = format!("{}/api/chat", ai_base_url(config, "http://localhost:11434"));
    let model = ai_model(config)?;
    let mut user_message = serde_json::json!({
        "role": "user",
        "content": prompt
    });

    if !images.is_empty() {
        let images = images
            .iter()
            .map(|image| image_base64(&image.data_url))
            .collect::<Vec<_>>();
        user_message["images"] = serde_json::json!(images);
    }

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": [
            {
                "role": "system",
                "content": "You are Anvil's in-app assistant. Return only the valid JSON the prompt asks for."
            },
            user_message
        ]
    });
    // Streamed NDJSON: one JSON object per line, the final one carries `done`
    // plus the token counts.
    let response = ureq::post(&endpoint)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|err| ai_request_error("Local model", err))?;

    let reader = BufReader::new(response.into_reader());
    let mut text = String::new();
    let mut prompt_tokens = None;
    let mut completion_tokens = None;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Ollama stream failed: {err}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(message) = value
            .pointer("/error")
            .and_then(|err| err.as_str().map(String::from).or_else(|| err.pointer("/message").and_then(|m| m.as_str()).map(String::from)))
        {
            return Err(format!("Local model error: {message}"));
        }
        if let Some(delta) = value.pointer("/message/content").and_then(|v| v.as_str()) {
            text.push_str(delta);
            if let Some(emitter) = emitter {
                emitter.delta(delta);
            }
        }
        if value.pointer("/done").and_then(|v| v.as_bool()) == Some(true) {
            prompt_tokens = value.pointer("/prompt_eval_count").and_then(|v| v.as_u64());
            completion_tokens = value.pointer("/eval_count").and_then(|v| v.as_u64());
        }
    }

    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Ollama returned an empty response.".to_string());
    }

    Ok((text, prompt_tokens, sum_tokens(prompt_tokens, completion_tokens)))
}

fn run_openrouter_chat(
    config: &AiProviderConfig,
    images: &[TextureAiImageContext],
    prompt: &str,
    emitter: Option<&AiStreamEmitter>,
) -> Result<TextureAiOutput, String> {
    let endpoint = format!(
        "{}/chat/completions",
        ai_base_url(config, "https://openrouter.ai/api/v1")
    );
    let key = ai_api_key(config, "OpenRouter")?;
    let model = ai_model(config)?;
    let mut content = vec![serde_json::json!({ "type": "text", "text": prompt })];

    for image in images {
        content.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": image.data_url }
        }));
    }

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        // Ask for a final usage chunk so the token counter stays exact.
        "stream_options": { "include_usage": true },
        "messages": [
            {
                "role": "system",
                "content": "You are Anvil's in-app assistant. Return only the valid JSON the prompt asks for."
            },
            {
                "role": "user",
                "content": content
            }
        ]
    });
    let response = ureq::post(&endpoint)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .set("HTTP-Referer", "https://anvil.local")
        .set("X-Title", "Anvil")
        .send_json(body)
        .map_err(|err| ai_request_error("OpenRouter", err))?;

    // SSE stream: `data: {...}` lines with `choices[0].delta.content`, a usage
    // chunk near the end, then `data: [DONE]`.
    let reader = BufReader::new(response.into_reader());
    let mut text = String::new();
    let mut prompt_tokens = None;
    let mut total_tokens = None;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("OpenRouter stream failed: {err}"))?;
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };
        if let Some(message) = value.pointer("/error/message").and_then(|m| m.as_str()) {
            return Err(format!("OpenRouter error: {message}"));
        }
        if let Some(delta) = value.pointer("/choices/0/delta/content").and_then(|v| v.as_str()) {
            text.push_str(delta);
            if let Some(emitter) = emitter {
                emitter.delta(delta);
            }
        }
        if let Some(prompt) = value.pointer("/usage/prompt_tokens").and_then(|v| v.as_u64()) {
            prompt_tokens = Some(prompt);
        }
        if let Some(total) = value.pointer("/usage/total_tokens").and_then(|v| v.as_u64()) {
            total_tokens = Some(total);
        }
    }

    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("OpenRouter returned an empty response.".to_string());
    }

    Ok((text, prompt_tokens, total_tokens))
}

fn run_gemini_chat(
    config: &AiProviderConfig,
    images: &[TextureAiImageContext],
    prompt: &str,
    emitter: Option<&AiStreamEmitter>,
) -> Result<TextureAiOutput, String> {
    let key = ai_api_key(config, "AI Studio")?;
    let model = ai_model(config)?;
    // Gemma models served through the Gemini API don't accept JSON response mode
    // (responseMimeType); they'd reject the request. We still ask for JSON in the
    // prompt text, so the output stays parseable.
    let supports_json_mode = !model.trim_start_matches("models/").starts_with("gemma");
    let model_path = if model.starts_with("models/") {
        model
    } else {
        format!("models/{model}")
    };
    let endpoint = format!(
        "{}/v1beta/{model_path}:streamGenerateContent?alt=sse&key={key}",
        ai_base_url(config, "https://generativelanguage.googleapis.com")
    );
    let mut parts = vec![serde_json::json!({ "text": prompt })];

    for image in images {
        parts.push(serde_json::json!({
            "inlineData": {
                "mimeType": image.mime_type,
                "data": image_base64(&image.data_url)
            }
        }));
    }

    let mut body = serde_json::json!({
        "contents": [
            {
                "role": "user",
                "parts": parts
            }
        ]
    });

    if supports_json_mode {
        body["generationConfig"] = serde_json::json!({ "responseMimeType": "application/json" });
    }

    let response = ureq::post(&endpoint)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|err| ai_request_error("AI Studio", err))?;

    // SSE stream: each `data: {...}` chunk is a partial response; usageMetadata
    // arrives on the chunks too (the last one seen is the final count).
    let reader = BufReader::new(response.into_reader());
    let mut text = String::new();
    let mut prompt_tokens = None;
    let mut total_tokens = None;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("AI Studio stream failed: {err}"))?;
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };
        if let Some(message) = value.pointer("/error/message").and_then(|m| m.as_str()) {
            return Err(format!("AI Studio error: {message}"));
        }
        if let Some(parts) = value
            .pointer("/candidates/0/content/parts")
            .and_then(|value| value.as_array())
        {
            for part in parts {
                if let Some(delta) = part.get("text").and_then(|value| value.as_str()) {
                    text.push_str(delta);
                    if let Some(emitter) = emitter {
                        emitter.delta(delta);
                    }
                }
            }
        }
        if let Some(prompt) = value
            .pointer("/usageMetadata/promptTokenCount")
            .and_then(|v| v.as_u64())
        {
            prompt_tokens = Some(prompt);
        }
        if let Some(total) = value
            .pointer("/usageMetadata/totalTokenCount")
            .and_then(|v| v.as_u64())
        {
            total_tokens = Some(total);
        }
    }

    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("AI Studio returned an empty response.".to_string());
    }

    Ok((text, prompt_tokens, total_tokens))
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
async fn export_shader_pack(
    app: AppHandle,
    project_id: String,
    name: String,
    author: String,
    description: String,
    icon_base64: String,
) -> Result<ExportedShaderPack, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let safe_name = sanitize_pack_name(&name)?;
        let default_file_name = format!("{safe_name}-shaderpack.zip");
        let Some(mut zip_path) = app
            .dialog()
            .file()
            .set_title("Export shader pack")
            .set_file_name(default_file_name)
            .add_filter("Minecraft shader pack", &["zip"])
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
        let mut file_count = 0usize;

        for template in SHADER_TEMPLATES {
            let file = shader_file_for_template(&app, &project_id, template)?;
            writer.add_file(
                &format!("shaders/{}", template.path),
                file.contents.as_bytes(),
            )?;
            file_count += 1;
        }

        // Files the user added beyond the template set ship too.
        let root = shader_root(&app, &project_id)?;
        if root.is_dir() {
            for rel_path in extra_shader_paths(&root) {
                let file = shader_file_for_extra_path(&root, &rel_path)?;
                writer.add_file(&format!("shaders/{rel_path}"), file.contents.as_bytes())?;
                file_count += 1;
            }
        }

        let readme =
            format!("# {name}\n\nAuthor: {author}\n\n{description}\n\nGenerated by Anvil.\n");
        writer.add_file("README.md", readme.as_bytes())?;

        if !icon_base64.trim().is_empty() {
            let icon = decode_png_base64(&icon_base64)?;

            if !icon.starts_with(PNG_SIGNATURE) {
                return Err("Pack icon must be a PNG image.".to_string());
            }

            writer.add_file("pack.png", &icon)?;
        }

        writer.finish()?;

        Ok(ExportedShaderPack {
            path: zip_path.to_string_lossy().into_owned(),
            file_count,
        })
    })
    .await
    .map_err(|err| format!("Shader export worker failed: {err}"))?
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_projects,
            get_project,
            save_project,
            list_shader_files,
            load_shader_file,
            save_shader_file,
            delete_shader_file,
            list_assets,
            cache_vanilla_textures,
            load_texture,
            save_texture,
            run_texture_ai,
            run_shader_ai,
            export_pack,
            export_shader_pack,
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

fn shader_root(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let clean_id = sanitize_project_id(project_id)?;
    Ok(app_data_root(app)?
        .join("projects")
        .join(clean_id)
        .join("shaderpack")
        .join("shaders"))
}

fn shader_template(file_id: &str) -> Result<&'static ShaderTemplate, String> {
    SHADER_TEMPLATES
        .iter()
        .find(|template| template.id == file_id)
        .ok_or_else(|| "Shader file is not part of this starter pack.".to_string())
}

fn shader_file_path(
    app: &AppHandle,
    project_id: &str,
    template: &ShaderTemplate,
) -> Result<PathBuf, String> {
    Ok(shader_root(app, project_id)?.join(template.path))
}

fn shader_file_for_template(
    app: &AppHandle,
    project_id: &str,
    template: &ShaderTemplate,
) -> Result<ShaderFile, String> {
    let path = shader_file_path(app, project_id, template)?;
    let saved = path.is_file();
    let contents = if saved {
        fs::read_to_string(&path).map_err(|err| format!("Failed to read shader file: {err}"))?
    } else {
        template.contents.to_string()
    };

    Ok(ShaderFile {
        id: template.id.to_string(),
        name: template.name.to_string(),
        path: template.path.to_string(),
        language: template.language.to_string(),
        description: template.description.to_string(),
        contents,
        saved,
    })
}

// User-created shader files are addressed by their (sanitized) relative path.
fn sanitize_shader_rel_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().trim_start_matches('/');

    if trimmed.is_empty() || trimmed.len() > 200 {
        return Err("Shader file path is invalid.".to_string());
    }

    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err("Shader file path is invalid.".to_string());
        }
        if !part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        {
            return Err("Shader file path contains unsupported characters.".to_string());
        }
        parts.push(part);
    }

    Ok(parts.join("/"))
}

fn shader_language_for_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".properties") || lower.ends_with(".lang") {
        "Properties"
    } else if lower.ends_with(".vsh") || lower.ends_with(".fsh") || lower.ends_with(".glsl") {
        "GLSL"
    } else {
        "Text"
    }
}

fn shader_file_for_extra_path(root: &Path, rel_path: &str) -> Result<ShaderFile, String> {
    let contents = fs::read_to_string(root.join(rel_path))
        .map_err(|err| format!("Failed to read shader file: {err}"))?;
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path).to_string();

    Ok(ShaderFile {
        id: format!("path:{rel_path}"),
        name,
        path: rel_path.to_string(),
        language: shader_language_for_path(rel_path).to_string(),
        description: "Project shader file.".to_string(),
        contents,
        saved: true,
    })
}

// Relative paths of every file under the project's shaders dir that is NOT a
// known template path (i.e. files the user created themselves).
fn extra_shader_paths(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if !SHADER_TEMPLATES.iter().any(|template| template.path == rel) {
                    out.push(rel);
                }
            }
        }
    }

    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn vanilla_texture_root(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    Ok(app_data_root(app)?
        .join("vanilla")
        .join(version)
        .join("textures"))
}

fn vanilla_texture_cache_marker_path(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    Ok(vanilla_texture_root(app, version)?.join(".anvil-cache-complete"))
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

#[cfg(test)]
mod ai_stream_tests {
    use super::*;
    use std::io::Write as IoWrite;
    use std::net::TcpListener;
    use std::thread;

    /// One-shot HTTP server: accepts a single connection, drains the request
    /// head, writes `body` with streaming-friendly headers, and closes.
    fn serve_once(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 65536];
            let mut head = Vec::new();
            loop {
                let n = std::io::Read::read(&mut stream, &mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                head.extend_from_slice(&buf[..n]);
                if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                    // Drain the JSON request body (Content-Length) before replying.
                    let header_text = String::from_utf8_lossy(&head[..pos]).to_string();
                    let content_length = header_text
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    let mut body_read = head.len() - (pos + 4);
                    while body_read < content_length {
                        let n = std::io::Read::read(&mut stream, &mut buf).unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        body_read += n;
                    }
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        });
        port
    }

    fn config(port: u16) -> AiProviderConfig {
        AiProviderConfig {
            provider: "test".to_string(),
            base_url: Some(format!("http://127.0.0.1:{port}")),
            api_key: Some("test-key".to_string()),
            model: "test-model".to_string(),
        }
    }

    #[test]
    fn ollama_ndjson_stream_assembles_text_and_tokens() {
        let body = concat!(
            "{\"message\":{\"content\":\"Hel\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"lo\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"!\"},\"done\":true,\"prompt_eval_count\":12,\"eval_count\":8}\n",
        );
        let port = serve_once(body);
        let (text, prompt_tokens, total_tokens) =
            run_ollama_chat(&config(port), &[], "hi", None).expect("stream ok");
        assert_eq!(text, "Hello!");
        assert_eq!(prompt_tokens, Some(12));
        assert_eq!(total_tokens, Some(20));
    }

    #[test]
    fn openrouter_sse_stream_assembles_text_and_usage() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"reply\\\":\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"\\\"ok\\\"}\"}}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"total_tokens\":150}}\n\n",
            "data: [DONE]\n\n",
        );
        let port = serve_once(body);
        let (text, prompt_tokens, total_tokens) =
            run_openrouter_chat(&config(port), &[], "hi", None).expect("stream ok");
        assert_eq!(text, "{\"reply\":\"ok\"}");
        assert_eq!(prompt_tokens, Some(100));
        assert_eq!(total_tokens, Some(150));
    }

    #[test]
    fn gemini_sse_stream_assembles_parts_and_usage() {
        let body = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"par\"}]}}]}\n\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"tial\"}]}}],\"usageMetadata\":{\"promptTokenCount\":40,\"totalTokenCount\":90}}\n\n",
        );
        let port = serve_once(body);
        let (text, prompt_tokens, total_tokens) =
            run_gemini_chat(&config(port), &[], "hi", None).expect("stream ok");
        assert_eq!(text, "partial");
        assert_eq!(prompt_tokens, Some(40));
        assert_eq!(total_tokens, Some(90));
    }

    #[test]
    fn openrouter_stream_surfaces_provider_error() {
        let body = "data: {\"error\":{\"message\":\"rate limited\"}}\n\n";
        let port = serve_once(body);
        let err = run_openrouter_chat(&config(port), &[], "hi", None).expect_err("should fail");
        assert!(err.contains("rate limited"), "got: {err}");
    }
}
