import { allReleaseTypes } from "./constants";

export const normalizeSettings = (savedSettings) => {
  const lidarr = savedSettings.integrations?.lidarr || {};
  const mediaServer = savedSettings.integrations?.mediaServer || {};
  const navidrome = savedSettings.integrations?.navidrome || {};
  const hasMediaServerConfig =
    mediaServer.url ||
    mediaServer.username ||
    mediaServer.password ||
    mediaServer.token ||
    mediaServer.provider;
  const effectiveMediaServer = {
    provider: mediaServer.provider || "navidrome",
    url: hasMediaServerConfig ? mediaServer.url : navidrome.url,
    username: hasMediaServerConfig ? mediaServer.username : navidrome.username,
    password: hasMediaServerConfig ? mediaServer.password : navidrome.password,
    token: mediaServer.token || "",
  };
  return {
    ...savedSettings,
    releaseTypes: savedSettings.releaseTypes || allReleaseTypes,
    quality: savedSettings.quality || "standard",
    integrations: {
      lidarr: {
        url: "",
        apiKey: "",
        searchOnAdd: false,
        defaultMonitorOption: "none",
        ...lidarr,
        qualityProfileId:
          lidarr.qualityProfileId != null
            ? parseInt(lidarr.qualityProfileId, 10)
            : null,
        metadataProfileId:
          lidarr.metadataProfileId != null
            ? parseInt(lidarr.metadataProfileId, 10)
            : null,
      },
      navidrome: {
        url: "",
        username: "",
        password: "",
        ...(savedSettings.integrations?.navidrome || {}),
      },
      mediaServer: {
        url: "",
        username: "",
        password: "",
        token: "",
        ...(effectiveMediaServer || {}),
      },
      lastfm: {
        username: "",
        ...(savedSettings.integrations?.lastfm || {}),
      },
      slskd: {
        url: "",
        apiKey: "",
        ...(savedSettings.integrations?.slskd || {}),
      },
      musicbrainz: {
        email: "",
        ...(savedSettings.integrations?.musicbrainz || {}),
      },
      general: {
        authUser: "",
        authPassword: "",
        ...(savedSettings.integrations?.general || {}),
      },
      gotify: {
        url: "",
        token: "",
        notifyDiscoveryUpdated: false,
        notifyWeeklyFlowDone: false,
        ...(savedSettings.integrations?.gotify || {}),
      },
    },
  };
};

export const checkForChanges = (newSettings, originalSettings) => {
  if (!originalSettings) return false;
  return JSON.stringify(newSettings) !== JSON.stringify(originalSettings);
};
