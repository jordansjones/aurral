import path from "path";
import fs from "fs/promises";
import axios from "axios";
import { dbOps } from "../config/db-helpers.js";
import { NavidromeClient } from "./navidrome.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";

export class WeeklyFlowPlaylistManager {
  constructor(
    weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER || "/app/downloads",
  ) {
    this.weeklyFlowRoot = path.isAbsolute(weeklyFlowRoot)
      ? weeklyFlowRoot
      : path.resolve(process.cwd(), weeklyFlowRoot);
    this.libraryRoot = path.join(this.weeklyFlowRoot, "aurral-weekly-flow");
    this.navidromeClient = null;
    this.mediaProvider = "navidrome";
    this.jellyfinConfig = null;
    this.plexConfig = null;
    this.updateConfig();
  }

  updateConfig(triggerEnsurePlaylists = true) {
    const settings = dbOps.getSettings();
    const mediaServer = settings.integrations?.mediaServer || {};
    const navidromeConfig = settings.integrations?.navidrome || {};
    const hasMediaServerConfig =
      mediaServer.url ||
      mediaServer.username ||
      mediaServer.password ||
      mediaServer.token ||
      mediaServer.provider;
    const effective = hasMediaServerConfig ? mediaServer : navidromeConfig;
    this.mediaProvider =
      (hasMediaServerConfig ? mediaServer.provider : null) || "navidrome";
    const provider = String(this.mediaProvider || "navidrome").toLowerCase();

    if (provider === "plex") {
      this.navidromeClient = null;
      this.jellyfinConfig = null;
      this.plexConfig = {
        url: this._normalizeUrl(effective.url),
        token: effective.token || "",
      };
    } else if (provider === "jellyfin") {
      this.navidromeClient = null;
      this.plexConfig = null;
      this.jellyfinConfig = {
        url: this._normalizeUrl(effective.url),
        username: effective.username || "",
        password: effective.password || "",
      };
    } else if (effective.url && effective.username && effective.password) {
      this.navidromeClient = new NavidromeClient(
        effective.url,
        effective.username,
        effective.password,
      );
      this.jellyfinConfig = null;
      this.plexConfig = null;
    } else {
      this.navidromeClient = null;
      this.jellyfinConfig = null;
      this.plexConfig = null;
    }

    if (triggerEnsurePlaylists) {
      this.ensureSmartPlaylists().catch((err) =>
        console.warn(
          "[WeeklyFlowPlaylistManager] ensureSmartPlaylists on config:",
          err?.message,
        ),
      );
    }
  }

