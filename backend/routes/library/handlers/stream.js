import axios from "axios";
import { noCache } from "../../../middleware/cache.js";
import { verifyTokenAuth } from "../../../middleware/auth.js";
import { dbOps } from "../../../config/db-helpers.js";

export default function registerStream(router) {
  router.get("/stream/:songId", noCache, async (req, res) => {
    if (!verifyTokenAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { songId } = req.params;
    const settings = dbOps.getSettings();
    const mediaServer = settings.integrations?.mediaServer || {};
    const navidrome = settings.integrations?.navidrome || {};
    const hasMediaServerConfig =
      mediaServer.url ||
      mediaServer.username ||
      mediaServer.password ||
      mediaServer.token ||
      mediaServer.provider;
    const provider =
      (hasMediaServerConfig ? mediaServer.provider : null) || "navidrome";
    if (String(provider).toLowerCase() === "plex") {
      return res
        .status(503)
        .json({ error: "Streaming not configured for Plex" });
    }
    const config = hasMediaServerConfig ? mediaServer : navidrome;
    if (!config?.url || !config?.username || !config?.password) {
      return res.status(503).json({ error: "Music server not configured" });
    }
    try {
      const { NavidromeClient } = await import("../../../services/navidrome.js");
      const client = new NavidromeClient(
        config.url,
        config.username,
        config.password
      );
      const streamUrl = client.getStreamUrl(songId);
      const response = await axios.get(streamUrl, {
        responseType: "stream",
        timeout: 30000,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      const contentType = response.headers["content-type"];
      if (contentType) res.setHeader("Content-Type", contentType);
      const contentLength = response.headers["content-length"];
      if (contentLength) res.setHeader("Content-Length", contentLength);
      response.data.pipe(res);
    } catch (error) {
      const status = error.response?.status || 500;
      if (!res.headersSent) {
        res.status(status).json({
          error: "Stream failed",
          message: error.message,
        });
      }
    }
  });
}