  _sanitize(str) {
    return String(str || "")
      .replace(/[<>:"/\\|?*]/g, "_")
      .trim();
  }

  _normalizeUrl(value) {
    return value ? String(value).trim().replace(/\/+$/, "") : "";
  }

  _getWeeklyFlowLibraryHostPath() {
    const base = process.env.DOWNLOAD_FOLDER || "/data/downloads/tmp";
    return `${base.replace(/\\/g, "/").replace(/\/+$/, "")}/aurral-weekly-flow`;
  }

  _pathMatchesFlow(pathValue, flowId) {
    if (!pathValue || !flowId) return false;
    const normalized = String(pathValue).replace(/\\/g, "/");
    return (
      normalized.includes(`/${flowId}/`) || normalized.includes(`/${flowId}`)
    );
  }

  async _getJellyfinAuth() {
    const cfg = this.jellyfinConfig;
    if (!cfg?.url || !cfg?.username || !cfg?.password) return null;
    const url = `${cfg.url}/Users/AuthenticateByName`;
    const headers = {
      "Content-Type": "application/json",
      "X-Emby-Authorization":
        'MediaBrowser Client="Aurral", Device="Aurral", DeviceId="aurral", Version="1.0.0"',
    };
    const response = await axios.post(
      url,
      {
        Username: cfg.username,
        Pw: cfg.password,
      },
      { headers, timeout: 20000 },
    );
    const token = response.data?.AccessToken || null;
    const userId = response.data?.User?.Id || null;
    if (!token || !userId) return null;
    return { token, userId };
  }

  _jellyfinHeaders(token) {
    return {
      "Content-Type": "application/json",
      "X-Emby-Token": token,
    };
  }

  async _getJellyfinViews(cfg, auth) {
    const response = await axios.get(`${cfg.url}/Users/${auth.userId}/Views`, {
      headers: this._jellyfinHeaders(auth.token),
      timeout: 20000,
    });
    const items = response.data?.Items || response.data?.items || [];
    return Array.isArray(items) ? items : [];
  }

  async _ensureJellyfinLibrary(cfg, auth, libraryName, pathValue) {
    const headers = this._jellyfinHeaders(auth.token);
    try {
      const existing = await axios.get(`${cfg.url}/Library/VirtualFolders`, {
        headers,
        timeout: 20000,
      });
      const folders = Array.isArray(existing.data) ? existing.data : [];
      const found = folders.find(
        (folder) =>
          String(folder?.Name || "").toLowerCase() ===
          String(libraryName).toLowerCase(),
      );
      if (found) return true;
    } catch {}
    try {
      await axios.post(
        `${cfg.url}/Library/VirtualFolders`,
        {
          Name: libraryName,
          CollectionType: "music",
          Paths: [pathValue],
          RefreshLibrary: true,
        },
        { headers, timeout: 20000 },
      );
      return true;
    } catch (err) {
      console.warn(
        "[WeeklyFlowPlaylistManager] Jellyfin ensure library failed:",
        err?.message,
      );
      return false;
    }
  }

  async _findJellyfinPlaylistId(cfg, auth, name) {
    const headers = this._jellyfinHeaders(auth.token);
    const response = await axios.get(`${cfg.url}/Users/${auth.userId}/Items`, {
      params: {
        IncludeItemTypes: "Playlist",
        SearchTerm: name,
        Recursive: true,
        Limit: 20,
      },
      headers,
      timeout: 20000,
    });
    const items = response.data?.Items || [];
    const match = items.find(
      (item) =>
        String(item?.Name || "").toLowerCase() === String(name).toLowerCase(),
    );
    return match?.Id || null;
  }

  async _deleteJellyfinPlaylist(cfg, auth, playlistId) {
    if (!playlistId) return;
    const headers = this._jellyfinHeaders(auth.token);
    try {
      await axios.delete(`${cfg.url}/Playlists/${playlistId}`, {
        headers,
        timeout: 20000,
      });
    } catch {}
  }

  async _createJellyfinPlaylist(cfg, auth, name, ids) {
    const headers = this._jellyfinHeaders(auth.token);
    await axios.post(`${cfg.url}/Playlists`, null, {
      params: {
        name,
        userId: auth.userId,
        mediaType: "Audio",
        ids: ids.join(","),
      },
      headers,
      timeout: 20000,
    });
  }

  async _ensureJellyfinPlaylists(flows) {
    const cfg = this.jellyfinConfig;
    if (!cfg?.url) return;
    const auth = await this._getJellyfinAuth();
    if (!auth) return;
    const libraryName = "Aurral Weekly Flow";
    const hostPath = this._getWeeklyFlowLibraryHostPath();
    await this._ensureJellyfinLibrary(cfg, auth, libraryName, hostPath);
    const views = await this._getJellyfinViews(cfg, auth);
    const view = views.find(
      (entry) =>
        String(entry?.Name || "").toLowerCase() ===
        String(libraryName).toLowerCase(),
    );
    if (!view?.Id) return;
    const itemsResponse = await axios.get(
      `${cfg.url}/Users/${auth.userId}/Items`,
      {
        params: {
          ParentId: view.Id,
          IncludeItemTypes: "Audio",
          Recursive: true,
          Fields: "Path",
        },
        headers: this._jellyfinHeaders(auth.token),
        timeout: 20000,
      },
    );
    const items = Array.isArray(itemsResponse.data?.Items)
      ? itemsResponse.data.Items
      : [];
    for (const flow of flows) {
      const playlistName = `Aurral ${flow.name}`;
      const flowItems = items.filter((item) =>
        this._pathMatchesFlow(item?.Path, flow.id),
      );
      const ids = flowItems.map((item) => item.Id).filter(Boolean);
      const existingId = await this._findJellyfinPlaylistId(
        cfg,
        auth,
        playlistName,
      );
      if (!flow.enabled || ids.length === 0) {
        await this._deleteJellyfinPlaylist(cfg, auth, existingId);
        continue;
      }
      await this._deleteJellyfinPlaylist(cfg, auth, existingId);
      try {
        await this._createJellyfinPlaylist(cfg, auth, playlistName, ids);
      } catch (err) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Jellyfin playlist "${playlistName}" failed:`,
          err?.message,
        );
      }
    }
  }

  _plexParams(extra = {}) {
    const params = { ...extra };
    if (this.plexConfig?.token) {
      params["X-Plex-Token"] = this.plexConfig.token;
    }
    return params;
  }

  async _plexRequest(method, pathValue, params = {}) {
    if (!this.plexConfig?.url) return null;
    const url = pathValue.startsWith("/")
      ? `${this.plexConfig.url}${pathValue}`
      : `${this.plexConfig.url}/${pathValue}`;
    const response = await axios.request({
      method,
      url,
      params: this._plexParams(params),
      headers: { Accept: "application/xml" },
      timeout: 20000,
    });
    return response.data;
  }

  _parsePlexAttributes(tag) {
    const attrs = {};
    const regex = /(\w+)="([^"]*)"/g;
    let match;
    while ((match = regex.exec(tag))) {
      attrs[match[1]] = match[2];
    }
    return attrs;
  }

  _parsePlexSections(xml) {
    const blocks = xml.match(/<Directory\b[\s\S]*?<\/Directory>/g) || [];
    return blocks.map((block) => {
      const header = block.match(/<Directory\b[^>]*>/)?.[0] || "";
      const attrs = this._parsePlexAttributes(header);
      const locations = [];
      const locRegex = /<Location\b[^>]*path="([^"]*)"/g;
      let locMatch;
      while ((locMatch = locRegex.exec(block))) {
        locations.push(locMatch[1]);
      }
      return {
        key: attrs.key,
        title: attrs.title,
        type: attrs.type,
        locations,
      };
    });
  }

  _parsePlexMachineId(xml) {
    const match = xml.match(/machineIdentifier="([^"]+)"/);
    return match ? match[1] : null;
  }

  async _ensurePlexLibrary() {
    const hostPath = this._getWeeklyFlowLibraryHostPath();
    const name = "Aurral Weekly Flow";
    const raw = await this._plexRequest("get", "/library/sections");
    if (!raw) return null;
    let sections = this._parsePlexSections(raw);
    let section = sections.find(
      (entry) => String(entry.title || "").toLowerCase() === name.toLowerCase(),
    );
    if (!section) {
      section = sections.find((entry) =>
        entry.locations?.some((loc) => loc === hostPath),
      );
    }
    if (!section) {
      try {
        await this._plexRequest("post", "/library/sections", {
          name,
          type: "artist",
          agent: "tv.plex.agents.music",
          scanner: "Plex Music Scanner",
          language: "en",
          location: hostPath,
        });
        const nextRaw = await this._plexRequest("get", "/library/sections");
        sections = nextRaw ? this._parsePlexSections(nextRaw) : sections;
        section = sections.find(
          (entry) =>
            String(entry.title || "").toLowerCase() === name.toLowerCase(),
        );
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] Plex ensure library failed:",
          err?.message,
        );
      }
    }
    return section?.key || null;
  }

  _parsePlexTracks(xml) {
    const blocks = xml.match(/<Track\b[\s\S]*?<\/Track>/g) || [];
    const tracks = [];
    for (const block of blocks) {
      const header = block.match(/<Track\b[^>]*>/)?.[0] || "";
      const attrs = this._parsePlexAttributes(header);
      const partMatch = block.match(/<Part\b[^>]*file="([^"]+)"/);
      if (!attrs.ratingKey || !partMatch) continue;
      tracks.push({ id: attrs.ratingKey, file: partMatch[1] });
    }
    return tracks;
  }

  async _getPlexTracks(sectionId) {
    const xml = await this._plexRequest(
      "get",
      `/library/sections/${sectionId}/all`,
      { type: 10 },
    );
    if (!xml) return [];
    return this._parsePlexTracks(xml);
  }

  async _getPlexPlaylists() {
    const xml = await this._plexRequest("get", "/playlists");
    if (!xml) return [];
    const blocks = xml.match(/<Playlist\b[^>]*>/g) || [];
    return blocks.map((block) => {
      const attrs = this._parsePlexAttributes(block);
      return {
        id: attrs.ratingKey,
        title: attrs.title,
        playlistType: attrs.playlistType,
      };
    });
  }

  async _deletePlexPlaylist(id) {
    if (!id) return;
    try {
      await this._plexRequest("delete", `/playlists/${id}`);
    } catch {}
  }

  async _createPlexPlaylist(machineId, name, trackIds) {
    if (!trackIds.length) return;
    const uri = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${trackIds.join(",")}`;
    await this._plexRequest("post", "/playlists", {
      type: "audio",
      title: name,
      smart: 0,
      uri,
    });
  }

  async _ensurePlexPlaylists(flows) {
    const sectionId = await this._ensurePlexLibrary();
    if (!sectionId) return;
    const machineXml = await this._plexRequest("get", "/");
    const machineId = machineXml ? this._parsePlexMachineId(machineXml) : null;
    if (!machineId) return;
    const tracks = await this._getPlexTracks(sectionId);
    const playlists = await this._getPlexPlaylists();
    for (const flow of flows) {
      const playlistName = `Aurral ${flow.name}`;
      const flowTracks = tracks.filter((track) =>
        this._pathMatchesFlow(track.file, flow.id),
      );
      const ids = flowTracks.map((track) => track.id);
      const existing = playlists.find(
        (pl) =>
          String(pl.title || "").toLowerCase() ===
          String(playlistName).toLowerCase(),
      );
      if (!flow.enabled || ids.length === 0) {
        await this._deletePlexPlaylist(existing?.id);
        continue;
      }
      await this._deletePlexPlaylist(existing?.id);
      try {
        await this._createPlexPlaylist(machineId, playlistName, ids);
      } catch (err) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Plex playlist "${playlistName}" failed:`,
          err?.message,
        );
      }
    }
  }

  async ensureSmartPlaylists() {
    const flows = flowPlaylistConfig.getFlows();
    let libraryId = null;
    let playlists = null;
    if (this.navidromeClient?.isConfigured()) {
      try {
        const hostPath = this._getWeeklyFlowLibraryHostPath();
        const library =
          await this.navidromeClient.ensureWeeklyFlowLibrary(hostPath);
        if (
          library != null &&
          library.id !== undefined &&
          library.id !== null
        ) {
          libraryId = library.id;
        } else if (library != null) {
          console.warn(
            "[WeeklyFlowPlaylistManager] Aurral library has no id; smart playlists will not be scoped by library.",
          );
        }
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] ensureWeeklyFlowLibrary failed:",
          err?.message,
        );
      }
      try {
        const raw = await this.navidromeClient.getPlaylists();
        playlists = Array.isArray(raw) ? raw : raw ? [raw] : [];
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] getPlaylists failed:",
          err?.message,
        );
      }
    }

    try {
      await fs.mkdir(this.libraryRoot, { recursive: true });
      const existingFiles = await fs.readdir(this.libraryRoot).catch(() => []);
      const expectedFiles = new Set();
      for (const flow of flows) {
        const playlistName = `Aurral ${flow.name}`;
        const fileName = `${this._sanitize(playlistName)}.nsp`;
        const nspPath = path.join(this.libraryRoot, fileName);
        expectedFiles.add(fileName);
        if (flow.enabled) {
          const pathCondition = { contains: { filepath: flow.id } };
          const all =
            libraryId != null
              ? [{ is: { library_id: libraryId } }, pathCondition]
              : [pathCondition];
          const payload = {
            all,
            sort: "random",
            limit: 1000,
          };
          await fs.writeFile(nspPath, JSON.stringify(payload), "utf8");
        } else {
          if (playlists?.length) {
            const existing = playlists.find((p) => p.name === playlistName);
            if (existing) {
              try {
                await this.navidromeClient.deletePlaylist(existing.id);
              } catch (err) {
                console.warn(
                  `[WeeklyFlowPlaylistManager] Failed to delete playlist "${playlistName}" from Navidrome:`,
                  err?.message,
                );
              }
            }
          }
          try {
            await fs.unlink(nspPath);
          } catch {}
        }
      }
      const toRemove = existingFiles.filter(
        (file) => file.endsWith(".nsp") && !expectedFiles.has(file),
      );
      for (const file of toRemove) {
        try {
          await fs.unlink(path.join(this.libraryRoot, file));
        } catch {}
      }
    } catch (err) {
      console.warn(
        "[WeeklyFlowPlaylistManager] Failed to write smart playlists:",
        err?.message,
      );
    }
    if (this.mediaProvider === "jellyfin") {
      try {
        await this._ensureJellyfinPlaylists(flows);
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] Jellyfin playlist sync failed:",
          err?.message,
        );
      }
    }
    if (this.mediaProvider === "plex") {
      try {
        await this._ensurePlexPlaylists(flows);
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] Plex playlist sync failed:",
          err?.message,
        );
      }
    }
  }

  async scanLibrary() {
    if (this.navidromeClient?.isConfigured()) {
      return this.navidromeClient.scanLibrary();
    }
    if (this.mediaProvider === "jellyfin" && this.jellyfinConfig?.url) {
      try {
        const auth = await this._getJellyfinAuth();
        if (!auth) return null;
        await axios.post(`${this.jellyfinConfig.url}/Library/Refresh`, null, {
          headers: this._jellyfinHeaders(auth.token),
          timeout: 20000,
        });
        return { success: true };
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] Jellyfin scanLibrary failed:",
          err?.message,
        );
        return null;
      }
    }
    if (this.mediaProvider === "plex" && this.plexConfig?.url) {
      const url = `${this.plexConfig.url}/library/sections/all/refresh`;
      try {
        const params = this.plexConfig.token
          ? { "X-Plex-Token": this.plexConfig.token }
          : {};
        await axios.get(url, { params, timeout: 20000 });
        return { success: true };
      } catch (err) {
        console.warn(
          "[WeeklyFlowPlaylistManager] Plex scanLibrary failed:",
          err?.message,
        );
        return null;
      }
    }
    return null;
  }

  async weeklyReset(playlistTypes = null) {
    const targets =
      playlistTypes && playlistTypes.length
        ? playlistTypes
        : flowPlaylistConfig.getFlows().map((flow) => flow.id);
    const fallbackDir = path.join(this.weeklyFlowRoot, "_fallback");
    try {
      await fs.rm(fallbackDir, { recursive: true, force: true });
    } catch {}

    for (const playlistType of targets) {
      const jobs = downloadTracker.getByPlaylistType(playlistType);
      for (const job of jobs) {
        const stagingDir = path.join(this.weeklyFlowRoot, "_staging", job.id);
        try {
          await fs.rm(stagingDir, { recursive: true, force: true });
        } catch {}
      }
      const playlistDir = path.join(this.libraryRoot, playlistType);
      try {
        await fs.rm(playlistDir, { recursive: true, force: true });
        console.log(
          `[WeeklyFlowPlaylistManager] Deleted files for ${playlistType}`,
        );
      } catch (error) {
        console.warn(
          `[WeeklyFlowPlaylistManager] Failed to delete files for ${playlistType}:`,
          error.message,
        );
      }
      downloadTracker.clearByPlaylistType(playlistType);
    }
  }

  getPlaylistName(playlistType) {
    const flow = flowPlaylistConfig.getFlow(playlistType);
    if (flow) return `Aurral ${flow.name}`;
    return `Aurral ${playlistType}`;
  }
}

export const playlistManager = new WeeklyFlowPlaylistManager();
